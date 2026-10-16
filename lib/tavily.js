/**
 * Tavily HTTP 层：搜索、直搜、测试、额度，四个动作共用同一套请求与错误。
 *
 * 契约依据（Tavily 官方 API，与归档版一致）：
 *   POST /search  { query, topic, search_depth, max_results, include_answer,
 *                   include_raw_content, include_images, include_usage, chunks_per_source? }
 *   GET  /usage   { key: { usage, limit }, account: { current_plan, plan_usage, plan_limit, ... } }
 *
 * 错误一律是带 `code` 的 TavilyError（结构化），绝不静默降级：
 *   TAVILY_CREDENTIAL_MISSING / TAVILY_CREDENTIAL_READ_FAILED / TAVILY_ABORTED / TAVILY_HTTP_ERROR
 *   / TAVILY_BAD_RESPONSE / TAVILY_NETWORK_ERROR
 */

/** 官方端点。`endpoint` 留空时用它；`/usage` 由它派生出基址。 */
export const DEFAULT_ENDPOINT = 'https://api.tavily.com/search'

/** 默认凭证引用名。 */
export const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/** 单条 snippet 与答案摘要的截断上限（防御超长响应撑爆模型上下文）。 */
const SNIPPET_LIMIT = 1200
const ANSWER_LIMIT = 4000
/** 来源标题截断上限。 */
const TITLE_LIMIT = 300

/**
 * 带 code 的结构化错误。
 *
 * 为什么不用官方 `@deepseek-ai/dsh-web` 的 `WebError`：第三方插件包在宿主里解析不到
 * 官方裸包名（它们打进 DSH 的 app.asar），静态 import 会让整个插件加载失败。
 * 官方 `WebError` 的形状就是「Error 子类 + 构造器只带 message，code 由调用方挂」，
 * 所以这里用同形状的自包含实现，消费方（dsh-tool-web）按 `code` 分支的行为一致。
 */
export class SearchError extends Error {
  constructor(message, code, cause) {
    super(message)
    this.name = 'SearchError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/** 造一个带 code 的搜索错误（Tavily 层、兜底层、provider 路径共用）。 */
export function createSearchError(message, code, cause) {
  return new SearchError(message, code, cause)
}

/**
 * 兼容别名：本模块内部（以及早期调用点）一直用 TavilyError 这个名字。
 *
 * 注意必须是**真正的绑定**（`const`），不能写成 `export { SearchError as TavilyError }`：
 * 再导出只影响外部导入者，不会在本模块作用域里建出 `TavilyError` 这个名字，
 * 于是模块内部 `new TavilyError(...)` 会抛 ReferenceError（踩过一次）。
 */
export const TavilyError = SearchError

/** 文本截断；空串归 undefined（不把空字符串当有效值传出去）。 */
export function clampText(value, limit) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Tavily 的 include_answer：只有 general 主题支持生成答案，
 * news / finance 传了会被 API 拒绝，所以按 topic 收口。
 * 用 `=== false` 判断而不是 falsy 判断：显式配置的 false 是「不要摘要」，
 * 不能被兜底逻辑当成「没配」而回落。
 */
export function resolveIncludeAnswer(config, includeAnswer) {
  const requested = includeAnswer === undefined ? config.includeAnswer : includeAnswer
  if (requested === false) return false
  if (config.topic !== 'general') return false
  return requested
}

/**
 * 构造 /search 请求体。字段名严格对应 Tavily API。
 * `chunks_per_source` 只在 advanced 深度下被采纳，其他档位传了也会被忽略，
 * 因此不传（保持请求体与真实生效参数一致，便于排错）。
 */
export function buildSearchBody(query, config, includeAnswer) {
  const body = {
    query,
    topic: config.topic,
    search_depth: config.searchDepth,
    max_results: config.maxResults,
    include_answer: resolveIncludeAnswer(config, includeAnswer),
    // 固定 false：搜索只用来筛选，读全文交给 web_fetch —— 避免一次搜索把几十万字塞进上下文
    include_raw_content: false,
    include_images: false,
    include_usage: config.includeUsage !== false,
  }
  if (config.searchDepth === 'advanced') body.chunks_per_source = config.chunksPerSource
  return body
}

/** 把一条 Tavily result 归一成 seam 的 WebSearchSource；无 url 的丢弃。 */
export function toSource(item) {
  const url = typeof item?.url === 'string' ? item.url.trim() : ''
  if (url.length === 0) return undefined
  const source = { url }
  const title = clampText(item?.title, TITLE_LIMIT)
  if (title !== undefined) source.title = title
  const snippet = clampText(item?.content, SNIPPET_LIMIT)
  if (snippet !== undefined) source.snippet = snippet
  const publishedAt = clampText(item?.published_date, 64)
  if (publishedAt !== undefined) source.publishedAt = publishedAt
  return source
}

/**
 * 来源的「轻量形态」：只要标题与链接，不含网页正文片段。
 * 直搜面板用它——这正是「精度高但不返回具体网页内容」的落点。
 */
export function toLinkOnlySource(item) {
  const url = typeof item?.url === 'string' ? item.url.trim() : ''
  if (url.length === 0) return undefined
  const source = { url }
  const title = clampText(item?.title, TITLE_LIMIT)
  if (title !== undefined) source.title = title
  return source
}

/** 超时 + 调用方取消，合并成一个 signal；定时器 unref 以免拖住进程退出。 */
function requestSignal(signal, timeoutMs) {
  const timeoutSignal =
    typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  timeoutSignal?.unref?.()
  if (signal && timeoutSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal])
  }
  return signal ?? timeoutSignal
}

/** 读响应文本（含取消/超时的错误分层）。 */
async function readText(response) {
  try {
    return await response.text()
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new TavilyError('Tavily 请求被取消或超时。', 'TAVILY_ABORTED', error)
    }
    throw new TavilyError('读取 Tavily 响应体失败。', 'TAVILY_NETWORK_ERROR', error)
  }
}

/** 解析 JSON 响应体，失败即结构化错误。 */
function parseJson(text, limit) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new TavilyError(
      `Tavily 返回了非 JSON 响应体：${clampText(text, limit) ?? '(空)'}`,
      'TAVILY_BAD_RESPONSE',
      error,
    )
  }
}

/** HTTP 非 2xx → 带状态码与响应片段的错误；401/403 归为凭证问题。 */
function httpError(response, text) {
  const code =
    response.status === 401 || response.status === 403
      ? 'TAVILY_CREDENTIAL_MISSING'
      : 'TAVILY_HTTP_ERROR'
  return new TavilyError(
    `Tavily HTTP ${response.status}：${clampText(text, 300) ?? '(空响应体)'}`,
    code,
  )
}

/**
 * 打一次 Tavily /search，返回归一结果 `{ sources, content?, credits?, truncated }`。
 * provider 搜索、临时测试、面板直搜三条路径共用它，避免三处实现漂移。
 *
 * `sourceMapper` 决定来源的形态：默认带 snippet；直搜传 toLinkOnlySource，
 * 于是「不返回网页正文」由映射阶段保证，而不是渲染时再省略。
 */
export async function requestTavily({
  apiKey,
  query,
  config,
  signal,
  fetchImpl,
  includeAnswer,
  sourceMapper = toSource,
}) {
  let response
  try {
    response = await fetchImpl(config.endpoint || DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // Tavily 同时接受 Bearer 与 body 里的 api_key；Bearer 让密钥不进入 body。
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildSearchBody(query, config, includeAnswer)),
      signal: requestSignal(signal, config.timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new TavilyError('Tavily 搜索被取消或超时。', 'TAVILY_ABORTED', error)
    }
    if (error instanceof TavilyError) throw error
    throw new TavilyError(
      `Tavily 网络请求失败：${error instanceof Error ? error.message : String(error)}`,
      'TAVILY_NETWORK_ERROR',
      error,
    )
  }

  const text = await readText(response)
  if (!response.ok) throw httpError(response, text)

  const payload = parseJson(text, 200)
  const rawResults = Array.isArray(payload?.results) ? payload.results : []
  const sources = []
  for (const item of rawResults) {
    const source = sourceMapper(item)
    if (source !== undefined) sources.push(source)
  }

  const result = { sources, truncated: false }
  // 只有确实请求了摘要时才消费 answer：既避免把未请求的内容塞给模型，
  // 也让返回契约与发出的请求参数保持一致。
  if (resolveIncludeAnswer(config, includeAnswer) !== false) {
    const answer = clampText(payload?.answer, ANSWER_LIMIT)
    if (answer !== undefined) result.content = answer
  }
  const credits = payload?.usage?.credits
  if (typeof credits === 'number') result.credits = credits
  return result
}

/**
 * 面板直搜：精度拉满，但只要「答案 + 来源标题链接」，不要网页正文。
 *
 * 与 provider 搜索的区别：
 *   - 摘要档位用 config.directAnswerDetail（默认 advanced）；
 *   - 来源用 toLinkOnlySource 映射 —— 结构性保证没有 snippet，
 *     这是功能要求（不返回具体网页内容），不是渲染时的省略。
 */
export async function requestTavilyAnswer({ apiKey, query, config, signal, fetchImpl }) {
  return requestTavily({
    apiKey,
    query,
    config,
    signal,
    fetchImpl,
    includeAnswer: config.directAnswerDetail ?? 'advanced',
    sourceMapper: toLinkOnlySource,
  })
}

/** 面板「查额度」：GET /usage。 */
export async function fetchUsage({ apiKey, config, fetchImpl, signal }) {
  const base = (config.endpoint || DEFAULT_ENDPOINT).replace(/\/search\/?$/, '')
  const url = `${base}/usage`
  const started = Date.now()

  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: requestSignal(signal, config.timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new TavilyError('查额度请求被取消或超时。', 'TAVILY_ABORTED', error)
    }
    throw new TavilyError(
      `请求 ${url} 失败：${error instanceof Error ? error.message : String(error)}`,
      'TAVILY_NETWORK_ERROR',
      error,
    )
  }

  const text = await readText(response)
  if (!response.ok) throw httpError(response, text)
  const payload = parseJson(text, 160)

  const keyUsage = payload?.key?.usage
  const keyLimit = payload?.key?.limit
  const planUsage = payload?.account?.plan_usage
  const planLimit = payload?.account?.plan_limit
  const num = (value) => (typeof value === 'number' ? value : null)
  return {
    ok: true,
    ms: Date.now() - started,
    keyUsage: num(keyUsage),
    keyLimit: num(keyLimit),
    keyRemaining: num(keyUsage) !== null && num(keyLimit) !== null ? keyLimit - keyUsage : null,
    plan: typeof payload?.account?.current_plan === 'string' ? payload.account.current_plan : null,
    planUsage: num(planUsage),
    planLimit: num(planLimit),
    planRemaining: num(planUsage) !== null && num(planLimit) !== null ? planLimit - planUsage : null,
    paygoUsage: num(payload?.account?.paygo_usage),
    paygoLimit: num(payload?.account?.paygo_limit),
  }
}
