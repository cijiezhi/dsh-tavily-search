# dsh-tavily-search

把 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 的 `web_search`
换成 **Tavily**，并在 Web GUI 侧边栏提供一个常驻面板
（开关、API Key、搜索精度、连通性测试、额度查询，以及「答案 + 来源链接」的免模型直搜）。

关掉 Tavily 后，搜索自动退回 **DeepSeek 兜底**，不消耗 Tavily 额度。

- **宿主半边**：向 `ctx.web` 注册 id 为 `tavily` 的搜索 provider；用官方 `ctx.webServer`
  提供面板数据面；Key 走官方凭证库。
- **客户端半边**：注册官方席位 `sidebar.panellist`（侧栏图标）与 `main`（主栏面板），
  两者共用同一个 id，宿主自动完成「点图标 → 切主栏」。
- **零 npm 运行时依赖**：不导入任何 `@deepseek-ai/*` 包，也没有第三方库依赖。

## 特性

| 能力 | 说明 |
|---|---|
| 换搜索 provider | 模型调用 `web_search` 时走 Tavily，结果格式与官方 provider 一致 |
| 关掉即兜底 | 面板关掉开关后搜索自动退回 DeepSeek，**不消耗 Tavily 额度** |
| 面板直搜 | 输入问题 → Tavily 答案 + 来源标题链接；**不返回网页正文片段** |
| 填 Key | 写进 DSH 官方凭证库，面板与配置文件都读不到明文 |
| 查额度 | 调 Tavily `GET /usage`，显示套餐与本月剩余 |
| 连通性测试 | 真打一次 Tavily，显示来源条数、耗时、消耗 credits、首条链接 |
| 精度可调 | 深度 / 条数 / 摘要档位在面板改，**改完立即生效，不用重启** |

## 安装

需要 DSH `>= 0.1.5-rc.1`、Node `>= 22.19`。

**方式一：从目录安装（本地包 / 开发）**

```sh
dsh plugin add /path/to/dsh-tavily-search
```

`dsh plugin` 会把它登记进 profile 的依赖与 `dsh.profile.bundles`，**重启 DSH** 后生效。

**方式二：手动登记**（等价于 pnpm 安装之后的状态）

```jsonc
// $DSH_HOME/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-tavily-search": "link:<本包目录的绝对路径>"
  },
  "dsh": {
    "profile": {
      "bundles": [ "…", "dsh-tavily-search" ]
    }
  }
}
```

再在 `$DSH_HOME/profiles/<profile>/node_modules/` 下建一个指向本包目录的链接
（Linux/macOS 用 `ln -s`，Windows 用 `mklink /J`），然后**重启 DSH**。

**方式三：从 git 安装**

```sh
dsh plugin add github:<owner>/dsh-tavily-search
```

包内不含构建脚本（纯 JavaScript，无需编译），因此不需要 pnpm 的构建授权。

### 装完之后

包内 `cordis.patch.yml` 会自动做三件事：

1. 插入本插件的行；
2. **停用**内置搜索行 `web-search-deepseek`；
3. 把 `web` 行的 `searchProvider` **钉死**为 `tavily`（并重述 `fetchProvider`）。

这是刻意的最小组合：web seam 在「配置了 id 但 provider 不可用」时**报错而不回落**，
在「多个可用 provider 且未配置 id」时抛 `WEB_PROVIDER_AMBIGUOUS`，所以必须钉死一个。
详见 [配置手册](./docs/配置手册.md)。

### 配 Key

打开侧栏「Tavily 搜索」面板 → 「API Key」粘贴 → 保存。
也可以把 Key 写进凭证库的 `TAVILY_API_KEY`，或用环境变量提供。

兜底搜索（关掉 Tavily 时使用）需要凭证库里的 `DEEPSEEK_API_KEY`。

> **文档里的占位符**：`$DSH_HOME` 指 DSH 数据目录（未设环境变量时通常是 `~/.dsh`），
> `<profile>` 指你启动的 profile 名，`<port>` 指 GUI 实际监听端口，`<本包目录>`/`<owner>`
> 同理 —— 换行/换机器都能照抄。

## 文档

| 文档 | 内容 |
|---|---|
| [使用手册](./docs/使用手册.md) | 面板怎么用：开关、Key、精度、测试与额度、直搜；额度口径；数据存哪 |
| [配置手册](./docs/配置手册.md) | 全部 Config 项、状态文件、HTTP 数据面接口与安全策略、安装形态 |
| [INSTALL.md](./INSTALL.md) | 安装 / 重装 / 卸载手册，以及装完该看到什么 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更记录 |
| [NOTICE.md](./NOTICE.md) | 第三方服务依赖、官方包依赖说明 |

## 目录结构

```
dsh-tavily-search/
├── lib/
│   ├── index.js              宿主主体：provider + 开关路由 + 装配
│   ├── client.js             客户端半边：侧栏图标 + 主栏面板
│   ├── config.js             自包含 Standard Schema（Config 定义与校验）
│   ├── tavily.js             Tavily HTTP 层
│   ├── deepseek-fallback.js  自包含兜底搜索
│   ├── routes.js             面板数据面（5 条 webServer 具名路由）
│   ├── credentials.js        凭证读写
│   └── state.js              用户级状态
├── docs/                     使用手册 / 配置手册
├── cordis.patch.yml          bundle patch
├── package.json              清单（dsh.bundle / dsh.client）
└── dev-notes/                维护者本地资料（不进仓库）：自测、设计文档、历史归档
```

## 维护者备忘

### 改完代码怎么让它生效

DSH 加载的是 **profile 里的一份实体副本**（`$DSH_HOME/profiles/<profile>/node_modules/dsh-tavily-search/`），
**不会**跟着本目录自动更新。所以完整流程是：

```sh
# 1) 改源码 + 自测（测试在 dev-notes/，离线跑、不消耗任何 API 额度）
node dev-notes/test/selftest.mjs && node dev-notes/test/client-test.mjs

# 2) 同步到 profile（安装用的是 file: 依赖，内容变了必须重装）
cd "$DSH_HOME/profiles/<profile>"
rm -rf node_modules/dsh-tavily-search
pnpm install

# 3) 重启 DSH —— 插件代码不热加载，只有 profile 的 cordis.patch.yml 会热加载
```

> `rm -rf` 那一步不能省：pnpm 对 `file:` 依赖的内容变化不敏感，
> 不删就报 "Already up to date"，实际还是旧代码。

### 发布新版本

1. 改 `package.json` 的 `version`，并在 `CHANGELOG.md` 记一条；
2. `node dev-notes/test/selftest.mjs` —— 其中一条断言会校验 `lib/index.js` 的 `VERSION`
   与 `package.json` 的 `version` 一致，忘改会直接红；
3. `git add -A && git commit && git push`。

## 已知限制

- 只有搜索、没有 fetch provider：网页抓取仍走 DSH 内置的 `http` provider。
- `ctx.web` / `ctx.credentials` 是硬依赖（裁过的宿主上不加载，刻意 fail-loud）；
  `webServer` 是可选依赖，缺了只影响面板数据面。
- 兜底搜索依赖凭证库里的 `DEEPSEEK_API_KEY`。
- Tavily 的 `key.limit` 对部分套餐返回 `null`，面板此时只显示套餐维度额度。
- **插件代码改动不热加载**：改 `lib/*.js` 必须重启 DSH（只有 profile patch 改动会热加载）。

## 许可

[MIT](./LICENSE)。使用 Tavily 与 DeepSeek 服务须遵守各自的服务条款。
