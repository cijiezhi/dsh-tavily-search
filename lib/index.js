/**
 * dsh-tavily-search —— 宿主半边（v3）
 *
 * 职责：
 *   1. 向 `ctx.web`（web 能力 seam）注册一个 id 为 `tavily` 的搜索 provider；
 *   2. 关掉开关时在 provider 内部退回官方 DeepSeek 搜索（不消耗 Tavily 额度）；
 *   3. 给 Web GUI 面板提供数据面（状态读写、直搜、测试、查额度、Key 存取）。
 *
 * 契约依据（全部来自本机 Inspect 实测与官方文档，非猜测）：
 *   - `ctx.web.registerSearchProvider(provider) -> disposer`
 *     WebSearchProvider { readonly id, available(): boolean, search(req, signal?) }
 *     available() 必须是廉价本地检查（禁止网络调用）；多个可用 provider 且未配置 id
 *     时 seam 抛 WEB_PROVIDER_AMBIGUOUS —— 所以 cordis.patch.yml 必须把
 *     `web` 行的 searchProvider 钉成 tavily。
 *   - `ctx.credentials`：resolve / describe / set / unset，每次操作重新解析。
 *   - `ctx.webServer.register({ kind, path, handler }) -> disposer`。
 *
 * 依赖声明规则：函数插件必须【命名导出】name/inject/Config/apply，且不能有 default export
 * —— 混用会让 Loader 丢掉 inject 元数据，触发 "cannot get property x without inject" 的 boot 失败。
 */

import { effectiveConfig, readState, writeState } from './state.js'
import { resolveKey, resolveRef } from './credentials.js'
import { createSearchError, requestTavily, SearchError } from './tavily.js'
import { createDeepSeekFallback } from './deepseek-fallback.js'
import { createRoutes } from './routes.js'

/** 插件名：诊断信息与 service 作用域都用它。 */
export const name = 'dsh-tavily-search'

/**
 * 硬依赖：web 是能力宿主，credentials 解析 API Key。
 * `webServer` 不在这里声明 —— 它不是常驻服务（Electron 走 IPC、裁过的宿主可能没有），
 * 面板数据面用可选注入 `ctx.inject(['webServer'], …)` 挂，缺了也不影响搜索本身。
 */
export const inject = ['web', 'credentials']

/** Config 必须是 Standard Schema（官方校验器按 `~standard.validate` 消费）。 */
export { default as Config } from './config.js'

/** 插件版本（面板展示用）。 */
export const VERSION = '3.0.0'

/**
 * seam 的错误类型。
 *
 * 为什么不 `import { WebError } from '@deepseek-ai/dsh-web'`：第三方插件包解析不到
 * 官方包（它们打进 DSH 的 app.asar），静态 import 会让整个插件加载失败。本机正常
 * 工作的同类插件（dsh-novel-writer）在宿主半边同样不导入任何官方包。
 * 形状与官方一致（Error 子类 + code），消费方按 `code` 分支的行为不变。
 */
export { SearchError as WebError } from './tavily.js'

/** 把任意失败包成带 code 的搜索错误，保留 cause。 */
function webError(message, code, cause) {
  return createSearchError(message, code, cause)
}

/**
 * 把内部错误码 → seam（WebError 词汇）错误码。
 *
 * 为什么不能直接透传：seam 的错误码是开放的，但消费方（dsh-tool-web）按自己的词汇
 * 分支；`TAVILY_*` 是本插件自造的码，直接透出去模型侧看不懂。所以这里做一次显式归一，
 * 只在错误码本来就是 `WEB_*` 词汇时才原样返回。
 */
const WEB_ERROR_CODES = {
  TAVILY_CREDENTIAL_MISSING: 'WEB_PROVIDER_CREDENTIAL_MISSING',
  TAVILY_CREDENTIAL_READ_FAILED: 'WEB_PROVIDER_CREDENTIAL_MISSING',
  TAVILY_CREDENTIAL_WRITE_FAILED: 'WEB_PROVIDER_CREDENTIAL_MISSING',
  TAVILY_ABORTED: 'WEB_ABORTED',
  TAVILY_HTTP_ERROR: 'WEB_PROVIDER_ERROR',
  TAVILY_BAD_RESPONSE: 'WEB_PROVIDER_ERROR',
  TAVILY_NETWORK_ERROR: 'WEB_PROVIDER_ERROR',
  TAVILY_BAD_REQUEST: 'WEB_PROVIDER_ERROR',
}

/** 把内部错误转成 seam 的错误（provider 路径必须抛带 code 的错误）。 */
function toWebError(error) {
  const raw = typeof error?.code === 'string' ? error.code : undefined
  if (raw !== undefined && raw.startsWith('WEB_')) return error
  const code = (raw !== undefined ? WEB_ERROR_CODES[raw] : undefined) ?? 'WEB_PROVIDER_ERROR'
  return webError(error instanceof Error ? error.message : String(error), code, error)
}

/**
 * 兜底搜索：Tavily 关掉后接着用。
 *
 * 两级策略（宿主实测：官方裸包名在插件侧解析不到，动态 import 也会失败）：
 *   1. 先试官方 `@deepseek-ai/dsh-web-search-deepseek` —— 若宿主的模块表能解析它，
 *      就用官方实现（协议永远跟官方同步）；
 *   2. 失败则用自包含实现 `./deepseek-fallback.js`（按官方同款协议直连 DeepSeek），
 *      保证「关掉 Tavily 后仍然能搜」这个功能不会因为模块解析不通而失效。
 */
export function createFallback(ctx, getConfig, getFetch, loadOfficial) {
  const local = createDeepSeekFallback({
    resolveCredential: (ref) => ctx.credentials.resolve(ref),
    getConfig,
    getFetch,
  })

  let officialPromise
  const getOfficial = () => {
    if (officialPromise === undefined) {
      officialPromise = (async () => {
        try {
          const loaded = await loadOfficial()
          const Ctor = loaded?.DeepSeekSearchProvider
          if (typeof Ctor !== 'function') return undefined

          /** 一次搜索要用的全部选项；每次调用重新解析凭证（换 Key 下次搜索即生效）。 */
          const resolveOptions = () => {
            const config = getConfig()
            return {
              resolveApiKey: async () => {
                const resolved = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
                return resolved?.value
              },
              apiKeyEnv: 'DEEPSEEK_API_KEY',
              baseURL: config.fallbackBaseUrl || loaded.DEEPSEEK_DEFAULT_BASE_URL,
              model: config.fallbackModel || loaded.DEEPSEEK_DEFAULT_MODEL,
              apiVersion: '2023-06-01',
              maxTokens: 4096,
              maxUses: 5,
            }
          }

          // 官方 provider 的构造参数在不同版本里变过，两个签名都要照顾：
          //   新版：thunk —— 构造器存下它，在 available()/search() 里调 `this.resolveOptions()`
          //        （这样两次搜索之间设置变了也能拿到最新值）；
          //   旧版：直接就是选项对象 —— 访问 `options.resolveApiKey` 等字段。
          // 于是传一个「函数 + 对象」双身份的值：两种签名都能用。
          // 这是实测踩出来的：按旧签名只传对象，新版会在 `this.resolveOptions()` 处抛
          // 「this.resolveOptions is not a function」，整条兜底失效。
          const optionsForConstructor = Object.assign(() => resolveOptions(), resolveOptions())
          return new Ctor(optionsForConstructor)
        } catch {
          return undefined
        }
      })()
    }
    return officialPromise
  }

  let loggedFallback = false
  return {
    id: 'deepseek-fallback',
    available() {
      return true
    },
    async search(request, signal) {
      const official = await getOfficial()
      if (official !== undefined) return official.search(request, signal)
      if (!loggedFallback) {
        loggedFallback = true
        ctx.logger?.info?.(
          '[dsh-tavily-search] 官方兜底模块不可解析，改用自带的 DeepSeek 兜底实现（协议相同）。',
        )
      }
      return local.search(request, signal)
    },
  }
}

/**
 * 建 provider。
 *
 * 开关为什么放在 search() 内部而不是 available()：`web` 行的 searchProvider 在运行时
 * 构造时只读一次，运行时改不了；而「配置了但 available() 为 false」的 seam 语义是
 * 抛 WEB_PROVIDER_CONFIGURED_UNAVAILABLE（不回落）。所以 available() 恒 true，
 * 真正的路由（Tavily / 官方兜底）在 search() 里做。
 */
function createProvider(ctx, getConfig, loadState, fallback) {
  return {
    id: 'tavily',
    available() {
      // 廉价本地检查：只回答「有没有可能可用」，不发网络请求、不读盘。
      return true
    },
    async search(request, signal) {
      const config = getConfig()
      const state = await loadState()
      const eff = effectiveConfig(config, state)

      // 开关关闭 → 用官方兜底搜索，不消耗 Tavily 额度。
      if (eff.enabled === false) {
        return fallback.search(request, signal)
      }

      const ref = resolveRef(config, state)
      const resolved = await resolveKey(ctx, ref)
      if (resolved.key === undefined) {
        throw webError(
          resolved.failed
            ? `读取凭证 ${ref} 失败，请检查 DSH 凭证库中的该条目。`
            : `缺少 Tavily API Key：可在「Tavily 搜索」面板里填入，或把 Key 存入 DSH 凭证库的 ${ref}（也可用环境变量提供）。`,
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }

      try {
        return await requestTavily({
          apiKey: resolved.key,
          query: request.query,
          config: eff,
          signal,
          fetchImpl: eff.fetch ?? globalThis.fetch,
        })
      } catch (error) {
        throw toWebError(error)
      }
    },
  }
}

/**
 * 插件主体。
 *
 * 注册即副作用：每个注册都通过 ctx.effect / ctx.inject 登记，插件卸载或 HMR 时
 * 自动注销释放（packages/AGENTS.md：注册类贡献必须能证明释放）。
 */
export function apply(ctx, config) {
  const fetchImpl = config.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    // 自包含的配置错误 → 加载即响亮失败（根 AGENTS.md：Misconfiguration fails loud）。
    throw new Error('[dsh-tavily-search] 运行时没有可用的 fetch 实现（Node >= 22 应自带全局 fetch）')
  }


  const getConfig = () => config
  const loadState = () => readState()
  const patchState = (patch) => writeState(patch)

  // ── 搜索 provider（兜底实例只建一次，由 provider 内部路由使用）──
  const fallback = createFallback(
    ctx,
    getConfig,
    () => fetchImpl,
    () => import('@deepseek-ai/dsh-web-search-deepseek'),
  )
  const provider = createProvider(ctx, getConfig, loadState, fallback)
  ctx.effect(() => {
    const dispose = ctx.web.registerSearchProvider(provider)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      dispose()
    }
  }, 'dsh-tavily-search: search provider')

  // ── 面板数据面（可选依赖：宿主没有 webServer 时静默跳过，搜索功能不受影响）──
  const routes = createRoutes({
    ctx,
    getConfig,
    loadState,
    patchState,
    pluginVersion: VERSION,
    fetchImpl,
    // 开关关闭时，面板直搜改走兜底（与 provider 内部路由同一份实现，不消耗 Tavily 额度）
    fallbackSearch: (request) => fallback.search(request),
  })
  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => {
      const disposers = routes.map((route) => wctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-tavily-search: panel routes')
  })

  ctx.logger?.info?.(
    `[dsh-tavily-search] 已注册搜索 provider id=${provider.id}（端点 ${config.endpoint || 'Tavily 官方'}）`,
  )
}
