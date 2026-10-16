# Changelog

本文件记录本插件的对外变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

- 计划：面板增加 `endpoint`（自建代理 / 本地 mock）输入项（当前只能通过 Config 配置）。
- 计划：额度显示适配 `key.limit` 为 `null` 的套餐（当前回落为套餐维度显示）。

## [3.0.0] — 2026-10-16

首次公开发布。相较早期的自用实现（未随包分发），这一版是**重写**：

### 新增

- 把 `web_search` 背后的搜索 provider 换成 Tavily（`ctx.web.registerSearchProvider`）。
- 侧边栏常驻面板：注册官方席位 `sidebar.panellist`（入口）+ `main`（主栏面板），
  两者共用同一 id，宿主自动完成「点图标 → 切主栏」。
- **面板直搜**：不经模型，直接返回 Tavily 答案 + 来源标题链接；**不返回网页正文片段**。
- 连通性测试、额度查询（`GET /usage`）、搜索精度（深度 / 条数 / 摘要）可在面板调整并**立即生效**。
- **兜底搜索**：关闭 Tavily 后自动退回 DeepSeek（自带实现，不依赖官方包解析），
  与官网同款协议（`POST {base}/messages` + `web_search_20250305` 工具）。
- API Key 写进 DSH 官方凭证库，面板与配置文件都读不到明文。

### 修复

- **官方 provider 构造签名兼容**：官方 `DeepSeekSearchProvider` 的构造参数在新版里
  从「选项对象」改成「`resolveOptions` thunk」。原来只按旧签名传对象，会让兜底在
  `this.resolveOptions()` 处抛 `not a function` 而整条失效。现改为「函数 + 对象」双身份值，
  两种签名都可用，并有回归测试守着。
- **开关是总闸**：「测试」与「直接搜索」原先各自直连 Tavily、不看开关，
  关掉 Tavily 后点按钮仍会消耗额度。现在关闭时直搜走兜底、测试返回 `skipped` 且不发请求。
- **面板滚动**：面板根容器缺少 `height`/`overflow`，窗口偏矮或搜索结果较长时看不到下方内容。
  现在根容器自带滚动，答案与来源区各自限高内滚。

### 说明

- 插件**不导入任何 `@deepseek-ai/*` 包**（它们打进 DSH 的 `app.asar`，外部插件解析不到）：
  错误类型、Config 校验（Standard Schema）、兜底搜索都改为自包含实现。
- 面板数据面走官方 `ctx.webServer` 具名路由（默认只接受回环来源，校验 `Origin`），
  不使用官方 RPC —— 共享 `/api` 通道只允许一个 interceptor，已被官方网关占用。
