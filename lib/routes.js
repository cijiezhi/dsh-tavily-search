/**
 * 面板 ↔ 宿主的 HTTP 数据面。
 *
 * 用官方 `ctx.webServer`（本机 Inspect 实测签名）：
 *   register({ kind: 'exact'|'prefix', path, handler }) → disposer
 * 具名路由按 (kind, path) 唯一，重复注册会抛；disposer 必须挂到 ctx.effect 上。
 *
 * 为什么不用设置命名空间当邮箱（归档 v2 的做法）：本机当前的 `ctx.settings`
 * 已改为「把插件 Config 投影成表单」的语义（configure/describe/update/replace/mutate），
 * 旧的 `ctx.settings.register(namespace, schema)` 与 `settingsScope` 都不存在了。
 * 面板需要的是「读写用户级状态 + 触发动作」，所以走 webServer 路由 + 状态文件。
 *
 * 安全：默认只接受回环来源（loopback-only）。非回环请求一律 403 —— 这个服务不带
 * TLS、不带认证，暴露到局域网等于把 Tavily Key 的读写口子开给同网段。
 * 需要局域网访问时必须显式把 config.allowLan 设为 true。
 */

import { describeKey, requireKey, resolveKey, resolveRef, saveKey, clearKey } from './credentials.js'
import { effectiveConfig, readState, writeState } from './state.js'
import { fetchUsage, requestTavilyAnswer, requestTavily } from './tavily.js'

/** 路由前缀：单段业务名（官方 CHANNEL_PATTERN 只允许单段 /api/<name>）。 */
export const ROUTE_PREFIX = '/api/dsh-tavily'

const SEARCH_DEPTHS = ['basic', 'advanced', 'fast', 'ultra-fast']
const INCLUDE_ANSWERS = [false, 'basic', 'advanced']

/** 请求体大小上限（防被塞爆内存）。 */
const BODY_LIMIT = 64 * 1024

/** 本机地址。 */
function isLoopbackHost(host) {
  const name = String(host ?? '').toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]'
}

/**
 * 是否放行这次请求。
 * - 非回环来源：只有 allowLan=true 才放行；
 * - 带 Origin 头的请求（浏览器跨站发起）：Origin host 必须是回环，防 DNS rebinding / CSRF。
 */
export function isAllowedRequest(req, allowLan) {
  const host = req.headers?.host ?? ''
  if (!allowLan && !isLoopbackHost(String(host).replace(/:\d+$/, ''))) return false
  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      const parsed = new URL(origin)
      if (!isLoopbackHost(parsed.hostname)) return false
    } catch {
      return false
    }
  }
  return true
}

/** 写 JSON 响应。 */
export function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读 JSON 请求体；超限或非法 JSON 都抛可识别错误。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 把客户端提交的状态归一化：只留白名单字段，且逐个校验取值。 */
export function normalizeStatePatch(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (typeof raw.searchDepth === 'string' && SEARCH_DEPTHS.includes(raw.searchDepth)) {
    out.searchDepth = raw.searchDepth
  }
  if (raw.includeAnswer === false || INCLUDE_ANSWERS.includes(raw.includeAnswer)) {
    out.includeAnswer = raw.includeAnswer
  }
  if (raw.directAnswerDetail === false || INCLUDE_ANSWERS.includes(raw.directAnswerDetail)) {
    out.directAnswerDetail = raw.directAnswerDetail
  }
  if (typeof raw.maxResults === 'number' && Number.isFinite(raw.maxResults)) {
    out.maxResults = Math.min(20, Math.max(1, Math.round(raw.maxResults)))
  }
  if (typeof raw.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.apiKeyEnv.trim())) {
    out.apiKeyEnv = raw.apiKeyEnv.trim()
  }
  return out
}

/** 把错误折成前端能展示的形状（code 保留，便于分支处理）。 */
function errorPayload(error) {
  return {
    ok: false,
    code: typeof error?.code === 'string' ? error.code : 'TAVILY_ERROR',
    error: error instanceof Error ? error.message : String(error),
  }
}

/**
 * 构造全部路由。依赖通过参数注入，便于自测里直接驱动 handler，不必起真服务器。
 *
 * @param {object} deps
 * @param {object} deps.ctx 宿主上下文（credentials / logger）
 * @param {() => object} deps.getConfig 取当前 Config
 * @param {(patch: object) => Promise<object>} deps.patchState 写入状态文件
 * @param {() => Promise<object>} deps.loadState 读状态
 * @param {string} deps.pluginVersion 插件版本（面板展示）
 * @param {(req: object) => Promise<object>} deps.fallbackSearch 兜底搜索（开关关闭时直搜改走它）
 */
export function createRoutes({
  ctx,
  getConfig,
  loadState,
  patchState,
  pluginVersion,
  fetchImpl,
  fallbackSearch,
}) {
  const config = () => getConfig()
  const doFetch = (impl) => impl ?? fetchImpl ?? globalThis.fetch

  /** 面板首屏：状态 + 生效配置。（凭证概况走 /credential，两件事分开） */
  const stateHandler = async (req, res) => {
    const cfg = config()
    if (!isAllowedRequest(req, cfg.allowLan)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
    try {
      const state = await loadState()
      const eff = effectiveConfig(cfg, state)
      const ref = resolveRef(cfg, state)
      if ((req.method ?? 'GET') === 'GET') {
        return writeJson(res, 200, {
          ok: true,
          version: pluginVersion,
          state,
          credentialRef: ref,
          effective: {
            enabled: eff.enabled,
            searchDepth: eff.searchDepth,
            includeAnswer: eff.includeAnswer,
            directAnswerDetail: eff.directAnswerDetail,
            maxResults: eff.maxResults,
            topic: eff.topic,
            chunksPerSource: eff.chunksPerSource,
            timeoutMs: eff.timeoutMs,
            includeUsage: eff.includeUsage,
            providerId: eff.providerId,
          },
        })
      }
      if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      const patch = normalizeStatePatch(body.state ?? body)
      const next = await patchState(patch)
      return writeJson(res, 200, { ok: true, state: next })
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-tavily-search] state 路由失败：${error?.message ?? error}`)
      return writeJson(res, 400, errorPayload(error))
    }
  }

  /** 凭证概况（分开一条路由：describe 是异步的，且要和状态读解耦）。 */
  const credentialHandler = async (req, res) => {
    const cfg = config()
    if (!isAllowedRequest(req, cfg.allowLan)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
    const state = await loadState()
    const ref = resolveRef(cfg, state)
    const method = req.method ?? 'GET'
    try {
      if (method === 'GET') {
        const info = await describeKey(ctx, ref)
        const current = await resolveKey(ctx, ref)
        return writeJson(res, 200, {
          ok: true,
          ...info,
          // 「能不能用」与「配没配」是两件事：前者要 resolve 成功且非空
          usable: current.key !== undefined,
          readFailed: current.failed,
        })
      }
      if (method === 'POST') {
        const body = await readBody(req)
        if (body.action === 'clear') {
          await clearKey(ctx, ref)
          return writeJson(res, 200, { ok: true, cleared: true, ref })
        }
        await saveKey(ctx, ref, body.apiKey)
        return writeJson(res, 200, { ok: true, saved: true, ref })
      }
      return writeJson(res, 405, { error: 'method not allowed' })
    } catch (error) {
      return writeJson(res, 400, errorPayload(error))
    }
  }

  /** 面板直搜：只要答案 + 来源标题链接（不含网页正文）。**遵循 Tavily 开关**。 */
  const searchHandler = async (req, res) => {
    const cfg = config()
    if (!isAllowedRequest(req, cfg.allowLan)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
    if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
    try {
      const body = await readBody(req)
      const query = typeof body.query === 'string' ? body.query.trim() : ''
      if (query.length === 0) return writeJson(res, 400, { ok: false, code: 'TAVILY_BAD_REQUEST', error: '查询内容为空。' })
      if (query.length > 2000) {
        return writeJson(res, 400, { ok: false, code: 'TAVILY_BAD_REQUEST', error: '查询过长（上限 2000 字）。' })
      }

      const state = await loadState()
      const eff = effectiveConfig(cfg, state)

      // 开关关闭 → 直搜改走兜底（DeepSeek），不消耗 Tavily 额度。
      // 否则「关掉 Tavily」就只管模型侧、面板按钮照烧额度，与开关语义不符（实测踩到）。
      if (eff.enabled === false) {
        const started = Date.now()
        const fallback = await fallbackSearch({ query })
        const sources = Array.isArray(fallback?.sources)
          ? fallback.sources.map((source) => ({ url: source.url, title: source.title }))
          : []
        return writeJson(res, 200, {
          ok: true,
          ms: Date.now() - started,
          query,
          answer: fallback?.content ?? null,
          sources,
          credits: null,
          provider: 'deepseek-fallback',
          note: 'Tavily 已关闭，本次走 DeepSeek 兜底（未消耗 Tavily 额度）。',
        })
      }

      const ref = resolveRef(cfg, state)
      const key = await requireKey(ctx, ref)

      const started = Date.now()
      const result = await requestTavilyAnswer({
        apiKey: key,
        query,
        config: eff,
        fetchImpl: doFetch(),
      })
      return writeJson(res, 200, {
        ok: true,
        ms: Date.now() - started,
        query,
        answer: result.content ?? null,
        sources: result.sources,
        credits: typeof result.credits === 'number' ? result.credits : null,
        provider: 'tavily',
      })
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-tavily-search] 直搜失败：${error?.message ?? error}`)
      return writeJson(res, 400, errorPayload(error))
    }
  }

  /** 面板「测试」：真打一次，返回条数/耗时/credits/首条链接。**遵循 Tavily 开关**。 */
  const testHandler = async (req, res) => {
    const cfg = config()
    if (!isAllowedRequest(req, cfg.allowLan)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
    if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
    try {
      const state = await loadState()
      const eff = effectiveConfig(cfg, state)

      // 开关关闭时**不偷打 Tavily**（否则「测试」会绕开关烧额度）。
      // 这里的语义是「测试 Tavily 连通性」，Tavily 既然关着就没有可测的东西。
      if (eff.enabled === false) {
        return writeJson(res, 200, {
          ok: true,
          skipped: true,
          reason: 'Tavily 当前已关闭（开关 enabled=false），未发起请求、未消耗额度。',
        })
      }

      const ref = resolveRef(cfg, state)
      const key = await requireKey(ctx, ref)

      const started = Date.now()
      const result = await requestTavily({
        apiKey: key,
        query: 'dsh tavily plugin self test',
        config: eff,
        fetchImpl: doFetch(),
      })
      return writeJson(res, 200, {
        ok: true,
        ms: Date.now() - started,
        sources: result.sources.length,
        hasAnswer: typeof result.content === 'string' && result.content.length > 0,
        firstUrl: result.sources[0]?.url ?? null,
        credits: typeof result.credits === 'number' ? result.credits : null,
      })
    } catch (error) {
      return writeJson(res, 400, errorPayload(error))
    }
  }

  /** 面板「查额度」：GET /usage。 */
  const quotaHandler = async (req, res) => {
    const cfg = config()
    if (!isAllowedRequest(req, cfg.allowLan)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
    if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
    try {
      const state = await loadState()
      const eff = effectiveConfig(cfg, state)
      const ref = resolveRef(cfg, state)
      const key = await requireKey(ctx, ref)
      const usage = await fetchUsage({ apiKey: key, config: eff, fetchImpl: doFetch() })
      return writeJson(res, 200, { ...usage, ref })
    } catch (error) {
      return writeJson(res, 400, errorPayload(error))
    }
  }

  return [
    { kind: 'exact', path: `${ROUTE_PREFIX}/state`, handler: stateHandler },
    { kind: 'exact', path: `${ROUTE_PREFIX}/credential`, handler: credentialHandler },
    { kind: 'exact', path: `${ROUTE_PREFIX}/search`, handler: searchHandler },
    { kind: 'exact', path: `${ROUTE_PREFIX}/test`, handler: testHandler },
    { kind: 'exact', path: `${ROUTE_PREFIX}/quota`, handler: quotaHandler },
  ]
}
