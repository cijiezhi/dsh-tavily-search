/**
 * 用户级状态（面板改动的那一份）。
 *
 * 为什么需要它：插件的 Config 是加载时定死的；面板要能改开关与精度，
 * 且「改完立即生效、不用重启」，所以面板写的是这个状态文件，运行时每次操作重读。
 *
 * 位置：`$DSH_HOME/dsh-tavily-search/state.json`（与 dsh-novel-writer 的
 * `$DSH_HOME/dsh-novel-writer/` 同口径；DSH_HOME 未设时回退 `~/.dsh`）。
 * 只放非敏感字段——API Key 一律进官方凭证库，这里只有它的引用名。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 状态字段全集；未出现在这里的一律不落盘（防脏写）。 */
const STATE_KEYS = [
  'enabled',
  'searchDepth',
  'includeAnswer',
  'maxResults',
  'directAnswerDetail',
  'apiKeyEnv',
]

/** 默认状态：全部「未设置」，由 Config 兜底。 */
export function emptyState() {
  return {
    enabled: undefined,
    searchDepth: undefined,
    includeAnswer: undefined,
    directAnswerDetail: undefined,
    maxResults: undefined,
    apiKeyEnv: undefined,
  }
}

/** DSH 数据根：优先 DSH_HOME，其次 ~/.dsh。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/** 本插件的数据目录。 */
export function dataDir() {
  return join(dshHome(), 'dsh-tavily-search')
}

/** 状态文件路径。 */
export function stateFilePath() {
  return join(dataDir(), 'state.json')
}

/** 只保留已知字段，并丢掉 undefined（保证「未设置」不被写成 null）。 */
function sanitize(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of STATE_KEYS) {
    const value = raw[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/** 读状态。文件不存在 / 损坏时返回空状态，绝不抛（面板不该因为脏文件打不开）。 */
export async function readState(file = stateFilePath()) {
  try {
    const text = await readFile(file, 'utf8')
    return { ...emptyState(), ...sanitize(JSON.parse(text)) }
  } catch {
    return emptyState()
  }
}

/** 原子写状态：先写临时文件再 rename，避免半截 JSON 被读到。 */
export async function writeState(patch, file = stateFilePath()) {
  const next = { ...(await readState(file)), ...sanitize(patch) }
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  return next
}

/**
 * 生效配置：Config → 状态覆盖。
 *
 * 面板上留空的字段（undefined）不参与覆盖，因此「面板没动过的参数」始终由 Config 决定。
 */
export function effectiveConfig(config, state) {
  const pick = (value, fallback) => (value === undefined || value === null ? fallback : value)
  return {
    ...config,
    enabled: pick(state.enabled, true),
    searchDepth: pick(state.searchDepth, config.searchDepth),
    includeAnswer: pick(state.includeAnswer, config.includeAnswer),
    directAnswerDetail: pick(state.directAnswerDetail, config.directAnswerDetail),
    maxResults: pick(state.maxResults, config.maxResults),
    apiKeyEnv: pick(state.apiKeyEnv, config.apiKeyEnv),
  }
}
