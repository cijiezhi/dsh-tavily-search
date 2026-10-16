/**
 * 凭证读写：把用户要保存的 Tavily Key 交给官方凭证 seam，绝不自建密钥存储。
 *
 * 官方 `ctx.credentials` 契约（本机 Inspect 实测）：
 *   resolve(ref)   → { value, source } | undefined；【每次操作重新解析，绝不跨操作缓存】
 *   describe(ref)  → { configured, source?, writable }（不暴露值）
 *   set(ref, value) → 写入 provider 管理的可写源；空值拒绝（用 unset）
 *   unset(ref)     → 移除
 * 由此：cordis.yml 与 state.json 里永远没有明文 Key；面板换了 Key，下一次操作即生效。
 */

import { DEFAULT_API_KEY_ENV, TavilyError } from './tavily.js'

/** 生效的凭证引用名：状态覆盖 → Config → 官方默认名。 */
export function resolveRef(config, state) {
  const fromState = typeof state?.apiKeyEnv === 'string' ? state.apiKeyEnv.trim() : ''
  if (fromState.length > 0) return fromState
  const fromConfig = typeof config?.apiKeyEnv === 'string' ? config.apiKeyEnv.trim() : ''
  if (fromConfig.length > 0) return fromConfig
  return DEFAULT_API_KEY_ENV
}

/**
 * 解析一次 Key。解析失败与「未配置」是两种不同的结果：
 * 前者是凭证服务故障（failed=true），后者只是还没填，面板要能区分提示。
 */
export async function resolveKey(ctx, ref) {
  try {
    const resolved = await ctx.credentials.resolve(ref)
    const value = typeof resolved?.value === 'string' ? resolved.value : undefined
    return { key: value !== undefined && value.length > 0 ? value : undefined, failed: false, ref }
  } catch {
    return { key: undefined, failed: true, ref }
  }
}

/** 取一次 Key，取不到就抛结构化错误（调用方不必各自拼错误文案）。 */
export async function requireKey(ctx, ref) {
  const resolved = await resolveKey(ctx, ref)
  if (resolved.key !== undefined) return resolved.key
  if (resolved.failed) {
    throw new TavilyError(`读取凭证 ${ref} 失败，请检查 DSH 凭证库中的该条目。`, 'TAVILY_CREDENTIAL_READ_FAILED')
  }
  throw new TavilyError(
    `缺少 Tavily API Key：请在「Tavily 搜索」面板里填入，或把 Key 存入 DSH 凭证库的 ${ref}（也可用环境变量提供）。`,
    'TAVILY_CREDENTIAL_MISSING',
  )
}

/** 面板展示用：是否已配置、来源、是否可写（不返回值本身）。 */
export async function describeKey(ctx, ref) {
  try {
    const info = await ctx.credentials.describe(ref)
    return {
      ref,
      configured: info?.configured === true,
      source: typeof info?.source === 'string' ? info.source : null,
      writable: info?.writable === true,
    }
  } catch {
    return { ref, configured: false, source: null, writable: false }
  }
}

/** 保存 Key；拒绝空值（与官方 set 的契约一致，避免「以为存上了其实没存」）。 */
export async function saveKey(ctx, ref, value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed.length === 0) {
    throw new TavilyError('Key 为空：请粘贴新的 Tavily API Key 后再保存。', 'TAVILY_BAD_REQUEST')
  }
  try {
    await ctx.credentials.set(ref, trimmed)
  } catch (error) {
    throw new TavilyError(
      `保存 Key 失败：${error instanceof Error ? error.message : String(error)}`,
      'TAVILY_CREDENTIAL_WRITE_FAILED',
      error,
    )
  }
}

/** 清除 Key（面板「清除」按钮用）。 */
export async function clearKey(ctx, ref) {
  try {
    await ctx.credentials.unset(ref)
  } catch (error) {
    throw new TavilyError(
      `清除 Key 失败：${error instanceof Error ? error.message : String(error)}`,
      'TAVILY_CREDENTIAL_WRITE_FAILED',
      error,
    )
  }
}
