/**
 * 插件 Config schema（宿主半边）。
 *
 * 为什么**不用** `@deepseek-ai/schemastery`：
 * 第三方插件包没有官方包的可解析副本（`@deepseek-ai/*` 打进 DSH 的 app.asar，
 * 由宿主在运行时提供），静态 `import` 一个解析不到的裸包名会让整个插件加载失败。
 * 本机可正常工作的同类插件（dsh-novel-writer）在宿主半边也不导入任何官方包。
 *
 * 那 Config 要不要满足什么形状？要 —— 官方校验器消费的是 **Standard Schema**：
 *   schema['~standard'] = { version: 1, vendor, validate(value) }
 *   validate 同步返回 { value }（已填默认值、已校验）或 { issues: [{ message }] }
 * （依据：本机 app.asar 内 schemastery 的实现与 dsh 的 `parseWithStandardSchema`
 *  消费代码；规范见 https://standardschema.dev）
 * 所以这里手写一个自包含的 schema 构造器，链式 API 与 schemastery 保持同形，
 * 由它编译出带 `~standard` 的校验函数。
 *
 * 配置的两个去处：
 *   1. 本 schema —— 部署级默认值，写在 profile 的 cordis.yml / cordis.patch.yml；
 *   2. 面板改动 —— 落 `$DSH_HOME/dsh-tavily-search/state.json`（用户级覆盖）。
 * 解析顺序：schema 默认 → cordis 配置 → state.json 覆盖。面板改完立即生效，不用重启。
 *
 * 这里没有任何密钥字段：Key 由官方凭证 seam 按 `apiKeyEnv` 这个引用解析，
 * 因此 cordis.yml 与 state.json 里永远不出现明文 Key。
 */

/** 检索深度取值（对应 Tavily search_depth）。 */
export const SEARCH_DEPTHS = ['basic', 'advanced', 'fast', 'ultra-fast']

/** 检索主题取值（对应 Tavily topic；只有 general 支持 answers 摘要）。 */
export const TOPICS = ['general', 'news', 'finance']

/** 摘要档位（对应 Tavily include_answer）。 */
export const INCLUDE_ANSWERS = [false, 'basic', 'advanced']

/* ───────────────────────── 自包含 schema 构造器 ───────────────────────── */

/**
 * 字段规格：链式 API 与 schemastery 同形（`string().default('x')`、`number().min(1).max(20)`）。
 *
 * 实现要点（踩过两次的坑，别再改回去）：
 * 方法的**名字**不能与数据的**键**相同 —— 规格对象上 `min` 既想放约束值（1），
 * 又想放方法（`min(value)`），后者会把前者覆盖掉，于是 `.min(1).max(20)` 的约束
 * 静默失效（症状：越界值不报错、`Config.fields.x.min` 是函数而不是数字）。
 * 所以数据一律存在内部键（`__min` / `__max` / `__default` / `__role`）上，
 * 方法名只属于方法。`resolveFields` 读的也是这些内部键。
 */
function chain(source, patch) {
  const data = {}
  if (source !== null && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'function') data[key] = value
    }
  }
  return applySpec({ ...data, ...patch })
}

/** 给规格对象挂上方法集（每次返回新对象，不改动入参）。 */
function applySpec(data) {
  const spec = { ...data }
  spec.default = (value) => chain(spec, { __default: value })
  spec.min = (value) => chain(spec, { __min: value })
  spec.max = (value) => chain(spec, { __max: value })
  spec.step = () => spec
  spec.role = (value) => chain(spec, { __role: value })
  spec.description = () => spec
  return spec
}

/** 造一个字段规格。 */
function field(kind, options = {}) {
  return applySpec({ kind, ...options })
}

const stringField = () => field('string')
const numberField = () => field('number')
const booleanField = () => field('boolean')
const anyField = () => field('any')
const unionField = (values) => field('union', { values })

/** 校验 + 填默认值；任一项不合法就抛（调用方转成 issues）。 */
function resolveFields(fields, input) {
  const source = input === undefined || input === null ? {} : input
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('config 必须是对象')
  }
  const out = {}
  for (const [key, definition] of Object.entries(fields)) {
    const value = source[key]
    if (value === undefined) {
      if (definition.__default !== undefined) out[key] = definition.__default
      continue
    }
    if (definition.kind === 'union' && !definition.values.includes(value)) {
      throw new Error(
        `"${key}" 取值非法：${String(value)}（可选 ${definition.values.map(String).join(' / ')}）`,
      )
    }
    if (definition.kind === 'string' && typeof value !== 'string') {
      throw new Error(`"${key}" 必须是字符串`)
    }
    if (definition.kind === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`"${key}" 必须是布尔值`)
    }
    if (definition.kind === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`"${key}" 必须是数字`)
      if (definition.__min !== undefined && value < definition.__min) {
        throw new Error(`"${key}" 不能小于 ${definition.__min}`)
      }
      if (definition.__max !== undefined && value > definition.__max) {
        throw new Error(`"${key}" 不能大于 ${definition.__max}`)
      }
    }
    out[key] = value
  }
  return out
}

/**
 * 造一个 object schema：可调用（像 schemastery 那样 `Config({...})` 直接拿结果），
 * 同时带 `~standard` 供官方校验器消费。
 */
function objectSchema(fields) {
  const resolve = (input) => resolveFields(fields, input)
  const schema = (input) => resolve(input)
  schema.fields = fields
  Object.defineProperty(schema, '~standard', {
    get() {
      return {
        version: 1,
        vendor: 'dsh-tavily-search',
        validate(value) {
          try {
            return { value: resolve(value) }
          } catch (error) {
            return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
          }
        },
      }
    },
  })
  return schema
}

/* ───────────────────────── 插件 Config ───────────────────────── */

export default objectSchema({
  /** provider 在 web seam 里的注册 id；`web` 行的 searchProvider 必须与它一致。 */
  providerId: stringField().default('tavily'),

  /** 保存 Tavily API Key 的凭证引用名（POSIX 环境变量名形式）。 */
  apiKeyEnv: stringField().default('TAVILY_API_KEY'),

  /**
   * 单次搜索结果条数。默认拉满 20（Tavily 上限），追求资料覆盖面。
   * seam 会在返回路径上强制它给出的上界；面板直搜复用同一个值。
   */
  maxResults: numberField().min(1).max(20).default(20),

  /**
   * 检索深度。advanced = 最高精度（每次 2 credits）；其余档 1 credit。
   * 只有 advanced 会采纳 chunksPerSource。
   */
  searchDepth: unionField(SEARCH_DEPTHS).default('advanced'),

  /** 检索主题，直接对应 Tavily topic。默认 general（只有它支持生成摘要）。 */
  topic: unionField(TOPICS).default('general'),

  /**
   * 模型通过 web_search 调用时的摘要档位。默认 advanced（最详细）。
   * 注意：news / finance 主题下本插件会自动按 false 发送（API 约束）。
   */
  includeAnswer: unionField(INCLUDE_ANSWERS).default('advanced'),

  /**
   * 面板直搜（「直接搜索」那个功能）的默认档位：精度拉满、只要答案 + 来源标题链接
   * （来源不带网页正文，见 lib/tavily.js 的 toLinkOnlySource）。
   */
  directAnswerDetail: unionField(INCLUDE_ANSWERS).default('advanced'),

  /**
   * 每条来源最多返回几个片段（chunks）。Tavily 上限 3。
   * 仅在 searchDepth='advanced' 时被 Tavily 采纳（其他档位忽略）。
   */
  chunksPerSource: numberField().min(1).max(3).default(3),

  /** 单次请求超时（毫秒）。拉满精度后单次可能较慢，故默认放宽到 30 秒。 */
  timeoutMs: numberField().min(1000).max(120000).default(30000),

  /** 是否让 Tavily 回传本次消耗的 credits（include_usage），测试与直搜据此显示用量。 */
  includeUsage: booleanField().default(true),

  /** 覆盖 Tavily 端点（自建代理 / 本地 mock 用）。留空 = 官方端点。 */
  endpoint: stringField().default(''),

  /**
   * 关掉 Tavily 后兜底搜索的模型名；留空用官方自带搜索包的默认值。
   * 兜底复用官方 `DeepSeekSearchProvider`（动态加载，见 lib/index.js）。
   */
  fallbackModel: stringField().default(''),

  /** 兜底搜索的端点基址；留空用官方默认。 */
  fallbackBaseUrl: stringField().default(''),

  /**
   * 面板数据面是否接受非回环来源。
   * 默认 false：只允许 localhost / 127.0.0.1。这个服务不带 TLS、不带认证，
   * 暴露到局域网等于把「读写 Tavily Key」的口子开给同网段，必须显式开启。
   */
  allowLan: booleanField().default(false),

  /**
   * 注入 fetch 实现，仅用于测试；生产留空即用全局 fetch。
   * 属于「测试钩子」而非可配置项，故不出现在 README 的用户配置说明里。
   */
  fetch: anyField(),
})
