/**
 * 兜底搜索：Tavily 关掉后接着用的搜索，直连 DeepSeek 的 Anthropic 兼容接口。
 *
 * 为什么自己实现而不是复用官方 `@deepseek-ai/dsh-web-search-deepseek`：
 * 第三方插件包在宿主里**解析不到官方裸包名**（它们打进 DSH 的 app.asar，由宿主在
 * 运行时提供）。实测宿主侧静态 import 与动态 import 都失败，而兜底又是「关掉 Tavily
 * 后还能搜」的必需品，所以这里按官方**同款协议**自实现一份 —— 协议细节全部取自
 * 官方包源码（本机 npm 上的 @deepseek-ai/dsh-web-search-deepseek 构建产物）：
 *
 *   POST {baseURL}/messages
 *   headers: x-api-key / authorization: Bearer / anthropic-version / content-type
 *   body:    { model, max_tokens, messages:[{role:user,content:[{type:text,text:"Perform a web search for the query: <q>"}]}],
 *              tools:[{ type:'web_search_20250305', name:'web_search', max_uses }] }
 *   结果:    content[] 里 type==='web_search_tool_result' 的条目 → item.type==='web_search_result'
 *            的 url/title/page_age；摘要片段来自 text 块的 citations[].cited_text（按 url 取首个）
 *
 * 与官方实现的差异（明确记录，避免被当成 bug）：
 *   - 不往 session 里写 `web/deepseek-search-llm-request` 事件（那是官方包内部行为）；
 *   - 不读 `DEEPSEEK_SEARCH_BASE_URL` 环境变量，端点只由 Config 决定（行为更可预测）。
 */

import { clampText, createSearchError } from './tavily.js'

/** DeepSeek 的 Anthropic 兼容基址（注意不是 chat-completions 那个域名）。 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/** 与官方包对齐的默认模型名。 */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'

const DEFAULT_API_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_MAX_USES = 5

/** 本兜底使用的凭证引用名（与官方包一致）。 */
export const FALLBACK_API_KEY_ENV = 'DEEPSEEK_API_KEY'

const SNIPPET_LIMIT = 1200
const TITLE_LIMIT = 300

/** 从 text 块的 citations 里建立 url → 摘录 的映射（首次出现优先）。 */
function citationSnippets(blocks) {
  const map = new Map()
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    for (const cite of block.citations ?? []) {
      if (typeof cite?.url !== 'string' || cite.url.length === 0) continue
      if (typeof cite.cited_text !== 'string' || cite.cited_text.length === 0) continue
      if (!map.has(cite.url)) map.set(cite.url, cite.cited_text)
    }
  }
  return map
}

/**
 * 把 Messages 响应映射成 seam 的搜索结果。
 * 没有 `web_search_tool_result` 块时抛错（与官方一致：宁可报错也不猜）。
 */
export function mapAnthropicResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : []
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw createSearchError(
      'DeepSeek 没有返回 web_search_tool_result 块（本次请求可能没有触发原生联网搜索）。',
      'WEB_PROVIDER_ERROR',
    )
  }
  const snippets = citationSnippets(blocks)
  const seen = new Set()
  const sources = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item?.type !== 'web_search_result') continue
      const url = typeof item.url === 'string' ? item.url.trim() : ''
      if (url.length === 0 || seen.has(url)) continue
      seen.add(url)
      const source = { url }
      const title = clampText(item.title, TITLE_LIMIT)
      if (title !== undefined) source.title = title
      const snippet = clampText(snippets.get(url), SNIPPET_LIMIT)
      if (snippet !== undefined) source.snippet = snippet
      const publishedAt = clampText(item.page_age, 64)
      if (publishedAt !== undefined) source.publishedAt = publishedAt
      sources.push(source)
    }
  }
  // seam 负责按 maxResults 截断，这里不截（truncated 恒 false）
  return { sources, truncated: false }
}

/** 超时与调用方取消合并成一个 signal。 */
function requestSignal(signal, timeoutMs) {
  const timeoutSignal =
    typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  timeoutSignal?.unref?.()
  if (signal && timeoutSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal])
  }
  return signal ?? timeoutSignal
}

/**
 * 造一个兜底 provider（形状与 `WebSearchProvider` 一致：id / available / search）。
 *
 * @param {object} deps
 * @param {(ref: string) => Promise<{ value?: string } | undefined>} deps.resolveCredential
 * @param {() => object} deps.getConfig 每次调用读最新 Config（端点/模型改了不用重启）
 * @param {() => Function} deps.getFetch 取 fetch 实现（测试可注入）
 */
export function createDeepSeekFallback({ resolveCredential, getConfig, getFetch }) {
  return {
    id: 'deepseek-fallback',

    available() {
      // 廉价本地检查：只回答「有没有可能可用」，不解析凭证（那是异步的）
      return true
    },

    async search(request, signal) {
      const config = getConfig()
      const fetchImpl = getFetch()
      const resolved = await resolveCredential(FALLBACK_API_KEY_ENV)
      const apiKey = typeof resolved?.value === 'string' ? resolved.value : ''
      if (apiKey.length === 0) {
        throw createSearchError(
          `兜底搜索缺少 DeepSeek API Key：请把 Key 存入 DSH 凭证库的 ${FALLBACK_API_KEY_ENV}（或在环境里提供）。`,
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }

      const baseURL = config.fallbackBaseUrl || DEEPSEEK_DEFAULT_BASE_URL
      const endpoint = `${baseURL.replace(/\/$/, '')}/messages`
      const body = {
        model: config.fallbackModel || DEEPSEEK_DEFAULT_MODEL,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
          },
        ],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: DEFAULT_MAX_USES }],
      }

      let response
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'x-api-key': apiKey,
            authorization: `Bearer ${apiKey}`,
            'anthropic-version': DEFAULT_API_VERSION,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: requestSignal(signal, config.timeoutMs),
        })
      } catch (error) {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          throw createSearchError('兜底搜索被取消或超时。', 'WEB_ABORTED', error)
        }
        throw createSearchError(
          `兜底搜索请求失败：${error instanceof Error ? error.message : String(error)}`,
          'WEB_PROVIDER_ERROR',
          error,
        )
      }

      let text
      try {
        text = await response.text()
      } catch (error) {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          throw createSearchError('兜底搜索被取消或超时。', 'WEB_ABORTED', error)
        }
        throw createSearchError('读取兜底搜索响应体失败。', 'WEB_PROVIDER_ERROR', error)
      }

      if (!response.ok) {
        // 与官方一致：把响应体里的 error 细节透出来，便于定位（配额/鉴权/模型名）
        let detail = clampText(text, 240)
        try {
          const parsed = JSON.parse(text)
          const message =
            typeof parsed?.error === 'string' ? parsed.error : (parsed?.error?.message ?? parsed?.message)
          if (typeof message === 'string' && message.length > 0) detail = message
        } catch {
          /* 非 JSON 就用原文片段 */
        }
        const code =
          response.status === 401 || response.status === 403
            ? 'WEB_PROVIDER_CREDENTIAL_MISSING'
            : 'WEB_PROVIDER_ERROR'
        throw createSearchError(
          `兜底搜索 HTTP ${response.status}：${detail ?? '(空响应体)'}`,
          code,
        )
      }

      let payload
      try {
        payload = JSON.parse(text)
      } catch (error) {
        throw createSearchError(
          `兜底搜索返回了非 JSON 响应体：${clampText(text, 200) ?? '(空)'}`,
          'WEB_PROVIDER_ERROR',
          error,
        )
      }

      return mapAnthropicResponse(payload)
    },
  }
}
