# INSTALL · dsh-tavily-search 安装 / 重装手册

> 用途：**换电脑、DSH 升级后插件失效、或想从头重来**时，照着这份装回去。
> 设计目标就是「能重装」：插件**不静态依赖任何 `@deepseek-ai/*` 包**，
> 也没有任何 npm 运行时依赖，因此不需要联网装依赖，也不需要为构建脚本授权。

---

## 0. 前置条件

| 项 | 要求 | 怎么确认 |
|---|---|---|
| DSH 已安装 | 任意 profile 能正常启动 | 能打开 GUI / 能跑 `dsh --version` |
| Node | ≥ 22.19（与 DSH 同版本更稳） | `node --version` |
| 插件源码 | 本目录（含 `lib/index.js`、`cordis.patch.yml`） | 目录里有这两样 |
| Tavily API Key | 用于真实搜索 | 到 tavily.com 申请；兜底搜索另需 `DEEPSEEK_API_KEY` |

---

## 1. 安装

### 方式 A：命令行（有 `dsh` CLI 时首选）

```sh
dsh plugin add /path/to/dsh-tavily-search
```

它会把这个包登记进 profile 的依赖与 `dsh.profile.bundles`，然后**重启 DSH**。

### 方式 B：手动登记（没有 `dsh` CLI，或想精确控制）

1. 编辑 `$DSH_HOME/profiles/<profile>/package.json`：

   ```jsonc
   {
     "dependencies": {
       "dsh-tavily-search": "file:<本包目录的绝对路径>"
     },
     "dsh": {
       "profile": {
         "bundles": [ "…", "dsh-tavily-search" ]
       }
     }
   }
   ```

   - 用 `file:` 表示「装一份副本进 profile」（推荐：不依赖源码目录）；
   - 用 `link:` 表示「指向源码目录」（适合边改边试）。

2. 安装并建立链接：

   ```sh
   cd "$DSH_HOME/profiles/<profile>"
   pnpm install
   ```

   > **注意**：`file:` 依赖在**内容变化后 pnpm 不会重新复制**（会报 "Already up to date"）。
   > 更新过源码后要重装时，先 `rm -rf node_modules/dsh-tavily-search` 再 `pnpm install`。

3. **重启 DSH。**

### 方式 C：从 git 安装

```sh
dsh plugin add github:<owner>/dsh-tavily-search
```

包内没有 `prepare`/`build` 脚本（纯 JavaScript），所以**不需要** pnpm 的构建授权。

---

## 2. 装完该看到什么

| 检查 | 期望 |
|---|---|
| 左侧栏 | 「新会话」下方出现放大镜图标（排在官方「插件」与「写作助手功能」之后） |
| 点开面板 | 出现「Tavily 联网搜索」面板，五块：开关 / API Key / 搜索精度 / 连通性与额度 / 直接搜索 |
| 凭证状态 | 未配 Key 时显示「未配置」；配好后显示「已配置（来源：file）」 |
| 模型侧 | 问一个需要联网的问题，模型能正常调用 `web_search` |

> 若侧栏没有图标：插件代码**不热加载**，确认已重启；再看 profile 的 `package.json` 里
> 依赖与 `bundles` 是否都写对了。

---

## 3. 配 Key

优先用面板：打开面板 → 「API Key」粘贴 → 保存。
也可以直接写凭证库（`$DSH_HOME/.credentials.yaml` 的 `refs`）：

```yaml
TAVILY_API_KEY: tvly-xxxxxxxx
DEEPSEEK_API_KEY: sk-xxxxxxxx   # 仅在使用兜底搜索时需要
```

凭证由官方 seam 每次操作重新解析，所以**换了 Key 下一次搜索即生效，不用重启**。

---

## 4. 卸载

1. 从 `$DSH_HOME/profiles/<profile>/package.json` 里移除 `dsh-tavily-search`
   （依赖与 `bundles` 两处都要删）；
2. `rm -rf node_modules/dsh-tavily-search`；
3. 检查 profile 的 `cordis.patch.yml`，删掉本插件追加的块（停用内置搜索、钉死
   `searchProvider`、启用 `tool-web`、插件行 config）——**否则 `web.searchProvider`
   仍指向 `tavily`，而 provider 已不存在，搜索会报 `configured provider is not registered`**；
4. 重启 DSH。

> 想恢复内置搜索：把 `web-search-deepseek` 的 `disabled` 改成 `false`，
> 并删掉 `web` 行的 `searchProvider`。

---

## 5. 出问题时先看这几条

| 现象 | 先查什么 |
|---|---|
| `web_search` 报 `configured web provider "tavily" is not registered` | 插件没激活：依赖/bundles 是否登记、是否需要重启 |
| `web_search` 报 `WEB_PROVIDER_CREDENTIAL_MISSING` | 凭证库里没有 `TAVILY_API_KEY`（或面板没配） |
| 关掉开关后搜索报兜底不可用 | 凭证库里缺 `DEEPSEEK_API_KEY`，或 `fallbackBaseUrl`/`fallbackModel` 被改坏 |
| 面板显示「面板数据面不可用」 | 宿主没有 `webServer` 服务，或路由没挂上；先直接请求 `/api/dsh-tavily/state` 试探 |
| 改了代码但行为没变 | 插件代码不热加载，**必须重启**（只有 profile patch 改动会热加载） |

以上五条覆盖绝大多数情况。若仍不通，先确认三件事：插件是否激活、Key 能否解析、
`web` 行的 `searchProvider` 是否等于 `tavily`。
