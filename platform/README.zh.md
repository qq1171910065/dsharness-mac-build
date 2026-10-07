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
3. 机器级 host 配置（`$DSH_HOME/cordis.patch.yml`）对**每个** profile 生效，包括应用自己拥有的 `desktop` —— 但**只放配置覆盖**；自有插件改成组合包（下一节），这样官方插件页才能开关它。

## 目录

```text
platform/
  cordis.patch.yml         deployment rows: login origin, model route, and the disabled row
  install.mjs              write those rows, then provision the profile plugins
  provision.mjs            install this product's plugins in the shape the Plugins page can switch
  model-key.mjs            fork-owned plugin: fetch this account's gateway key into the credentials
  update.mjs               fork-owned plugin: show the installed vs published version
  update-ui.js             fork-owned browser half: the Settings row that opens the Desktop update dialog
  update-ui.host.mjs       its no-op host half (a bundle row needs one; the browser half is a classic script)
  host-auth.mjs            fork-owned plugin: shared-secret access to the official /api,
                           and the /dsharness/gateway page with the port and the secret
  home.mjs                 the $DSH_HOME resolution both scripts share
  build-deploy-payload.mjs assemble windows/deploy from the files above
  package-windows.mjs      build this product's installer through the upstream packager
  install.test.mjs         the deployment rows and their layer precedence
  provision.test.mjs       the plugin provisioning policy
  model-key.test.mjs       the key delivery plugin (20 cases)
  update.test.mjs          version comparison and the update surface (12 cases)
  update-ui.test.mjs       the in-app update row: the evaluated bundle, its registration, degradation
  host-auth.test.mjs       the gateway plugin's pure functions and its pages
  deploy-payload.test.mjs  the installer seam: payload, include, version record, profile parity
  check-host-auth.mjs      live check against a running profile (unary, cookie, index, WebSocket)
  check-desktop.mjs        live check against the real Electron renderer (CDP)
  check-pages.mjs          live check of /top_up and /usage the way the embedded view opens them
  verify-fork-update.mjs   prove the fork can still take upstream updates
  README.md
  README.zh.md
  windows/
    electron-builder-config.mjs the upstream configuration with one field replaced
    nsis-config-hook.mjs        the NODE_OPTIONS preload that substitutes it
    installer.nsh               the NSIS include: upstream first, then our hook
    app-update.yml              the update feed descriptor the installer drops into resources
    deploy/                     the deployment layer exactly as installed (generated)
    verify-installer.mjs        re-wrap win-unpacked and prove the seam end to end
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

脚本是**合并**而不是覆盖 —— 因为官方插件管理器把用户开关也记在同一个文件里；随后它把本产品自带的插件 provision 进每个它能找到的 profile（见下面「自有插件是真正的组合包」）。`--no-marketplace` 不动社区插件市场；`--check` 只报告不写；`--remove` 收回受管行、我们生成的包、依赖项与选中项。

`DSHARNESS_SKIP_INSTALL=1` 会让 `dev-all.ps1` 传 `--no-marketplace` —— 那个开关本来就意味着「这里别联网」。

### 打包本产品的桌面版

上游从 `apps/desktop/.env.windows`（或 `.env.macos`）读打包设置，而 `.gitignore` 排除了它 —— 所以本机部署文件永远不会进仓库。本产品需要它来提供应用身份与更新源，因为上游要求显式给 `DSH_DESKTOP_APP_ID`，且把生产更新源硬编码在代码里：

```
DSH_DESKTOP_APP_ID=com.czmanong.dsharness
DSH_DESKTOP_AUTO_UPDATE_ENV=test
DOWNLOAD_TEST_ORIGIN=https://www.czmanong.com
DOWNLOAD_TEST_RELEASE_ID=<32 hex characters>
```

`test` 这套完全由环境变量驱动；`production` 那套不是 —— 所以在上游把它变成配置接缝之前，更新源只能通过 test 通道指向本产品。

打包要走本层，不要直接调上游脚本：

```sh
node platform/package-windows.mjs --unsigned --build-version 0.2.1-alpha.1.20261007.1
node platform/package-windows.mjs --check          # print the plan without building
```

上游打包器原样使用，本层从外面只加两件东西。

**配置。** `apps/desktop/scripts/package-target.ts:269` 把
`['exec','electron-builder','--config','electron-builder.config.mjs',…]` 写死，而它自己的
`parseArgs` 会拒绝未声明的选项 —— 所以那条 `--config` 没法追加到打包命令上。整棵进程树确实
会继承的是 `NODE_OPTIONS`，于是用 `--import platform/windows/nsis-config-hook.mjs` 预加载，
只在「就是 electron-builder 本身」的那个进程里改这一个参数。钩子靠两个哨兵变量加
`argv[1]` 是否指向 `electron-builder/cli.js` 自我约束，并且**替换不了就大声失败** ——
用上游配置构建出来的安装包会静默地不含部署层，那比构建失败糟得多。

`platform/windows/electron-builder-config.mjs` 就是它替换进去的东西：导入上游模块，只改一个
字段。**导入上游的工厂函数**而不是把整份配置抄一遍，是为了上游新增选项时这里不会漏。

**安装脚本。** `nsis.include` 指向 `platform/windows/installer.nsh`，它先
`!include` 上游的 `apps/desktop/scripts/installer.nsh`（保住上游的自定义页面、分阶段解压与
生命周期钩子），再加一个钩子。这个钩子必须是**标准回调** —— 上游把 `customHeader`、
`customInit`、`customInstall`、`customCheckAppRunning` 等都定义成 `!macro`，而 NSIS 禁止重复
定义宏；`.onInstSuccess` 在 electron-builder 的模板里没有任何定义，是应用文件就位之后唯一
空着的执行点。

### 安装包里已经带着部署层

这正是那条接缝的意义：装完就有本产品的登录、余额与账号服务，不需要先手动跑脚本。

`platform/windows/installer.nsh` 把 `platform/windows/deploy/` 拷进
`<install>\resources\installer-ui\dsharness\`，再用**应用自带的** Node 运行时执行
`deploy-entry.mjs` —— 不需要系统 Node、npm 或 pnpm。它同时把
`platform/windows/app-update.yml` 拷进 `<install>\resources`，那正是打包后的 updater 要找的位置
（见下面的更新一节）。载荷由 `build-deploy-payload.mjs` 生成：
`home.mjs` / `provision.mjs` / `install.mjs` / `host-auth.mjs` 与上层文件**逐字节相同**，
`cordis.patch.yml` 是同一份行、**只改写一行** —— `platformOrigin` 烧成本次构建的地址，因为装好
的机器上没有 `DSH_PLATFORM_ORIGIN`，而加载器拒绝任何 `.env` 提供 `DSH_` 前缀的名字
（`packages/boot/app-boot/src/index.ts:157`）。副本一漂移，`deploy-payload.test.mjs` 就报红。

```
node platform/build-deploy-payload.mjs                        # write, default origin
node platform/build-deploy-payload.mjs --platform-origin https://example.test
node platform/build-deploy-payload.mjs --check                # fail when stale
```

地址必须是**裸 origin**。`platformOrigin(value, allowLoopbackHttp)`
（`packages/credentials/deepseek-account-platform/src/protocol.ts:22`）会拒绝任何
`pathname` 不是 `/` 的 URL —— 所以 `https://www.czmanong.com/dsharness` 这种带前缀的代管地址
用不了，哪怕容器就在那儿。改为由网关把本产品那几个路径挂在裸 origin 上。

载荷按顺序做两件事：

1. **profile 不存在时创建 `desktop` profile。** 应用本来就会在首次启动创建它
   （`apps/desktop/src/project-manager.ts:88`），而 `initProfile` 从不覆盖已存在的文件 ——
   所以这里写同样的三个文件，应用自己的初始化就变成 no-op 而不是重写，同时让
   `provisionProfile` 有 manifest 可用。少了这一步它会找不到 manifest 直接跳过。
2. **写部署行并 provision 插件**（对该 profile），走的就是开发机上的那份 `install.mjs`。
   载荷由那些文件生成；`deploy-entry.mjs` 只多给一个用
   `resources\runtime\pnpm\bin\pnpm.mjs` 与自带 Node 拼出来的 pnpm 运行器。

三个 profile 文件是**字面量**，因为载荷跑在普通 `node.exe` 下，不能从 `app.asar` 里 import
`@deepseek-ai/dsh-app-boot`（只有 Electron 打过补丁的 `fs` 能读 asar）。`deploy-payload.test.mjs`
用 `tsx` 跑上游的 `initProfile`，把三个文件逐字节比一遍。

部署失败只**报告**、不让安装失败：应用照常运行，只是暂时连上游账号服务；退出码经
`DetailPrint` 进安装日志与详情页。

想不重复前面的准备阶段就验证这条接缝，把已有的 `win-unpacked` 重新包一次：

```sh
node platform/windows/verify-installer.mjs --output "$env:TEMP\seam"
```

它用 `--prepackaged`，会短路 `doPack`（`app-builder-lib/out/platformPackager.js:146`），
于是只有 `NsisTarget` 会跑 —— 正是本产品替换的那一块。把 `deploy/deploy-entry.mjs` 删掉，
构建会以 `File: … -> no files found` 失败，这就是反例：**载荷缺失＝构建失败**，而不是静默地
产出一个不含部署层的安装包。

### 这里的行可以直接挂 fork 自有的代码

一行的 `name` 是相对**声明它的那个补丁文件**解析的，所以本层可以挂一个就放在旁边的插件，而不必是上游包：

```yaml
- insert:
    - id: dsharness-some-plugin
      name: ./some-plugin.mjs
```

这一点是实测的：往 home 级补丁里插入这样一行再启动 `web` profile，观察到了插件的副作用（`loaded:dsharness-platform-probe`）。也就是说 fork 自有能力既不需要上游包，也不需要发布到 npm 的名字。

但本产品自带的插件**不走这条路** —— 这样一行不属于任何**包**，官方插件页既列不出也开关不了它（下一节）。自有插件一律做成组合包，home 级补丁里只留「改上游已声明的行」的配置覆盖。

### 自有插件是真正的组合包

产品口径是两面：网关插件是**自定义插件、默认不启用**，社区插件市场（`dshmarket`）**默认启用**。两者都由**打包形态**决定，而不是由某条 patch 行说什么决定。

官方插件页（`packages/client/ui-plugin-manager`）列的是**包**（`pluginManager/listBundles`），并按两个包级标志分组：

| 分组 | 条件 |
|------|------|
| 已安装 | `installed \|\| !optional` |
| 官方 | `optional && !installed` |

一行从 patch 文件直接插进去的行不属于任何包，页面就不会提它。真机桌面 Host 上实测：那一行**能被 `listPlugins` 定位**（`patchId: dsharness-host-auth`），而 `listBundles` 完全不知道它 —— 页面上**没有卡片可切**，而这正是需求本身。`optional` 也不是部署能设的，它来自启动器自己的 `OPTIONAL_BUNDLES` 白名单。

真正可由部署决定、也是 `provision.mjs` 唯一在写的，是这一对：

- **`installed`** —— profile 的 `node_modules` 里有一个真的组合包，并写进 profile manifest 的 `dependencies`；
- **`enabled`** —— `dsh.profile.bundles` 里有没有它。列在那里才会加载；只是装了不算。

于是**默认不启用**＝**装了但没选中**，**默认启用**＝**装了且选中**。两者之后都能在插件页里用官方 `setBundleEnabled` 切换，中间没有我们自己的机制。

`node platform/install.mjs` 之后在真机桌面 Host 上实测：

```text
dsharness-host-auth  installed=true   enabled=false  title{zh: "DSH Desktop 网关"}   rows=[dsharness-host-auth]
dshmarket            installed=true   enabled=true   title{zh: "插件市场"}          rows=[dsh-market]
```

`--dump-config` 也一致：按写下的选中列表组合出来的树里有 `dsh-market`，**没有** `dsharness-host-auth`。经官方开关（`pluginManager/setBundleEnabled`）把我们那个打开之后，共享密钥通道对正确密钥回 200，而错密钥/无密钥仍是 401 —— `check-host-auth.mjs` 对真机 Host 覆盖了这一段。

#### 默认态绝不写进任何 patch 层

看起来更省事的另一条路 —— 继续从 `$DSH_HOME/cordis.patch.yml` 插入那一行，再在某处写 `disabled: true` —— 是死路，而且值得记下来，因为它看起来是对的。`readProfilePatches`（`packages/boot/app-boot/src/profile-context.ts:63`）的层序是 *bundle 层 → profile 层 → `$DSH_HOME` 层 → overlay*，后应用的层按行 id 覆盖前面的。用真的 `applyEntryPatches` 实测：

```text
[profile(disabled=false), home(insert + disabled=true)] → disabled=true
[home(insert, neutral),   profile(disabled=true)]       → disabled=true
[home(insert, neutral),   profile(disabled=false)]      → disabled=false
```

即：写进我们受管块的默认态会成为最后一句话，插件页的开关**永远打不开**。让包自己拥有那一行就把这个问题整个消掉：`platform/cordis.patch.yml` 现在只在原处留一段说明，而 `install.test.mjs` 断言那里不再有任何自有 insert、也没有任何 `disabled:`。

#### 一处值得知道的不对称

pnpm 会把指向 profile 之外的 `link:` 目标剪掉，所以生成的包是**真目录**，放在 `<profile>/node_modules` 里，依赖记成 `file:./node_modules/<name>`（`pluginInstallSpec`）。这样也不需要符号链接权限 —— 在 Windows 上那意味着得开开发者模式。

我们自己的包直接落盘、完全不需要包管理器，所以网关插件在从没连过 npm 的机器上也能用；只有 `dshmarket` 走 pnpm。插件市场装失败会带上精确的手工命令如实报告，绝不会让部署失败。

#### 在长寿命进程里「关掉」并不会作废已发出的 cookie

实测：经 `setBundleEnabled` 打开再关闭之后，`listBundles` 说 `enabled: false`、`pluginInventory/list` 里也没有那一行了 —— 但带**正确密钥**的请求**仍然 200**（无密钥与错密钥仍是 401，所以不是恒真放行）。清理确实恢复了 `connection` 上的方法引用，但**已经换取过的连接 cookie 仍是有效的短时凭证**：官方并不会在每次请求上复查它由谁铸的。这要动上游的 `connection` 才能修，而它不影响默认态 —— 默认从没打开过。要立刻作废就换 `DSH_AUTH_TOKEN` 并重启：那些 cookie 是用连接层密钥签的。

### 服务端到服务端访问官方 `/api`（`host-auth.mjs`）

官方 `/api` 用的是一个只有拿着 `dsh web` 启动令牌的浏览器才换得到的 cookie（`packages/client/connection/src/browser-auth.ts`）。**没有浏览器**的调用方 —— 另一个产品的服务端、脚本、小程序后端 —— 拿不到它，也不该为此去跑一个浏览器。

`host-auth.mjs` 增加一种落在同一处的凭据：正确的共享密钥（`Authorization: Bearer <密钥>`，或本插件发的 cookie）会被换算成**只服务这一次请求**的连接 cookie，追加到请求上。官方那两层校验照常执行，只是它们看到的请求已经满足了要求。

| 调用方 | 怎么进去 |
|--------|----------|
| 不带凭证 | 被官方连接层 401 —— 本插件自己不放开任何东西 |
| 错密钥 / 过短密钥 | 同上，401 |
| `Authorization: Bearer <密钥>` | 放行；覆盖 unary RPC **以及** `/api/remote.mux` 升级 |
| 局域网里的浏览器 | `/dsharness/auth` 用密钥换 cookie，之后 `/` 与 `/api` 都能用 |
| 密钥未配置 | 首次运行时生成一把并持久化，于是通道能用，也能从 `/dsharness/gateway` 读到 |

### 端口与密钥必须能被读到（`/dsharness/gateway`）

用户报的是「无法对接」，而原因是结构性的：端口与共享密钥只活在进程里。`dsh web` 只在**启动那一次**把 `?token=` 打到终端，而桌面端连终端都没有。所以 `host-auth.mjs` 把这两样都渲染出来：

| 面 | 给什么 |
|----|--------|
| `GET /dsharness/gateway` | HTML 页：端口、本机地址、共享密钥、cookie 名、登录页，以及一个复制按钮 |
| `GET /dsharness/gateway.json` | 同一份事实的 JSON，给调用方与验收脚本用 |

三点是刻意的：

- **只在回环上回**。非回环请求拿到的是说明页，JSON 面直接 `403`。密钥只应在运行 DSH 的这台机器上可读。
- **端口取自本次请求的 authority**，而不是另存一份配置：`webServer.port` 在配置端口为 `0` 时只有监听之后才知道，而 authority 是调用方**实际打到**的那个 `host:port`，一定是对的。
- **不带 `?token=`**。`dsh web` 打印的那个是**连接层**的一次性凭据，本插件既拿不到也不需要；把它与共享密钥混在一个 URL 里，只会让「哪个是哪个」永远说不清。

密钥未配置（或太短）时现在改成**生成并持久化**，而不是让插件整体不挂载：部署行总是给出 `token` 键，所以「未配置」才是默认态，而一条会自己关掉的通道没有任何东西可显示。生成的值写进凭据层的 `DSHARNESS_AUTH_TOKEN`，因此跨重启稳定 —— 每次启动都变的密钥，是用户永远抄不下来的密钥。要关掉这条通道只有 `enabled: false`。

两个面都注册成 `kind: 'exact'`，并且在 `authorizeIndex` 上额外放行：`webServer.match()` 先查 exact 表，但 `frontend-static` 会把 index 请求交给 `authorizeIndex`，而它只认 `GET /` —— 不放行的话这两页能不能读到就取决于路由注册谁先赢。


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

`cordis.patch.yml` 改的是上游**已经声明**的四行。补丁是**整块替换** `config`，所以每次覆盖都要把该行拥有的键全部重述一遍。这里**不插入**任何自有插件 —— 它们改成组合包发布，理由见上文。

| 行 | 上游默认 | 本部署 |
|----|----------|--------|
| `deepseek-account` → `platformOrigin` | `https://platform.deepseek.com` | 本产品 server（`PUBLIC_BASE_URL`） |
| `deepseek-account` → `desktopPlatform` | `null` | 保留原表达式 |
| `deepseek-account` → `allowLoopbackHttp` | `false` | 除非 `DSH_PLATFORM_ALLOW_LOOPBACK_HTTP=0`，否则打开 |
| `llm-pi-ai` → `providers.dsharness-relay` | `{}`（没有任何 route） | 本产品网关，界面显示「码农AI」 |
| `agent-default-model` | `deepseek-official` / `deepseek-flash` | `dsharness-relay` / `deepseek-v4.1-flash` |
| `llm-deepseek-account` → `disabled` | 挂载 | `true` —— 理由见下 |

装好的那份副本里是**字面地址**而不是开发副本用的 `!!js process.env…` 表达式：装好的机器上没有环境变量可读，而且加载器拒绝任何 `.env` 提供 `DSH_` 前缀的名字。

### 模型走本产品网关，不是 DeepSeek 官方

上游默认把模型选成 `deepseek-official`，而那个 provider 包里 `displayName` 硬编码为 `DeepSeek`、端点是 `api.deepseek.com`、目录里既没有 `deepseek-v4.1-flash` 也没有本产品提供的任何模型。改那一行等于改上游包，所以 route 声明在上游留出的位置上：`llm-pi-ai` 默认挂载但 `providers` 是空的，它自己的注释就写着「等到有 `llm-pi-ai:` 配置段来填」（`packages/bundle/base/cordis.patch.yml:120-128`）。provider profile 的 dict 键**就是** route，`displayName` 由我们给：

```yaml
dsharness-relay:
  displayName: '码农AI'
  api: 'openai-completions'
  baseURL: 'https://ai.czmanong.com/v1'
  apiKeyEnv: 'DSHARNESS_MODEL_KEY'
```

`baseURL`、`api` 与模型目录都与 `GET /api/config` 下发的一致（`server/src/lib/defaults.ts`），所以模型选择器与服务端说的是同一件事。

### 为什么要把「账号直连推理」这条 route 关掉

`llm-deepseek-account` 用 `account.resolveToken(baseURL)` 拿凭证，再把拿到的东西当 `x-dsh-auth-token` 发出去（`packages/llm/llm-deepseek-account/src/index.ts:20-25`）。两条事实让它在本产品下走不通，第二条还是**破坏性的**：

1. `resolveToken` 只在请求 origin 等于 `inferenceOrigin` 时才交出 grant（`packages/credentials/deepseek-account-platform/src/index.ts:385-401`），而本部署的推理 origin 是网关，网关**根本不读这个头**。实测（有效 key）：`x-dsh-auth-token` → 401，`x-api-key` → 200。
2. 这条 route 上的 401 由 `onRequestError` 处理，它会调 `rejectToken`（`.../llm-deepseek-account/src/index.ts:26-36`）。而 `rejectToken` → `expireCredential` 会**删掉本地 grant** 并发 `deepseek-account/signed-out`（`.../deepseek-account-platform/src/index.ts:322-344`）。也就是说**一次请求失败就把用户登出** —— 这正是「登录 → 开新会话 → 回到登录页」。

只关了这一条 LLM route。`deepseek-account`（登录、余额、赠金、退登）必须留着，否则整个官方账号面消失。

**这是已知的一条登出路径，不是全部解释。** 其余能让同一份凭据点失效的路径：产品自己那几个账号端点回 401 / `code: 40003`（`server/src/lib/dsh-account.ts:84-86`；退登或管理端停用会提升 `tokenVersion`，从而复现）；以及启动时的 `issuer-mismatch`，它连一次请求都不发就丢掉 grant（`.../deepseek-account-platform/src/index.ts:167-176`），Host 日志里会留 `stored grant discarded`。排查「被踢回登录」要分清是这三条里的哪一条，不能默认是这一条。

### key 缺的那一步：投递（`model-key.mjs`）

产品 server 一直在 `GET /api/account/model-access` 回该用户的网关 key，而本 fork 里**从来没有东西读它**：在 `client/` 里搜 `model-access`、`apiKeyCreated`、`dshModelKey` 是 **0 处命中**。于是上面那条 route 没有任何凭据，每次请求都以 `MISSING_CREDENTIAL` 失败。

`platform/model-key.mjs` 就是那个消费者。它在账户状态变化时向产品 server 要 key，写进凭据层的 `DSHARNESS_MODEL_KEY`（正是 `llm-pi-ai` 的 `apiKeyEnv` 指的那个引用），并在退登或拿到未授权答复时删掉。传输失败**保留**已写入的 key —— 一个 `503` 说明不了网关 key 还有没有效。

### 检查更新（`update.mjs`）

官方 updater 需要 `app-update.yml` 在应用的 resources 旁边，而未签名构建永远不会有它：`publish: null`（`apps/desktop/scripts/electron-builder-config.mjs:249`）让 electron-builder 不生成那个文件（`app-builder-lib/out/publish/PublishManager.js:87-90`），而 `update-coordinator.ts:54` 正要求它、`:185` 缺它就抛。安装器自己投放一份（`platform/windows/app-update.yml`）就成立，因为 `NsisUpdater.verifySignature()` 在 `publisherName` 缺席时返回 null —— 即**不做任何校验就接受**（`electron-updater/out/NsisUpdater.js:84-100`）。那个键是**故意不写**的：写了就会去跑真 Authenticode 校验，每次更新都以 `ERR_UPDATER_INVALID_SIGNATURE` 失败。

所以 `platform/update.mjs` 自己给答案：`/dsharness/update`（HTML）与 `/dsharness/update.json`，拿已装版本与产品 server 在 `GET /api/config/version` 发布的版本比。它只**报告**，不下载也不安装。

已装版本来自 `<DSH_HOME>/dsharness-install.json`，由载荷在安装期写下。安装器把 NSIS 的 `${VERSION}` 传进去 —— 那是 electron-builder 按打包版本定义的，而**未签名构建里只有安装器知道用户装的是哪一版**。

⚠️ 两份发布记录是**两个不同的存储**，两边都必须写：`wb_client_release`（Platform，官网渲染它）与产品 server 的 `desktopRelease`（客户端读它）。实测过的漂移就是 `register-client-release.mjs` 现在两边都写的原因：官网写着 `0.2.1-alpha.1.20261007.2`，而 `/api/config/version` 还在回 `0.2.0`，于是刚装好的客户端被告知「已是最新」。

### 应用内的检查更新入口（`update-ui.js`）

上面那一面回答的是「这是哪个版本」，它不是用户会去的地方。壳里其实已经暴露了**真正的应用内更新 UI** —— `dshDesktop.updates.open()`（`apps/desktop/src/preload-app.ts:49-57`，契约在 `ipc.ts:82-86`）会调 `main.ts` 的 `openUpdatePrompt()` 弹出原生的检查 / 下载 / 安装对话框 —— 但**出厂界面里没有任何东西调它**：唯一知道更新状态的那个组件（`DesktopUpdateIndicator.tsx:64`）在 idle 时什么都不渲染。所以在用户拿到的产品里，这个动作根本没有可点的路径；在 `packages/` 与 `apps/` 下搜 `updates.open`，命中的只有 preload、它的测试和那个指示器，没有任何入口。

这就是这一层必须是**插件**而不是改上游的原因：`settings.general.item` 是上游公开的扩展位（声明在 `packages/client/ui-settings/src/client/contract/slots.ts:92`），一个注册者只需要一次 `slots.register`，而本 fork 的规矩是 `packages/` 与 `apps/` 一个字节都不碰。所以 `update-ui.js` 往「设置 › 通用」加一行，order 90（夹在 `developer-tools` 与 `current-version` 之间），按钮调 `globalThis.dshDesktop?.updates?.open()`，状态行把订阅到的 `status()` phase 说成人话。

三个细节是刻意的，且都有 `update-ui.test.mjs` 的断言：

- **bundle 是经典脚本，所以这个插件是两个文件。** 客户端模块系统用 `document.createElement('script')` 加载 bundle（`packages/client/modules/src/client/system.ts:16-29`），并按包名对账注册 `id`，所以 `update-ui.js` 只能通过 `window.__ModuleLoader__.load(...)` 注册自己，不可能是 ESM 插件；而 Node 那边 import 的是 bundle 行的 `index.mjs`。`update-ui.host.mjs` 就是那个空实现的宿主半，`provision.mjs` 的 `clientEntry` 字段把浏览器半拷成包内的 `client.js` —— 一个包要同时是 bundle 行**和**被服务的浏览器 bundle，两者都需要。
- **这一行不需要任何上下文。** `settings.general.item` 的 owner props 是空的，而 `dsh-client-locale` 不在客户端 bundle 可 `require` 的 9 个基线模块里（`packages/client/web/src/platform.ts`），所以文案是内置的，按 `navigator.language`（退回 `<html lang>`）选中英。服务缺席时不会有任何东西消失 —— 这条路径上压根没有服务。
- **浏览器里降级而不是报错。** 没有 `dshDesktop`（纯 `dsh web` profile）时这一行会说明原因并禁用按钮。

`platform/windows/app-update.yml` 是同一功能的另一半，而且**刻意走两条路**：NSIS include 把它拷进 `$INSTDIR\resources`，让打包后的 updater 有 feed 可读；`windows/update-descriptor.mjs` 同时把它加进 electron-builder 的 `extraResources`，让它**在安装器跑之前就已经在包里**。第二条路存在的理由是实测出来的顺序问题：更新安装是静默 + 强启，assisted 安装器会在安装段结束时先重启应用（`app-builder-lib/templates/nsis/installSection.nsh:105-109`）—— 用 NSIS 顺序探针实测：重启那一刻描述文件还不存在，`.onInstSuccess` 紧接着才写入。只靠 include 的话，刚重启的那个实例会以 `enabled() === false`（`update-coordinator.ts:54`）做启动检查并报一次失败，之后重试才成功。所以 include 里的 `File` 是覆盖一份相同副本，而不是创造它。

那个文件里的缓存目录名是与**安装器**的约定，不是随便起的标签：`updaterCacheDirName: '@deepseek-aidsh-desktop-updater'` 必须等于安装器算出来的值，因为卸载器删除的正是 `%LOCALAPPDATA%\<该名>`（`apps/desktop/installer/uninstall.nsh:34`），而 updater 会把约 292 MB 的未完成下载留在 `<该名>\pending`。该值来自 `appInfo.updaterCacheDirName`（`app-builder-lib/out/appInfo.js:126-128`，即 `sanitizedName.toLowerCase() + '-updater'`，`sanitizeFileName` 会保留 `@`），构建把它原样记成 `!define DSH_UPDATER_CACHE_NAME "@deepseek-aidsh-desktop-updater"` —— 在构建产物 `builder-debug.yml` 里实测得到。名字不一致不会让更新坏掉，只会在卸载时**静默留下**那笔下载，所以 `deploy-payload.test.mjs` 把它钉住了。引号是必需的：YAML 把行首的 `@` 当保留指示符。

### 客户端打包时写死的地址必须能直达本产品

`platformOrigin` 会被校验成 origin，官方协议的每条路径都直接拼在它后面：

| 路径 | 由谁提供 |
|------|----------|
| `/auth-api/v0/dsh/auth_init`、`/auth-api/v0/users/current`、`/auth-api/v0/users/logout` | `server/src/routes/dsh-account.ts` |
| `/api/v0/users/get_user_summary`、`/api/v0/users/get_unnotified_bonuses`、`/api/v0/users/ack_bonus_notified` | `server/src/routes/dsh-account.ts` |
| `/dsh/authorize`、`/dsh/authorize/complete`、`/dsh/authorized` | `server/src/routes/dsh-account.ts` |
| `/top_up`、`/usage`、`/api/page/*` | `server/src/routes/pages.ts` |
| `/api/config`、`/api/config/version` | `server/src/routes/api.ts`（检查更新页读的发布信息） |

所以网关必须把这些路径送到产品服务的端口，而且**不能吃掉前缀**：官方 provider 的
`browserUrl()` 会把 `url.pathname` 与字面量 `/dsh/authorize`、`/dsh/authorized` 比对
（`packages/credentials/deepseek-account-platform/src/protocol.ts:40`），它还拒绝平台回一个与自己
配置不同的 origin。也就是说**前缀映射的部署在这个 provider 下根本走不通** —— 地址必须是
「在本产品路径的根上提供这些路径」的那个主机名。

账号页那两个链接必须**被渲染**而不是被重定向：桌面端用**同源** `WebContentsView` 打开它们，
而它的 `will-redirect` 只放行 `account.origin`，302 出去就会被取消、用户看到空白。这就是
`/top_up` 与 `/usage` 在 `server/src/routes/pages.ts` 里是页面而不是跳转网关的原因。

### 为什么一行就能接通官方全部登录

官方 Electron 欢迎窗口的 Sign in、设置里的账号页、桌面引导的额度页、`deepseek-account` 模型 provider —— 全部经 `ctx.deepseekAccount` 只能和 `platformOrigin` 说话。把这一行指向本产品，它们就都落到 `server/src/routes/dsh-account.ts` 实现的官方协议面上，再由它转发到既有的 `/api/auth/*` 端点。
