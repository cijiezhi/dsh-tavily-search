/**
 * dsh-tavily-search —— 浏览器半边（客户端插件，v3）
 *
 * UI 全部走**官方席位**（本机 Inspect 实测的实时 Slot 树）：
 *   - 侧边栏入口：`sidebar.panellist`（list，root）——官方 catalog 原文：
 *     「Global panel icons. Each list id addresses the matching main panel;
 *       the sidebar owns the button and resolves its label from list metadata.」
 *     所以面板 id 与主栏 key 用同一个字符串，宿主自动完成「点图标 → 切主栏」。
 *   - 面板本体：`main`（keyed，root）——key 与上面同一个 id。
 *   - 切回对话：`ctx.layout.selectPanel(null)`（官方签名
 *     `selectPanel(panelId: MainPanelId | null): void`）。
 *
 * 数据面：fetch `/api/dsh-tavily/*`（宿主半边用官方 ctx.webServer 注册）。
 * 不用官方 RPC / remote：共享 `/api` 通道已被官方网关占用，第三方注册会失败
 * （归档 v2 实测：transport failure → 404）；普通具名路由是官方推荐给插件的形态。
 *
 * 本文件遵循 DSH client 插件格式：`window.__ModuleLoader__.load({ id, factory })`，
 * factory 返回 `{ apply, inject }`；只依赖 react / react-dom（Web GUI 基线模块）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-tavily-search',
  factory: (require) => {
    'use strict'

    const React = require('react')
    const h = React.createElement

    /** 席位 id：侧栏入口与主栏面板共用它。 */
    const PANEL_ID = 'dsh-tavily-search'
    /** 侧栏排序：官方 Plugins 是 0、novel-writer 是 25，本插件排在它后面。 */
    const PANEL_ORDER = 30

    /** 数据面路由（宿主半边 lib/routes.js 的 ROUTE_PREFIX）。 */
    const ROUTE_STATE = '/api/dsh-tavily/state'
    const ROUTE_CREDENTIAL = '/api/dsh-tavily/credential'
    const ROUTE_SEARCH = '/api/dsh-tavily/search'
    const ROUTE_TEST = '/api/dsh-tavily/test'
    const ROUTE_QUOTA = '/api/dsh-tavily/quota'

    /** 请求超时：直搜本身可能跑很久（advanced 深度），比测试宽松。 */
    const REQUEST_TIMEOUT_MS = 60_000
    const SEARCH_TIMEOUT_MS = 120_000

    // ───────────────────────── 样式（官方设计 token） ─────────────────────────

    const STYLE_ID = 'dsh-tavily-search/client.css'
    const css = `
/* 面板根：官方 main 席位挂在固定高度的 centerCol（flex column + overflow:hidden）里，
   所以滚动必须由插件自己做 —— 少了 height/overflow 这组属性，窗口一矮或搜索结果一长，
   下面的内容就永远看不到（实测 bug：搜完看不到结果，也没有滚动条）。 */
.tv-root{padding:24px 24px 48px;max-width:720px;margin:0 auto;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;display:flex;flex-direction:column;gap:18px;box-sizing:border-box;height:100%;max-height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable}
.tv-head{display:flex;align-items:center;gap:10px}
.tv-title{font-size:16px;font-weight:700;flex:1;min-width:0}
.tv-badge{font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.tv-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-base,#fff);flex:0 0 auto}
.tv-card-title{font-weight:600;font-size:13px}
.tv-hint{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.65}
.tv-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tv-col{min-width:88px;color:var(--dsw-alias-label-secondary);font-size:12px}
.tv-input,.tv-select,.tv-area{flex:1 1 220px;min-width:160px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit}
.tv-area{min-height:64px;max-height:35vh;resize:vertical}
.tv-btn{padding:5px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:inherit;cursor:pointer;font:inherit;white-space:nowrap}
.tv-btn:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}
.tv-btn[disabled]{opacity:.5;cursor:default}
.tv-btn-primary{border-color:var(--dsw-alias-label-primary)}
.tv-ok{font-size:12px;color:#2e9e5b;word-break:break-word}
.tv-bad{font-size:12px;color:#d9534f;word-break:break-word}
/* 答案与来源各自限高并可内部滚动：20 条来源 + 长答案加起来能顶掉整个视口，
   不限制的话即使根容器可滚，用户也要滚很久才够到底部的按钮。 */
.tv-answer{white-space:pre-wrap;background:var(--dsw-specific-sidebar-nav-item-hover);border-radius:8px;padding:10px 12px;font-size:13px;max-height:40vh;overflow-y:auto;overscroll-behavior:contain;word-break:break-word}
.tv-src{display:flex;flex-direction:column;gap:4px;max-height:34vh;overflow-y:auto;overscroll-behavior:contain;padding-right:4px}
.tv-src a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--dsw-alias-border-l2);font-size:12px;word-break:break-all}
.tv-src a:hover{border-bottom-style:solid}
.tv-kv{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
`
    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-tavily-search'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ───────────────────────── 数据面 ─────────────────────────

    /** 带超时的 JSON 请求；失败返回 { ok:false, code, error } 而不是抛。 */
    async function requestJson(url, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer =
        controller !== undefined
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined
      try {
        const response = await fetch(url, {
          method,
          headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller?.signal,
        })
        const text = await response.text()
        let payload
        try {
          payload = text.length > 0 ? JSON.parse(text) : {}
        } catch {
          return { ok: false, code: 'BAD_RESPONSE', error: `返回了非 JSON（HTTP ${response.status}）` }
        }
        if (!response.ok && payload.ok !== false) {
          return { ok: false, code: `HTTP_${response.status}`, error: payload.error || `HTTP ${response.status}` }
        }
        return payload
      } catch (error) {
        const aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError')
        return {
          ok: false,
          code: aborted ? 'TIMEOUT' : 'NETWORK',
          error: aborted ? `请求超时（${timeoutMs} ms）` : `请求失败：${(error && error.message) || String(error)}`,
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }

    // ───────────────────────── 组件 ─────────────────────────

    const DEPTHS = [
      ['advanced', 'advanced（最高精度，2 credits/次）'],
      ['basic', 'basic（1 credit）'],
      ['fast', 'fast（1 credit）'],
      ['ultra-fast', 'ultra-fast（1 credit）'],
    ]
    const ANSWERS = [
      ['advanced', 'advanced（最详细）'],
      ['basic', 'basic（简短）'],
      [false, '关闭（不生成摘要）'],
    ]

    /** 一个带标签的行。 */
    function Row(props) {
      return h('div', { className: 'tv-row' }, h('span', { className: 'tv-col' }, props.label), props.children)
    }

    /** 可选的 select。 */
    function Choice(props) {
      return h(
        'select',
        {
          className: 'tv-select',
          'data-testid': props.testId,
          value: String(props.value),
          disabled: props.disabled === true,
          onChange: (event) => {
            const raw = event.target.value
            const found = props.options.find(([value]) => String(value) === raw)
            props.onChange(found === undefined ? raw : found[0])
          },
        },
        props.options.map(([value, label]) => h('option', { key: String(value), value: String(value) }, label)),
      )
    }

    /** 卡片外框。 */
    function Card(props) {
      return h(
        'div',
        { className: 'tv-card' },
        h('div', { className: 'tv-card-title' }, props.title),
        props.hint ? h('div', { className: 'tv-hint' }, props.hint) : null,
        props.children,
      )
    }

    /** 「直接搜索」卡片：精度拉满，但只要答案 + 来源标题链接。 */
    function DirectSearch() {
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const [failure, setFailure] = React.useState(null)

      const run = async () => {
        const text = query.trim()
        if (text.length === 0 || busy) return
        setBusy(true)
        setResult(null)
        setFailure(null)
        const payload = await requestJson(ROUTE_SEARCH, {
          method: 'POST',
          body: { query: text },
          timeoutMs: SEARCH_TIMEOUT_MS,
        })
        setBusy(false)
        if (payload.ok === true) setResult(payload)
        else setFailure(payload.error || '搜索失败')
      }

      const sources = result && Array.isArray(result.sources) ? result.sources : []
      return h(
        Card,
        {
          title: '直接搜索（Tavily 回答 + 来源链接）',
          hint: '精度拉满（advanced + 摘要 advanced + chunks 3）。只给答案正文与来源标题链接，不返回网页正文片段——要看全文再由模型按需抓取。',
        },
        h(
          'div',
          { className: 'tv-row' },
          h('textarea', {
            className: 'tv-area',
            'data-testid': 'tv-query',
            placeholder: '想问什么？例如：DeepSeek Harness 的插件槽位机制是什么',
            value: query,
            disabled: busy,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void run()
            },
          }),
        ),
        h(
          'div',
          { className: 'tv-row' },
          h(
            'button',
            {
              className: 'tv-btn tv-btn-primary',
              type: 'button',
              'data-testid': 'tv-search',
              disabled: busy || query.trim().length === 0,
              onClick: () => void run(),
            },
            busy ? '搜索中…' : '搜索',
          ),
          h('span', { className: 'tv-hint' }, 'Ctrl/Cmd + Enter 也可以'),
        ),
        failure !== null ? h('div', { className: 'tv-bad' }, failure) : null,
        result !== null
          ? h(
              'div',
              { className: 'tv-row' },
              h(
                'div',
                { className: 'tv-kv' },
                h('span', null, `耗时 ${result.ms == null ? '?' : result.ms} ms`),
                h('span', null, `${sources.length} 条来源`),
                result.credits == null ? null : h('span', null, `消耗 ${result.credits} credits`),
              ),
            )
          : null,
        result !== null
          ? h(
              'div',
              { className: 'tv-answer' },
              result.answer === null || result.answer === undefined || result.answer === ''
                ? '（本次没有生成答案摘要，只有下面的来源链接）'
                : result.answer,
            )
          : null,
        sources.length > 0
          ? h(
              'div',
              { className: 'tv-src' },
              sources.map((source, index) =>
                h(
                  'a',
                  { key: `${index}-${source.url}`, href: source.url, target: '_blank', rel: 'noreferrer noopener' },
                  `· ${source.title || source.url}`,
                ),
              ),
            )
          : null,
      )
    }

    /** 面板根组件。 */
    function Panel() {
      const [state, setState] = React.useState(null)
      const [credential, setCredential] = React.useState(null)
      const [loadError, setLoadError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [draftKey, setDraftKey] = React.useState('')
      const [quota, setQuota] = React.useState(null)

      /** 首屏：状态 + 凭证概况。 */
      const reload = React.useCallback(async () => {
        const [statePayload, credentialPayload] = await Promise.all([
          requestJson(ROUTE_STATE),
          requestJson(ROUTE_CREDENTIAL),
        ])
        if (statePayload.ok === true) {
          setState(statePayload)
          setLoadError(null)
        } else {
          setLoadError(statePayload.error || '读取插件状态失败')
        }
        if (credentialPayload.ok === true) setCredential(credentialPayload)
      }, [])

      React.useEffect(() => {
        void reload()
      }, [reload])

      /** 改一个状态字段并落盘。 */
      const patchState = async (patch) => {
        setBusy(true)
        setNotice(null)
        const payload = await requestJson(ROUTE_STATE, { method: 'POST', body: { state: patch } })
        setBusy(false)
        if (payload.ok === true) {
          setState((prev) => (prev === null ? prev : { ...prev, state: payload.state }))
          return true
        }
        setNotice({ ok: false, text: payload.error || '保存失败' })
        return false
      }

      const saveKey = async () => {
        const value = draftKey.trim()
        if (value.length === 0) return
        setBusy(true)
        setNotice(null)
        const payload = await requestJson(ROUTE_CREDENTIAL, { method: 'POST', body: { apiKey: value } })
        setBusy(false)
        if (payload.ok === true) {
          setDraftKey('')
          setNotice({ ok: true, text: `Key 已存入凭证库（${payload.ref}），下一次搜索立即生效。` })
          void reload()
        } else {
          setNotice({ ok: false, text: payload.error || '保存失败' })
        }
      }

      const clearKey = async () => {
        setBusy(true)
        setNotice(null)
        const payload = await requestJson(ROUTE_CREDENTIAL, { method: 'POST', body: { action: 'clear' } })
        setBusy(false)
        if (payload.ok === true) {
          setNotice({ ok: true, text: `已清除凭证 ${payload.ref}。` })
          void reload()
        } else {
          setNotice({ ok: false, text: payload.error || '清除失败' })
        }
      }

      const runTest = async () => {
        setBusy(true)
        setNotice(null)
        const payload = await requestJson(ROUTE_TEST, { method: 'POST', body: {} })
        setBusy(false)
        if (payload.ok === true) {
          const credits = payload.credits == null ? '' : `，消耗 ${payload.credits} credits`
          setNotice({
            ok: true,
            text: `测试成功：${payload.sources} 条来源，耗时 ${payload.ms} ms${credits}${payload.firstUrl ? '｜' + payload.firstUrl : ''}`,
          })
        } else {
          setNotice({ ok: false, text: `测试失败：${payload.error || '未知错误'}` })
        }
      }

      const runQuota = async () => {
        setBusy(true)
        setQuota(null)
        const payload = await requestJson(ROUTE_QUOTA, { method: 'POST', body: {} })
        setBusy(false)
        if (payload.ok === true) {
          const parts = []
          if (payload.keyRemaining !== null && payload.keyRemaining !== undefined) {
            parts.push(`本 key 剩余 ${payload.keyRemaining}/${payload.keyLimit} credits`)
          } else if (payload.keyUsage !== null && payload.keyUsage !== undefined) {
            parts.push(`本 key 已用 ${payload.keyUsage} credits`)
          }
          if (payload.plan) parts.push(`套餐 ${payload.plan}`)
          if (payload.planRemaining !== null && payload.planRemaining !== undefined) {
            parts.push(`本月剩余 ${payload.planRemaining}/${payload.planLimit}`)
          }
          setQuota({ ok: true, text: parts.length > 0 ? parts.join('｜') : '已查到额度信息（返回字段为空）' })
        } else {
          setQuota({ ok: false, text: `查额度失败：${payload.error || '未知错误'}` })
        }
      }

      if (loadError !== null && state === null) {
        return h(
          'div',
          { className: 'tv-root' },
          h('div', { className: 'tv-head' }, h('div', { className: 'tv-title' }, 'Tavily 联网搜索')),
          h('div', { className: 'tv-bad' }, `面板数据面不可用：${loadError}`),
          h('div', { className: 'tv-hint' }, '常见原因：宿主半边的 /api/dsh-tavily 路由没注册（webServer 不可用），或面板未加载。'),
        )
      }

      const values = state === null ? null : state.state || {}
      const effective = state === null ? null : state.effective || {}
      const enabled = values === null || values.enabled === undefined ? true : values.enabled !== false
      const credentialUsable = credential !== null && credential.usable === true
      const disabled = busy || values === null

      return h(
        'div',
        { className: 'tv-root' },
        h(
          'div',
          { className: 'tv-head' },
          h('div', { className: 'tv-title' }, 'Tavily 联网搜索'),
          state !== null && state.version ? h('span', { className: 'tv-badge' }, `v${state.version}`) : null,
        ),
        h(
          'div',
          { className: 'tv-hint' },
          '开启时，模型的 web_search 走 Tavily；关闭则自动退回 DSH 自带的 DeepSeek 搜索（不消耗 Tavily 额度）。',
        ),

        h(
          Card,
          { title: '开关' },
          h(
            Row,
            { label: '启用' },
            h('input', {
              type: 'checkbox',
              'data-testid': 'tv-enabled',
              checked: enabled,
              disabled,
              onChange: (event) => void patchState({ enabled: event.target.checked }),
              'aria-label': '启用 Tavily 联网搜索',
            }),
            h('span', { className: 'tv-hint' }, enabled ? '联网搜索走 Tavily' : '已关闭：走 DSH 自带搜索'),
          ),
        ),

        h(
          Card,
          {
            title: 'API Key',
            hint: `Key 存在 DSH 官方凭证库（引用名 ${credential === null ? '…' : credential.ref}），不写进配置文件。面板与插件都读不到明文。`,
          },
          h(
            Row,
            { label: '状态' },
            h(
              'span',
              { className: credentialUsable ? 'tv-ok' : 'tv-bad' },
              credential === null
                ? '读取中…'
                : credential.readFailed
                  ? '凭证服务读取失败'
                  : credentialUsable
                    ? `已配置${credential.source ? `（来源：${credential.source}）` : ''}`
                    : '未配置',
            ),
            credential !== null && credential.writable === false
              ? h('span', { className: 'tv-hint' }, '当前来源只读，无法从面板写入')
              : null,
          ),
          h(
            Row,
            { label: '新 Key' },
            h('input', {
              className: 'tv-input',
              type: 'password',
              'data-testid': 'tv-key',
              placeholder: credentialUsable ? '已配置（留空表示不改动）' : '粘贴 Tavily API Key',
              value: draftKey,
              disabled,
              onChange: (event) => setDraftKey(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void saveKey()
              },
              'aria-label': 'Tavily API Key',
            }),
            h(
              'button',
              {
                className: 'tv-btn',
                type: 'button',
                'data-testid': 'tv-save-key',
                disabled: disabled || draftKey.trim().length === 0,
                onClick: () => void saveKey(),
              },
              '保存',
            ),
            h(
              'button',
              { className: 'tv-btn', type: 'button', 'data-testid': 'tv-clear-key', disabled, onClick: () => void clearKey() },
              '清除',
            ),
          ),
        ),

        h(
          Card,
          { title: '搜索精度', hint: '这些改动立即生效，下一次搜索就用新参数，不需要重启。' },
          h(
            Row,
            { label: '深度' },
            h(Choice, {
              testId: 'tv-depth',
              value: effective === null ? 'advanced' : effective.searchDepth,
              options: DEPTHS,
              disabled,
              onChange: (value) => void patchState({ searchDepth: value }),
            }),
          ),
          h(
            Row,
            { label: '条数' },
            h('input', {
              className: 'tv-input',
              type: 'number',
              'data-testid': 'tv-max-results',
              min: 1,
              max: 20,
              value: effective === null ? 20 : effective.maxResults,
              disabled,
              onChange: (event) => {
                const next = Number(event.target.value)
                if (Number.isFinite(next)) void patchState({ maxResults: next })
              },
              'aria-label': '结果条数上限',
            }),
            h('span', { className: 'tv-hint' }, '1–20（Tavily 上限 20）'),
          ),
          h(
            Row,
            { label: '摘要' },
            h(Choice, {
              testId: 'tv-answer',
              value: effective === null ? 'advanced' : effective.includeAnswer,
              options: ANSWERS,
              disabled,
              onChange: (value) => void patchState({ includeAnswer: value }),
            }),
            h('span', { className: 'tv-hint' }, '模型 web_search 的答案摘要档位'),
          ),
          h(
            Row,
            { label: '直搜摘要' },
            h(Choice, {
              testId: 'tv-direct-answer',
              value: effective === null ? 'advanced' : effective.directAnswerDetail,
              options: ANSWERS,
              disabled,
              onChange: (value) => void patchState({ directAnswerDetail: value }),
            }),
            h('span', { className: 'tv-hint' }, '下面「直接搜索」用的档位'),
          ),
        ),

        h(
          Card,
          { title: '连通性与额度' },
          h(
            'div',
            { className: 'tv-row' },
            h(
              'button',
              { className: 'tv-btn', type: 'button', 'data-testid': 'tv-test', disabled, onClick: () => void runTest() },
              busy ? '测试中…' : '测试',
            ),
            h(
              'button',
              { className: 'tv-btn', type: 'button', 'data-testid': 'tv-quota', disabled, onClick: () => void runQuota() },
              '查额度',
            ),
            h('span', { className: 'tv-hint' }, '测试真打一次 Tavily；查额度调 GET /usage'),
          ),
          quota !== null ? h('div', { className: quota.ok ? 'tv-ok' : 'tv-bad' }, quota.text) : null,
        ),

        h(DirectSearch, null),

        notice !== null ? h('div', { className: notice.ok ? 'tv-ok' : 'tv-bad' }, notice.text) : null,
      )
    }

    /** 侧栏按钮：官方 list 席位只给图标（label 由 list metadata 提供）。 */
    function SidebarIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('path', { d: 'M20 20l-3.5-3.5' }),
      )
    }

    // ───────────────────────── 插件入口 ─────────────────────────

    /** 客户端依赖：slots 注册席位；layout 负责把主栏切到/切离本面板。 */
    const inject = ['slots', 'layout']

    function apply(ctx) {
      installStyles()

      const layout = ctx.layout
      const onClose = () => {
        try {
          layout?.selectPanel?.(null)
        } catch {
          /* 选择失败（面板未注册等）不影响面板自身渲染 */
        }
      }

      // 主栏面板（keyed）：key 与侧栏入口 id 相同，宿主据此联动。
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            inject: () => ({ onClose }),
          },
          Panel,
        ),
      )

      // 侧栏入口（list）：label 是被投影的显示文案。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: () => 'Tavily 搜索',
          },
          SidebarIcon,
        ),
      )
    }

    return { apply, inject, PANEL_ID }
  },
})
