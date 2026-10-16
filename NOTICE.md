# NOTICE

## 这是什么

`dsh-tavily-search` 是一个 **DSH（DeepSeek Harness）插件包**：把 `web_search` 背后的搜索
provider 换成 [Tavily](https://tavily.com)，并在 Web GUI 侧边栏提供一个常驻面板。

它是一个 **bundle 包**：安装后由 profile 的 `dsh.profile.bundles` 加载，
包内 `cordis.patch.yml` 负责插入插件行、停用内置搜索行、把 `web` 行的 `searchProvider`
钉死为 `tavily`。

## 运行期依赖（第三方服务）

| 依赖 | 用途 | 是否必须 |
|---|---|---|
| Tavily API（`https://api.tavily.com`） | 搜索与额度查询 | **必须**（否则请关掉开关走兜底） |
| DeepSeek Anthropic 兼容 API（`https://api.deepseek.com/anthropic/v1`） | 关闭 Tavily 后的兜底搜索 | 可选；不提供 Key 时该路径返回结构化错误 |

两者都需要你自己的 API Key，Key 存在 **DSH 官方凭证库**（默认引用名分别为
`TAVILY_API_KEY` 与 `DEEPSEEK_API_KEY`），不会写进任何配置文件。

## 官方包依赖

**无。** 本包的宿主半边与客户端半边都不导入任何 `@deepseek-ai/*` 包 ——
它们打进 DSH 的 `app.asar`，外部插件按 Node 解析规则找不到。需要官方能力时改走
`ctx` / `ctx.get()`：

- 搜索能力：`ctx.web`
- 凭证读写：`ctx.credentials`
- 面板数据面：`ctx.webServer`（可选依赖）
- 客户端界面：官方 Slot 席位 `sidebar.panellist` / `main`，切面板用 `ctx.layout`

因此本包 **没有任何 npm 运行时依赖**，`node_modules` 是空的。

## 历史版本

本包是第三代实现（v3），前两代的源码没有随包分发，也没有放进仓库。

维护者本地保留了一份开发资料（`dev-notes/`，**已被 `.gitignore` 排除**）：
自测脚本、架构与测试文档、以及 v1·v2 的历史归档（旧源码快照、当时的恢复说明）。
它只在本地维护时参考，**不要用于恢复**。

## 许可

MIT，Copyright (c) 2026 cijiezhi，见 [LICENSE](./LICENSE)。
