# dsharness 部署层（本 fork 自有，上游没有对应目录）

[English](README.md) | 中文

本目录是本 fork 全部自有改动的唯一落点。上游 deepseek-harness 没有 `platform/` 目录，因此跟进上游永远不会在这里冲突：

```sh
git fetch upstream
git merge upstream/master      # never conflicts in platform/
```

## 为什么不用 patch-package 补丁

被替换掉的 `client/` 是一个第三方壳，靠 24 个 `patch-package` 补丁（+3285 行）改写构建产物 `@deepseek-ai/*`：

| 补丁 | 体量 | 为什么撑不过一次更新 |
|------|------|----------------------|
| `dsh-client-ui-settings-models` | 100 KB / 51 hunks | 上游每次重打 bundle 都要手工重算 hunk 头 |
| `dsh-api-session-controller` | 45 KB / 17 文件 | 上游挪一次位置就要重写一整套远程契约 |
| `dsh-client-ui-workspace` | 56 KB / 60 hunks | 上游根本没有会话行菜单槽位可以扩展 |

官方 harness 的设计本来就让这种做法没有必要：

> There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads. -- `docs/architecture.md`

所以本层不改上游任何文件，只用三个公开机制：

1. profile 补丁层（`cordis.patch.yml`）按 `id` 覆盖或停用某一行；
2. cordis 插件包（Host 半边用 `dsh.bundle.patch`，浏览器半边用 `dsh.client`）增加能力；
3. 机器级 host 配置（`$DSH_HOME/cordis.patch.yml`）对**每个** profile 生效，包括应用自己拥有的 `desktop`。

## 目录

```text
platform/
  cordis.patch.yml         deployment rows: point the official login at this product
  host-auth.mjs            fork-owned plugin: shared-secret access to the official /api
  install.mjs              merge the rows into $DSH_HOME/cordis.patch.yml, copy the plugin beside them
  install.test.mjs         the merge and copy rules (12 cases)
  host-auth.test.mjs       the plugin's pure functions (18 cases)
  check-host-auth.mjs      live check against a running profile (unary, cookie, index, WebSocket)
  check-desktop.mjs        live check against the real Electron renderer (CDP)
  check-pages.mjs          live check of /top_up and /usage the way the embedded view opens them
  verify-fork-update.mjs   prove the fork can still take upstream updates
  README.md
  README.zh.md
```

## 跟进上游

```sh
git fetch upstream
git merge upstream/master
```

这就是全部更新流程，而且**永远不会冲突** —— 本 fork 自有的每个文件都在 `platform/`，上游没有这个目录。这个性质要**机械地验**而不是靠信：改错一个上游文件今天不会坏任何东西，只会坏下一次上游发布。

```sh
node platform/verify-fork-update.mjs
node platform/verify-fork-update.mjs --no-fetch
```

它检查 `upstream` 指向官方仓、自有改动没有碰任何上游跟踪的文件、`platform/` 只存在于本 fork，并在**临时分支**上真跑一次 `git merge upstream/master`（无论走哪条路径都恢复原来的 HEAD）。工作区有未提交的改动时它拒绝运行，而不是带着脏状态去合并。

## 用法

```sh
node platform/install.mjs
DSH_PLATFORM_ORIGIN=https://www.czmanong.com node platform/install.mjs
```

脚本是**合并**而不是覆盖 —— 因为官方插件管理器把用户开关（`- id: ...` / `disabled: true`）也记在同一个文件里。

### 打包本产品的桌面版

上游从 `apps/desktop/.env.windows`（或 `.env.macos`）读打包设置，而 `.gitignore` 排除了它 —— 所以本机部署文件永远不会进仓库。本产品需要它来提供应用身份与更新源，因为上游要求显式给 `DSH_DESKTOP_APP_ID`，且把生产更新源硬编码在代码里：

```
DSH_DESKTOP_APP_ID=com.czmanong.dsharness
DSH_DESKTOP_AUTO_UPDATE_ENV=test
DOWNLOAD_TEST_ORIGIN=https://www.czmanong.com
DOWNLOAD_TEST_RELEASE_ID=<32 hex characters>
```

`test` 这套完全由环境变量驱动；`production` 那套不是 —— 所以在上游把它变成配置接缝之前，更新源只能通过 test 通道指向本产品。

### 这里的行可以直接挂 fork 自有的代码

一行的 `name` 是相对**声明它的那个补丁文件**解析的，所以本层可以挂一个就放在旁边的插件，而不必是上游包：

```yaml
- insert:
    - id: dsharness-some-plugin
      name: ./some-plugin.mjs
```

这一点是实测的：往 home 级补丁里插入这样一行再启动 `web` profile，观察到了插件的副作用（`loaded:dsharness-platform-probe`）。也就是说 fork 自有能力既不需要上游包，也不需要发布到 npm 的名字。

但相对 `name` 是相对**声明它的那个补丁文件**解析的，而 `install.mjs` 把那个文件写进 `$DSH_HOME`。所以插件必须待在**那份副本旁边**，而不是本 README 旁边：`install.mjs` 会把 `PLUGIN_FILES` 里的每个文件复制进 home 目录，行引用的是副本（`name: ./dsharness-host-auth.mjs`）。于是一个脚本同时管住「行」与「它挂的代码」的落点，两者不可能各说各话；`--remove` 也会把两者一起收回去。

### 服务端到服务端访问官方 `/api`（`host-auth.mjs`）

官方 `/api` 用的是一个只有拿着 `dsh web` 启动令牌的浏览器才换得到的 cookie（`packages/client/connection/src/browser-auth.ts`）。**没有浏览器**的调用方 —— 另一个产品的服务端、脚本、小程序后端 —— 拿不到它，也不该为此去跑一个浏览器。

`host-auth.mjs` 增加一种落在同一处的凭据：正确的共享密钥（`Authorization: Bearer <密钥>`，或本插件发的 cookie）会被换算成**只服务这一次请求**的连接 cookie，追加到请求上。官方那两层校验照常执行，只是它们看到的请求已经满足了要求。

| 调用方 | 怎么进去 |
|--------|----------|
| 不带凭证 | 被官方连接层 401 —— 本插件自己不放开任何东西 |
| 错密钥 / 过短密钥 | 同上，401 |
| `Authorization: Bearer <密钥>` | 放行；覆盖 unary RPC **以及** `/api/remote.mux` 升级 |
| 局域网里的浏览器 | `/dsharness/auth` 用密钥换 cookie，之后 `/` 与 `/api` 都能用 |
| 密钥未配置或短于 16 位 | 插件什么都不做（一条 warn）；`/api` 保持上游行为 |

它包装的是 `connection.requestRejection` 与 `connection.authorizeIndex`，而不是注册路由 —— 因为 `/api` 已经被占了：`webServer.register` 对同一个 `(kind, path)` 重复注册会抛错，而升级握手那条路由由 `api-gateway` 单独注册。两处准入判断最终都汇到这两个服务方法上，所以**一处包装覆盖全部载体**。

它**不是第二套鉴权**：Host/Origin 围栏与连接 cookie 校验仍然做决定，没有新增信任主体，比较用 `timingSafeEqual`。插件是零依赖 `.mjs`（只 import `node:` 内置模块），因为本层没有 `node_modules`：配置按普通对象读，连接凭据的键直接写字面量（`client-connection/browser-session`，也就是 `credentialKey(scope, id)` 的产物）。

启动时它会铸一个 cookie 走一遍官方 `requestRejection` 做自检；上游格式漂移会**立刻 warn**，而不是等到线上 401。`check-host-auth.mjs` 对跑着的 profile 覆盖整条链路：

```sh
# one terminal: a gated profile
$env:DSH_HOME="$env:TEMP\dsh-auth"; $env:DSH_AUTH_TOKEN='<at least 16 chars>'
node platform/install.mjs
node apps/cli/lib/bin.js web --port 13096 --no-open
# another
$env:DSH_AUTH_TOKEN='<the same secret>'; node platform/check-host-auth.mjs
```

本机实测：无凭证 / 错密钥 / 过短密钥一律 401；正确密钥进得了真实 RPC 面（`result.ok: true`）；登录页发的 cookie 同样能过；`/` 无凭证 401、带 cookie 200；mux 升级握手通过并收到数据帧。

### 账号页那两个链接必须由本产品渲染

官方 provider 把账号页的用量与充值链接生成成 `<platformOrigin>/usage` 与 `<platformOrigin>/top_up`（`deepseek-account-platform/src/index.ts:188`），而**桌面端用同源 `WebContentsView` 打开它们**，那个视图的导航守卫是：

```js
const allowNavigation = (url) => new URL(url).origin === account.origin
view.webContents.on('will-redirect', (event, url) => { if (!allowNavigation(url)) event.preventDefault() })
```

所以任何跳出 `platformOrigin` 的重定向都会**被取消**，用户看到一块空白。这正是「点充值没反应」的真因：这两条路径曾经 302 到 `ai.czmanong.com`。它们必须由本产品自己渲染 —— 见 `server/src/lib/page-shell.ts`、`topup-page.ts`、`usage-page.ts`、`page-session.ts` 与 `server/src/routes/pages.ts`。

`check-pages.mjs` 走的就是内嵌视图那条路：注入 `window.dsh.getAuthToken()`（官方 preload 暴露的桥）并且**刻意不种 cookie**，这样它不会不小心测成浏览器那条路。请在 `npm run e2e` 之后跑它 —— e2e 最后一步的退登会作废所有既有会话。

### 桌面端（Electron）是同一个面

桌面应用起的是**同一个 web 组合**：`apps/desktop-host/src/index.ts` 起 `webServer` + `connection`，Electron 只负责窗口。而 `install.mjs` 把行写进 `$DSH_HOME/cordis.patch.yml`，**每个** profile 都读它 —— 所以桌面 profile 不需要任何额外改动就同时拿到了账号行与 host-auth 通道。

`check-desktop.mjs` 通过 CDP 对**真实渲染进程**验这件事（Electron 由 `apps/desktop/scripts/dev.ts` 带 `--remote-debugging-port=9222` 起）：

```powershell
# one terminal
cd server; npm run dev
# another
cd client
$env:DSH_HOME="$env:TEMP\dsh-desktop-dev"
$env:DSH_PLATFORM_ORIGIN='http://127.0.0.1:13090'
$env:DSH_AUTH_TOKEN='<at least 16 chars>'
node platform/install.mjs
Remove-Item Env:\ELECTRON_RUN_AS_NODE      # see below, this matters
pnpm run start:desktop
# a third
$env:DSH_E2E_EMAIL='<a user that exists in this product>'; node platform/check-desktop.mjs
```

它验的是 Web 那套验不到的：桌面壳**自己**注入 `dshDesktop`（含 `browser` / `deviceInfo` / `keyboard` / `shortcuts` / `updates`），所以账号 UI 是真实那一份而不是夹具；官方登录指向本产品 server；回调被接受；`getProfile` / `getBalance` 回的是本产品数据；账号页渲染出余额。

四个耗过时间、值得先知道的坑：

| 症状 | 原因 |
|------|------|
| `electron.exe: bad option: --remote-debugging-port=…` | 在 DSH 里面启动会继承 `ELECTRON_RUN_AS_NODE=1`；清掉它 |
| `Target.createTarget: Not supported` | CDP 不支持 `context.newPage()`；驱动现有页面，额外步骤走 HTTP |
| 明明可见的按钮被判成不可见 | 覆盖层是 `position: fixed`，`offsetParent` 恒为 null；`checkVisibility({checkOpacity,checkVisibilityCSS})` 在这里也返回 false。用几何尺寸 |
| 账号分区怎么都出不来 | 侧栏触发器的文本是**用户名**，菜单项文本是 `设置Ctrl+,`；要按 `button[aria-label="账号菜单"]` → `[role=menuitem]` 选。另外官方的 onboarding 覆盖层得先退出（循环点，且优先点确认框自己的键） |

## 它改了什么

`cordis.patch.yml` 有两条行，而且刻意是两种不同的东西：

1. **覆盖** `packages/bundle/base/cordis.patch.yml` 声明的 `deepseek-account` 行 —— 补丁是**整块替换** `config`，所以条目要把该行拥有的键全部重述一遍；
2. **插入** `dsharness-host-auth` —— 上游没有这一行。插入在构造上就不可能和上游冲突，所以 fork 自有的插件走「新增一行」而不是「改一行」。

| 键 | 上游默认 | 本部署 |
|----|----------|--------|
| `platformOrigin` | `https://platform.deepseek.com` | 本产品 server（`PUBLIC_BASE_URL`） |
| `desktopPlatform` | `null` | 保留原表达式 |
| `allowLoopbackHttp` | `false` | 除非 `DSH_PLATFORM_ALLOW_LOOPBACK_HTTP=0`，否则打开 |

### 为什么一行就能接通官方全部登录

官方 Electron 欢迎窗口的 Sign in、设置里的账号页、桌面引导的额度页、`deepseek-account` 模型 provider —— 全部经 `ctx.deepseekAccount` 只能和 `platformOrigin` 说话。把这一行指向本产品，它们就都落到 `server/src/routes/dsh-account.ts` 实现的官方协议面上，再由它转发到既有的 `/api/auth/*` 端点。

### 还缺的一环：把每个用户的网关 key 送进 provider

网关**确实提供 Anthropic Messages 格式**，所以不需要第二个适配器：本产品的 New API 部署把 `POST /v1/messages` 当作 `RelayFormatClaude` 处理（`relay/server/router/relay-router.go`），并且接受 `x-api-key` 作为凭据（`relay/server/middleware/auth.go` 的 `TokenAuth` 会把 `/v1/messages` 的 `x-api-key` 映射成 `Authorization: Bearer`）。

因此正确的路径是官方的 **API-key** provider：`llm-deepseek`（`packages/llm/llm-deepseek-api-key`）本来就用 `x-api-key`，它只差

- `baseURL: https://ai.czmanong.com/v1`（Messages 请求会打到 `<root>/messages`），
- `models` 指向本产品的模型目录，
- `apiKeyEnv` 指向存放该用户网关 key 的凭据。

账号 provider 走不了这条路：`llm-deepseek-account` 把授权 token 当 `x-dsh-auth-token` 发，而网关不读这个头。所以**账号仍然负责登录、余额与退登**，而推理用 `GET /api/account/model-access` 签发的该用户 `sk-` 认证。

缺的是投递那一步：目前还没有东西在启动与登录后去取那个端点，并把 key 写进那个带凭据的 `apiKeyEnv` 引用。旧壳在 `src/main/account/provider-sync.ts` 里做这件事；在这里它应当是本层挂载的 fork 自有插件行。
