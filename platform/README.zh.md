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
3. 机器级 host 配置（`$DSH_HOME/cordis.patch.yml`）对**每个** profile 生效，包括应用自己拥有的 `desktop` —— 但**只对设置页不写的行**；对它管的那类命名空间写 `config:` 是把设置页锁死，不是给默认值（见下面「模型走本产品网关」一节）。自有插件改成组合包（下一节），这样官方插件页上它是一张真正的卡片。

## 目录

```text
platform/
  cordis.patch.yml         deployment rows: the login origin, and the two upstream routes this
                           deployment switches off — no page-writable `config:` (see below)
  install.mjs              write those rows, then provision the profile plugin and its catalog
  provision.mjs            install this product's one bundle package, retire the four it replaced,
                           and write the model catalog into each profile's own patch layer
  dsharness.mjs            the product's own bundle, host half: the local gateway, the model-key
                           delivery loop, the update check, and the /dsharness/status.json status
                           face plus the on-demand /dsharness/secret.json value face
  dsharness-ui.js          its browser half: the read-only component panel on the bundle's own card,
                           its two copy buttons, the Settings › General update row, and the status
                           face's consumer
  home.mjs                 the $DSH_HOME resolution both scripts share
  build-deploy-payload.mjs assemble windows/deploy from the files above
  package-windows.mjs      build this product's installer through the upstream packager
  install.test.mjs         the deployment rows, their layer precedence, and the rows this layer must never regain (15 cases)
  provision.test.mjs       the plugin provisioning policy, the retired-package migration, and the model catalog (34 cases)
  dsharness.test.mjs       the merged bundle's host components and the status + value faces (76 cases)
  dsharness-ui.test.mjs    the browser half: the evaluated bundle, its two registrations, the panel, the copy buttons (22 cases)
  deploy-payload.test.mjs  the installer seam: payload, include, version record, profile parity (24 cases)
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

脚本是**合并**而不是覆盖 —— 因为官方插件管理器把用户开关也记在同一个文件里；随后它把本产品自带的插件 provision 进每个它能找到的 profile（见下面「自有插件是真正的组合包」）。它的受管行是 `deepseek-account`，加上它关掉的两条上游 route：`llm-deepseek` 与 `llm-deepseek-account`；它**刻意不带**任何「设置页会写的命名空间」的 `config:`。`--no-marketplace` 不动社区插件市场；`--check` 只报告不写；`--remove` 收回受管行、我们生成的包、依赖项、选中项，以及它写进每个 profile 自己 patch 文件里的模型目录块（见下面模型目录那一节）。

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
`home.mjs` / `provision.mjs` / `install.mjs` / `dsharness.mjs` / `dsharness-ui.js` 与上层文件**逐字节相同**，
`cordis.patch.yml` 是同一份行、**只改写一行** —— `platformOrigin` 烧成本次构建的地址，因为装好
的机器上没有 `DSH_PLATFORM_ORIGIN`，而加载器拒绝任何 `.env` 提供 `DSH_` 前缀的名字
（`packages/boot/app-boot/src/index.ts:157`）。合并后的两个半边都在清单里，因为 `provision.mjs` 是
按自己所在目录解析 `plugin.entry` / `plugin.clientEntry` 的：只带一个半边的载荷放不出这个包。
`buildDeployPayload` 还会**删掉本轮不再投放的载荷文件** —— NSIS 是整目录嵌入（每个模块一条 `File`），
所以留下一个旧副本不是无害的，它会随包发货。没有这一步清理，被替换掉的四个插件源文件会一直留在
`windows/deploy/` 里并被继续嵌入。副本一漂移或残留旧文件，`deploy-payload.test.mjs` 就报红。

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

本产品只发**一个**组合包 `dsharness`，而且它**默认启用、不可开关**。两条都由**打包形态**决定，而不是由某条 patch 行说什么决定。

官方插件页（`packages/client/ui-plugin-manager`）列的是**包**（`pluginManager/listBundles`），并按两个包级标志分组：

| 分组 | 条件 |
|------|------|
| 已安装 | `installed \|\| !optional` |
| 官方 | `optional && !installed` |

一行从 patch 文件直接插进去的行不属于任何包，页面就不会提它。合并之前的真机桌面 Host 上实测：那一行**能被 `listPlugins` 定位**（`patchId: dsharness-host-auth`），而 `listBundles` 完全不知道它 —— 页面上**没有卡片可切**，而这正是需求本身。`optional` 也不是部署能设的，它来自启动器自己的 `OPTIONAL_BUNDLES` 白名单。

真正可由部署决定、也是 `provision.mjs` 唯一在写的，是这一对：

- **`installed`** —— profile 的 `node_modules` 里有一个真的组合包，并写进 profile manifest 的 `dependencies`；
- **`enabled`** —— `dsh.profile.bundles` 里有没有它。列在那里才会加载；只是装了不算。

于是**默认启用**＝**装了且选中**。社区插件市场（`dshmarket`）也这样 provision，并且在插件页里仍可开关；不可开关的是本产品自带的这一个包。

`node platform/install.mjs` 之后，用真 `boot()` + 真 `PluginManager` 在真机桌面 Host 上实测：

```text
enabled: true   installed: true   removable: false   readOnlyReason: 'management-required'
rows: [dsharness]        overrides: []
```

`--dump-config` 组合出来的行与那个包自己的 patch 声明完全一致。通道本身对正确密钥回 200，错密钥/无密钥仍是 401 —— `check-host-auth.mjs` 对真机 Host 覆盖了这一段。

provision 写的是**三样**东西，不是一样：那个包与两个 manifest 标志，外加一个受管的**模型目录块**，写进 profile 自己的 `cordis.patch.yml` —— 也就是「设置 › 模型」页读的那一层（见下面那一节）。`provisionProfile(...).catalog` 报告它写了哪些 id，`--remove` 会把这块连同其它一切一起收回。

#### 一行、三个子插件、分段配置

`apply()` 把三个宿主组件用 `ctx.plugin(gatewayComponent, config.gateway)` 及其两个兄弟挂成 Cordis **子插件**，所以 Loader 里只有一行（`id: dsharness`）、插件页上只有一张卡；第四个组件（状态面板）由浏览器半边画在同一张卡片里，不额外占一行。生成的 patch 里每个组件一段配置：

```yaml
gateway:  { token: !!js process.env.DSH_AUTH_TOKEN ?? '', cookieName: dsharness_auth, loginPage: true }
modelKey: {}
update: {}
```

缺段就是各组件自己的默认值，所以任何一段都可以不写。只有 `gateway` 有真正的部署期输入（密钥），另外两段今天都是空的。

#### 默认态绝不写进任何 patch 层

看起来更省事的另一条路 —— 从 patch 文件插入我们自己的行，再在某处写 `disabled: true` —— 是死路，而且值得记下来，因为它看起来是对的。`readProfilePatches`（`packages/boot/app-boot/src/profile-context.ts:63`）的层序是 *bundle 层 → profile 层 → `$DSH_HOME` 层 → overlay*，后应用的层按行 id 覆盖前面的。用真的 `applyEntryPatches` 实测：

```text
[profile(disabled=false), home(insert + disabled=true)] → disabled=true
[home(insert, neutral),   profile(disabled=true)]       → disabled=true
[home(insert, neutral),   profile(disabled=false)]      → disabled=false
```

即：写进我们受管块的默认态会成为最后一句话，插件页的开关**永远打不开**。让包自己拥有那一行就把这个问题整个消掉：`platform/cordis.patch.yml` 现在只在原处留一段说明，而 `install.test.mjs` 断言那一层**根本不提**任何自有行。它唯独允许、也要求存在的 `disabled:` 是两条**上游** route —— 本部署必须关掉，而它们都不归插件页的开关管。让本产品这个包的这一行**关不掉**的是它自己 patch 里的另一行，下一节说。

#### 本产品这个组合包不能关闭、也不能卸载

用户要求的是一个插件包多个组件、并且**不可以关闭**，整个机制就是该包生成的 patch 里多插一行 —— 与插入产品行的是同一份 patch：

```yaml
- insert:
    - id: dsharness
      name: ./index.mjs
    - name: '@deepseek-ai/dsh-plugin-manager'
      disabled: true
```

`PluginManager.protectsManager(name)`（`packages/boot/plugin-manager/src/index.ts:763-773`）在**该包 patch 插入的任意一行**命中那个文件的 `protectedModules`（`:66-76`）时为真，而 `@deepseek-ai/dsh-plugin-manager` 正是其中之一。两个动作都失败，用真 `boot()` + 真 `PluginManager` 实测：

```text
setBundleEnabled('dsharness', false) → application: 'failed', changed: false, error: { code: 'management-required' }
removeBundle('dsharness')            → application: 'failed', changed: false, error: { code: 'not-removable' }
```

两个细节让这行影子行既看不见也不花钱：

- **它没有 `id`。** `declaredRows`（`:647+`）只收 `id` 是字符串的行，所以它永远进不了卡片的行列表 —— 用户看到的是一行，不是两行。
- **`disabled: true`。** Loader 对 disabled 行**在 `import()` 之前就返回**（`vendor/loader/src/config/entry.ts:136-139`），所以那个模块名根本不会被解析，也不会多出一份依赖。

判断条件的后半段 `` `include:${row.id}` === this.ownerEntryId `` 是死代码：`ownerEntryId`（`:207`）就是字面量 `'include'`，任何行 id 都拼不出它。整个保护只靠模块名那一半。

#### 旧版本 provision 过的 profile 会回收被替换的包

旧构建会 provision 四个各自独立的组合包 —— `dsharness-model-key`、`dsharness-update`、`dsharness-update-ui`、`dsharness-host-auth` —— 所以这样的 profile 在 manifest 的 `dependencies` 与 `dsh.profile.bundles` 里仍然写着它们，`node_modules` 下也还留着目录。留在那儿它们会继续跑：各自的行走会挂起第二个网关、第二条模型 Key 投递循环、以及**第二套**更新面 —— 正是合并要消掉的重复。

`provision.mjs` 显式且幂等地回收它们。名单是 `REPLACED_PLUGINS`；`planProvisioning(...).retired` 与 `provisionProfile(...).retired` 报告这件事。回收会移除依赖项、移除选中项、并在放好替代品**之前**删掉目录 —— 依赖项必须一起移除，因为 manifest 不声明的包会在 pnpm 下次运行时被剪掉，只删目录是留不住的。这是「选中项只增不减」的唯一一处成文例外。

#### 一处值得知道的不对称

pnpm 会把指向 profile 之外的 `link:` 目标剪掉，所以生成的包是**真目录**，放在 `<profile>/node_modules` 里，依赖记成 `file:./node_modules/<name>`（`pluginInstallSpec`）。这样也不需要符号链接权限 —— 在 Windows 上那意味着得开开发者模式。

我们自己的包直接落盘、完全不需要包管理器，所以这个组合包在从没连过 npm 的机器上也能用；只有 `dshmarket` 走 pnpm。插件市场装失败会带上精确的手工命令如实报告，绝不会让部署失败。

#### 已发出的连接 cookie 会比包装本身活得久

在这个包还能开关时实测：`setBundleEnabled` 关掉之后，`listBundles` 说 `enabled: false`、`pluginInventory/list` 里也没有那一行了 —— 但带**正确密钥**的请求**仍然 200**（无密钥与错密钥仍是 401，所以不是恒真放行）。清理确实恢复了 `connection` 上的方法引用，而**已经换取过的连接 cookie 仍是有效的短时凭证**：官方并不会在每次请求上复查它由谁铸的。这要动上游的 `connection` 才能修。对这一个包，插件页已经走不到那个状态，且默认一直是启用；要立刻作废已发出的 cookie 就换 `DSH_AUTH_TOKEN` 并重启：那些 cookie 是用连接层密钥签的。

### 服务端到服务端访问官方 `/api`（`dsharness.mjs` 的网关组件）

官方 `/api` 用的是一个只有拿着 `dsh web` 启动令牌的浏览器才换得到的 cookie（`packages/client/connection/src/browser-auth.ts`）。**没有浏览器**的调用方 —— 另一个产品的服务端、脚本、小程序后端 —— 拿不到它，也不该为此去跑一个浏览器。

`dsharness.mjs` 的网关组件增加一种落在同一处的凭据：正确的共享密钥（`Authorization: Bearer <密钥>`，或本组件发的 cookie）会被换算成**只服务这一次请求**的连接 cookie，追加到请求上。官方那两层校验照常执行，只是它们看到的请求已经满足了要求。

| 调用方 | 怎么进去 |
|--------|----------|
| 不带凭证 | 被官方连接层 401 —— 本组件自己不放开任何东西 |
| 错密钥 / 过短密钥 | 同上，401 |
| `Authorization: Bearer <密钥>` | 放行；覆盖 unary RPC **以及** `/api/remote.mux` 升级 |
| 局域网里的浏览器 | `/dsharness/auth` 用密钥换 cookie，之后 `/` 与 `/api` 都能用 |
| 密钥未配置 | 首次运行时生成一把并持久化，于是通道能用，也能从 `/dsharness/gateway` 读到 |

### 端口与密钥必须能被读到（`/dsharness/gateway`）

用户报的是「无法对接」，而原因是结构性的：端口与共享密钥只活在进程里。`dsh web` 只在**启动那一次**把 `?token=` 打到终端，而桌面端连终端都没有。所以网关组件把这两样都渲染出来：

| 面 | 给什么 |
|----|--------|
| `GET /dsharness/gateway` | HTML 页：端口、本机地址、共享密钥、cookie 名、登录页，以及一个复制按钮 |
| `GET /dsharness/gateway.json` | 同一份事实的 JSON，给调用方与验收脚本用 |
| `GET /dsharness/secret.json` | 那两个值本身，按需取 —— 面板上两个复制按钮读的就是它（见组件状态面板那一节） |

三点是刻意的：

- **只在回环上回**。非回环请求拿到的是说明页，JSON 面直接 `403`。密钥只应在运行 DSH 的这台机器上可读。
- **端口取自本次请求的 authority**，而不是另存一份配置：`webServer.port` 在配置端口为 `0` 时只有监听之后才知道，而 authority 是调用方**实际打到**的那个 `host:port`，一定是对的。
- **不带 `?token=`**。`dsh web` 打印的那个是**连接层**的一次性凭据，本插件既拿不到也不需要；把它与共享密钥混在一个 URL 里，只会让「哪个是哪个」永远说不清。

密钥未配置（或太短）时现在改成**生成并持久化**，而不是让插件整体不挂载：部署行总是给出 `token` 键，所以「未配置」才是默认态，而一条会自己关掉的通道没有任何东西可显示。生成的值写进凭据层的 `DSHARNESS_AUTH_TOKEN`，因此跨重启稳定 —— 每次启动都变的密钥，是用户永远抄不下来的密钥。要关掉这条通道只有 `enabled: false`。

几个面都注册成 `kind: 'exact'`，并且在 `authorizeIndex` 上额外放行：`webServer.match()` 先查 exact 表，但 `frontend-static` 会把 index 请求交给 `authorizeIndex`，而它只认 `GET /` —— 不放行的话这几页能不能读到就取决于路由注册谁先赢。`/dsharness/secret.json` 以同样方式注册、也在同一个 `PUBLIC_PATHS` 名单里；那份放行名单只决定「请求能不能到达 handler」，拒绝外机调用方的仍然是每个 handler 里的回环门。


网关组件包装的是 `connection.requestRejection` 与 `connection.authorizeIndex`，而不是注册路由 —— 因为 `/api` 已经被占了：`webServer.register` 对同一个 `(kind, path)` 重复注册会抛错，而升级握手那条路由由 `api-gateway` 单独注册。两处准入判断最终都汇到这两个服务方法上，所以**一处包装覆盖全部载体**。

它**不是第二套鉴权**：Host/Origin 围栏与连接 cookie 校验仍然做决定，没有新增信任主体，比较用 `timingSafeEqual`。整个组合包都是零依赖 `.mjs`（只 import `node:` 内置模块），因为本层没有 `node_modules`：每个组件都按普通对象读配置，网关那个组件把连接凭据的键直接写字面量（`client-connection/browser-session`，也就是 `credentialKey(scope, id)` 的产物）。

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

`cordis.patch.yml` 只改上游**已经声明**的行，而且只改设置页不写的那些。补丁是**整块替换** `config`，所以每次覆盖都要把该行拥有的键全部重述一遍。这里**不插入**任何自有插件 —— 它改成组合包发布，理由见上文。

| 行 | 上游默认 | 本部署 |
|----|----------|--------|
| `deepseek-account` → `platformOrigin` | `https://platform.deepseek.com` | 本产品 server（`PUBLIC_BASE_URL`） |
| `deepseek-account` → `desktopPlatform` | `null` | 保留原表达式 |
| `deepseek-account` → `allowLoopbackHttp` | `false` | 除非 `DSH_PLATFORM_ALLOW_LOOPBACK_HTTP=0`，否则打开 |
| `llm-deepseek` → `disabled` | 挂载 | `true` —— 内置的那张 DeepSeek 卡片，见下 |
| `llm-deepseek-account` → `disabled` | 挂载 | `true` —— 它的 401 会把用户登出，见下 |

`llm-pi-ai` 与 `agent-default-model` **已经不在这张表里**，而这正是下一节的重点：两者都是「设置 › 模型」会写的命名空间，而在这层给它们写 `config:` 不是给默认值，是让设置页**每一次写入都被拒**。

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

#### home 层给「可写命名空间」写 `config:` 就是把设置页锁死

上面那两行原先**两个**补丁层都写 —— profile 自己那份和这份文件。那是个 bug，用户就是这么报的：

> home 层占了 llm-pi-ai 这个 id，导致无法添加自定义模型 api 了，给我优化一下

`readProfilePatches`（`packages/boot/app-boot/src/profile-context.ts:63-73`）把 home 层排在 profile 层**之后**，而 `ConfigEditor.edit()`（`packages/boot/config-editor/src/index.ts:136-141`）只在「重新合成后的生效配置」等于「即将写入的值」时才接受写入。所以 home 层一旦给设置页会写的命名空间写了 `config:`，那一项就再也改不动了，每次写入都抛：

```text
Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay
```

用真 `composeEntries` 正反各测一次：home 行在时该命名空间合成成 `providers: ["dsharness-relay"]`，写入被拒；把 home 行去掉后合成成 `["dsharness-relay","my-custom-api"]`，写入被接受。`agent-default-model` 有同一个缺陷，出口也一样 —— `AgentDefaultModelConfig.saveSelection()`（`packages/core/agent-default-model/src/index.ts:82-94`）走的是同一个 `configEditor.edit`，那是编辑器里选模型保存的地方 —— 所以它也一起离开了这一层。

由此得出的规矩，也是 `install.test.mjs` 现在断言的东西：**本层只允许给「设置页不拥有」的行写 `config:`**。今天只有 `deepseek-account`（登录面自己那一行）与 `llm-deepseek-account`（停用，并把 `config` 显式清空）；`llm-pi-ai` 与 `agent-default-model` 必须保持「设置 › 模型」可写。

从已发布的 `.20261008.2` 升上来的机器会在下一次 provision 时**自愈**：把那个版本的 home 文件拷进临时 home 再跑新的 `install.mjs`，受管行从 `[deepseek-account, llm-pi-ai, agent-default-model, llm-deepseek-account]` 变成 `[deepseek-account, llm-deepseek, llm-deepseek-account]`。

#### 内置的 DeepSeek 卡片默认关掉，官方模型改成自己添加

> 原本自带的deepseek这个模型配置可以去掉，添加模型供应商时可以选择添加官方的模型。但是默认的可以去掉，默认的只有码农ai这一个模型服务

那张卡片就是 `deepseek-official` 这条 route，由 `llm-deepseek` 这一行注册（`packages/llm/llm-deepseek-api-key/src/index.ts:15,36-38`），`settingsPath: []`。空的 `settingsPath` 在模型页的定义里「永远已配置」（`ui-settings-models/src/client/store.ts:205-206`），于是它永远出现在卡片列表（`ModelsSection.tsx:341,398`），而且既不可 add（`:343-346`）也不可 remove（`:208-210`）。也就是说：**没有任何「不改上游」的口子能在保留这条 route 的同时把它藏起来**；唯一的杠杆就是在部署层关掉它，本文件正是这么做的 —— 与旁边那条 `llm-deepseek-account` 停用同一个动作。

关掉它**不等于**官方模型不可用，官方模型改走「添加提供商」那条路：`llm-pi-ai` 把已装 pi-ai 目录里的**每一个** provider 都声明成可配置项（`llm-pi-ai/src/index.ts:241-250` 加它的 `directoryEntries`），而那个目录里有 `deepseek`（`https://api.deepseek.com`，模型 `deepseek-flash`＝DeepSeek V4.1 Flash 与 `deepseek-v4-pro`）。未配置的目录项正是「添加模型提供商 › 第三方模型提供商」列出的东西。实测：目录下拉里有 41 个选项，其中包含 `deepseek`；添加后提示 `已保存 deepseek。`，编辑器里的模型选择器随即出现一条可用 route。

只影响 llm 这一条 route：`web-search-deepseek` 注册进的是自己的 `ctx.web` 身份（`web-search-deepseek/src/provider.ts:27`），从不碰 `ctx.llm`，所以联网搜索那家的 DeepSeek provider 照旧。想把内置卡片要回来的逃生口就是**删掉本文件里的 `llm-deepseek` 那一行** —— 它不带 `config`，删掉即恢复上游行为，别的什么都不用动。

### 「设置 › 模型」页的目录读的是 profile 自己的 patch 层

用户口径：模型目录要默认配好，且输入类型要支持文本和图片：

> 码农ai模型配置中的模型目录要默认给我配置好deepseek-v4.1-flash，且输入类型要支持文本和图片

运行时本来就是对的 —— 上面那些行由 `readProfilePatches`（`packages/boot/app-boot/src/profile-context.ts:63`）按 *bundle 层 → profile patch → `$DSH_HOME/cordis.patch.yml` → overlay* 组合、**后者覆盖前者** —— 但页面上写的是「正在使用适配器默认模型」，一个模型都没有。原因是**页面读的层与运行时不是同一组**：

| 读方 | 它组合哪些层 | 同 id 谁赢 |
|------|--------------|------------|
| 运行时（`readProfilePatches`） | bundle 层 → profile patch → home patch → overlay | **后者** |
| 设置 › 模型（`ConfigEditor.configuration()`，`packages/boot/config-editor/src/index.ts:49-70`） | 只有 bundle 层 + profile patch | **前者** |

「同 id 取第一行」正是 bundle 层覆盖修不了这个页面的原因：每个 profile 的 bundle 列表都以 `@deepseek-ai/dsh-base` 开头，而那个 bundle 自己就声明了 `- id: llm-pi-ai`（`packages/bundle/base/cordis.patch.yml:127`）且没有 `providers`，于是卡片继承的就是这条空行。而写在 **profile 自己那份** patch 里的行**确实**能赢（它会成为卡片的 override，渲染成「已自定义模型目录」+「恢复默认模型」），所以目录写在那儿。

home 层同样不是它的选项，而且这是**第二个独立理由**：home 层排在 profile 层之后，给可写命名空间写 `config:` 会让设置页的每一次写入都被拒（就是上面说的那把锁）。两个约束指向同一层，所以目录只有一个落点：

`provision.mjs` 把一个受管块写进**每个 profile 自己的 `cordis.patch.yml`**：

```yaml
# >>> dsharness model catalog
# Written by platform/provision.mjs: the deployment model catalog the 设置 › 模型 page
# reads as this profile's own override. Rows are edited from that page; everything
# outside this block is left exactly as it was.
- id: llm-pi-ai
  config:
    providers:
      dsharness-relay:
        displayName: '码农AI'
        api: 'openai-completions'
        baseURL: 'https://ai.czmanong.com/v1'
        apiKeyEnv: 'DSHARNESS_MODEL_KEY'
        models:
          - id: 'deepseek-v4.1-flash'
            name: 'DeepSeek V4.1 Flash'
            contextWindow: 262144
            maxTokens: 32768
            input: ['text', 'image']
- id: agent-default-model
  config:
    provider: 'dsharness-relay'
    model: 'deepseek-v4.1-flash'
# <<< dsharness model catalog
```

`MODEL_CATALOG_ROWS` 就是这一对；`ensureProfileCatalog` 负责写，`missingCatalogRows` 决定要不要写，`removeProfileCatalog` 收回（`install.mjs --remove` 会调它），`provisionProfile` 把写进去的内容报成 `catalog`。**`platform/cordis.patch.yml` 两行都不带** —— 刻意如此，理由就是上面那把锁；熟悉 `install.mjs` 的读者本来会以为目录在那里。

它**从不覆盖**，三条规则都在 `missingCatalogRows` 里：

- profile 在受管块**之外**已经有自己的 `llm-pi-ai` 行 —— 那份目录是人或设置页的，整个文件保持逐字节不变；
- 受管块已经存在 —— 重写它会把设置页就地做的编辑抹掉；
- 把 profile 与 home 层组合起来得到的不是本部署的值 —— 运维替换过那一行，此时再写 profile 行会**悄悄接管**运行时，所以让位不写。

因此在已 provision 过的 profile 上重跑，一个字节都不写。

对运行时来说这**什么都没改**：不管有没有这个块、home 层有没有一份副本，`--dump-config` 打印的 `llm-pi-ai` 与 `agent-default-model` 两行都相同 —— 它们现在从 `profiles/<name>/cordis.patch.yml` 组合出来而不是从 `$DSH_HOME/cordis.patch.yml`，差别只在 dump 为每层输出的 `# == … patched by …` 溯源注释。写它改的是**页面显示什么、还能存什么**，不是模型实际跑什么。在真 `dsh web` home 上用真 Chromium 实测（干净 profile）：卡片显示「已自定义模型目录」+「恢复默认模型」，`模型 ID 1` 是 `deepseek-v4.1-flash`，`显示名称 1` 是 `DeepSeek V4.1 Flash`，上下文窗口 `262144`，最大输出 `32768` token，且**输入类型的「文本」与「图片」两个勾选框都是选中状态**。

同一次运行也证明了那把锁没了：「设置 › 模型」只列出 `码农AI`；用「添加模型提供商 › 自定义模型 API」填 Provider ID `lead-custom-api`、一个 base URL、一个 key 和一个模型后，「创建提供商」可用，随后卡片列表变成 `["码农AI","lead-custom-api"]`，写入落在 `profiles/web/cordis.patch.yml` 的 `llm-pi-ai.providers.lead-custom-api` 下。

### 为什么要把「账号直连推理」这条 route 关掉

`llm-deepseek-account` 用 `account.resolveToken(baseURL)` 拿凭证，再把拿到的东西当 `x-dsh-auth-token` 发出去（`packages/llm/llm-deepseek-account/src/index.ts:20-25`）。两条事实让它在本产品下走不通，第二条还是**破坏性的**：

1. `resolveToken` 只在请求 origin 等于 `inferenceOrigin` 时才交出 grant（`packages/credentials/deepseek-account-platform/src/index.ts:385-401`），而本部署的推理 origin 是网关，网关**根本不读这个头**。实测（有效 key）：`x-dsh-auth-token` → 401，`x-api-key` → 200。
2. 这条 route 上的 401 由 `onRequestError` 处理，它会调 `rejectToken`（`.../llm-deepseek-account/src/index.ts:26-36`）。而 `rejectToken` → `expireCredential` 会**删掉本地 grant** 并发 `deepseek-account/signed-out`（`.../deepseek-account-platform/src/index.ts:322-344`）。也就是说**一次请求失败就把用户登出** —— 这正是「登录 → 开新会话 → 回到登录页」。

停用的就这两条 LLM route：`llm-deepseek`（内置的 DeepSeek 卡片，见上）与这条账号直连 route。`deepseek-account`（登录、余额、赠金、退登）必须留着，否则整个官方账号面消失；`web-search-deepseek` 不受影响，因为它注册的是 `ctx.web` 而不是 `ctx.llm`。

**这是已知的一条登出路径，不是全部解释。** 其余能让同一份凭据点失效的路径：产品自己那几个账号端点回 401 / `code: 40003`（`server/src/lib/dsh-account.ts:84-86`；退登或管理端停用会提升 `tokenVersion`，从而复现）；以及启动时的 `issuer-mismatch`，它连一次请求都不发就丢掉 grant（`.../deepseek-account-platform/src/index.ts:167-176`），Host 日志里会留 `stored grant discarded`。排查「被踢回登录」要分清是这三条里的哪一条，不能默认是这一条。

### key 缺的那一步：投递（`dsharness.mjs` 的模型 Key 组件）

产品 server 一直在 `GET /api/account/model-access` 回该用户的网关 key，而本 fork 里**从来没有东西读它**：在 `client/` 里搜 `model-access`、`apiKeyCreated`、`dshModelKey` 是 **0 处命中**。于是上面那条 route 没有任何凭据，每次请求都以 `MISSING_CREDENTIAL` 失败。

`dsharness.mjs` 的模型 Key 组件就是那个消费者。它在账户状态变化时向产品 server 要 key，写进凭据层的 `DSHARNESS_MODEL_KEY`（正是 `llm-pi-ai` 的 `apiKeyEnv` 指的那个引用），并在退登或拿到未授权答复时删掉。传输失败**保留**已写入的 key —— 一个 `503` 说明不了网关 key 还有没有效。

### 检查更新（`dsharness.mjs` 的更新组件）

官方 updater 需要 `app-update.yml` 在应用的 resources 旁边，而未签名构建永远不会有它：`publish: null`（`apps/desktop/scripts/electron-builder-config.mjs:249`）让 electron-builder 不生成那个文件（`app-builder-lib/out/publish/PublishManager.js:87-90`），而 `update-coordinator.ts:54` 正要求它、`:185` 缺它就抛。安装器自己投放一份（`platform/windows/app-update.yml`）就成立，因为 `NsisUpdater.verifySignature()` 在 `publisherName` 缺席时返回 null —— 即**不做任何校验就接受**（`electron-updater/out/NsisUpdater.js:84-100`）。那个键是**故意不写**的：写了就会去跑真 Authenticode 校验，每次更新都以 `ERR_UPDATER_INVALID_SIGNATURE` 失败。

所以 `dsharness.mjs` 的更新组件自己给答案：`/dsharness/update`（HTML）与 `/dsharness/update.json`，拿已装版本与产品 server 在 `GET /api/config/version` 发布的版本比。它只**报告**，不下载也不安装。

已装版本来自 `<DSH_HOME>/dsharness-install.json`，由载荷在安装期写下。安装器把 NSIS 的 `${VERSION}` 传进去 —— 那是 electron-builder 按打包版本定义的，而**未签名构建里只有安装器知道用户装的是哪一版**。

⚠️ 两份发布记录是**两个不同的存储**，两边都必须写：`wb_client_release`（Platform，官网渲染它）与产品 server 的 `desktopRelease`（客户端读它）。实测过的漂移就是 `register-client-release.mjs` 现在两边都写的原因：官网写着 `0.2.1-alpha.1.20261007.2`，而 `/api/config/version` 还在回 `0.2.0`，于是刚装好的客户端被告知「已是最新」。

### 应用内的检查更新入口（浏览器半边 `dsharness-ui.js`）

上面那一面回答的是「这是哪个版本」，它不是用户会去的地方。壳里其实已经暴露了**真正的应用内更新 UI** —— `dshDesktop.updates.open()`（`apps/desktop/src/preload-app.ts:49-57`，契约在 `ipc.ts:82-86`）会调 `main.ts` 的 `openUpdatePrompt()` 弹出原生的检查 / 下载 / 安装对话框 —— 但**出厂界面里没有任何东西调它**：唯一知道更新状态的那个组件（`DesktopUpdateIndicator.tsx:64`）在 idle 时什么都不渲染。所以在用户拿到的产品里，这个动作根本没有可点的路径；在 `packages/` 与 `apps/` 下搜 `updates.open`，命中的只有 preload、它的测试和那个指示器，没有任何入口。

这就是这一层必须是**插件**而不是改上游的原因：`settings.general.item` 是上游公开的扩展位（声明在 `packages/client/ui-settings/src/client/contract/slots.ts:92`），一个注册者只需要一次 `slots.register`，而本 fork 的规矩是 `packages/` 与 `apps/` 一个字节都不碰。所以 `dsharness-ui.js` 往「设置 › 通用」加一行，order 90（夹在 `developer-tools` 与 `current-version` 之间），按钮调 `globalThis.dshDesktop?.updates?.open()`，状态行把订阅到的 `status()` phase 说成人话。它和面板显示的是**同一个**更新组件；没有第二个更新插件，也没有重复文案。

三个细节是刻意的，且都有 `dsharness-ui.test.mjs` 的断言：

- **浏览器半边是经典脚本，所以这个组合包是两个文件。** 客户端模块系统用 `document.createElement('script')` 加载 bundle（`packages/client/modules/src/client/system.ts:16-29`），并按包名对账注册 `id` —— 所以 `dsharness-ui.js` 只能通过 `window.__ModuleLoader__.load(...)` 注册自己，不可能是 ESM 插件；而 Node 那边 import 的是 bundle 行的 ESM 入口。因此宿主半边是一个**真插件** `dsharness.mjs`，它把三个宿主组件挂成子插件；`provision.mjs` 的 `clientEntry` 字段把浏览器半拷成包内的 `client.js` —— 一个包要同时是 bundle 行**和**被服务的浏览器 bundle，两者都需要。注册 `id` 必须逐字符等于包名 `dsharness`。
- **这一行不需要任何上下文。** `settings.general.item` 的 owner props 是空的，而 `dsh-client-locale` 不在客户端 bundle 可 `require` 的 9 个基线模块里（`packages/client/web/src/platform.ts`），所以文案是内置的，按 `navigator.language`（退回 `<html lang>`）选中英。服务缺席时不会有任何东西消失 —— 这条路径上压根没有服务。
- **浏览器里降级而不是报错。** 没有 `dshDesktop`（纯 `dsh web` profile）时这一行会说明原因并禁用按钮。

`platform/windows/app-update.yml` 是同一功能的另一半，而且**刻意走两条路**：NSIS include 把它拷进 `$INSTDIR\resources`，让打包后的 updater 有 feed 可读；`windows/update-descriptor.mjs` 同时把它加进 electron-builder 的 `extraResources`，让它**在安装器跑之前就已经在包里**。第二条路存在的理由是实测出来的顺序问题：更新安装是静默 + 强启，assisted 安装器会在安装段结束时先重启应用（`app-builder-lib/templates/nsis/installSection.nsh:105-109`）—— 用 NSIS 顺序探针实测：重启那一刻描述文件还不存在，`.onInstSuccess` 紧接着才写入。只靠 include 的话，刚重启的那个实例会以 `enabled() === false`（`update-coordinator.ts:54`）做启动检查并报一次失败，之后重试才成功。所以 include 里的 `File` 是覆盖一份相同副本，而不是创造它。

那个文件里的缓存目录名是与**安装器**的约定，不是随便起的标签：`updaterCacheDirName: '@deepseek-aidsh-desktop-updater'` 必须等于安装器算出来的值，因为卸载器删除的正是 `%LOCALAPPDATA%\<该名>`（`apps/desktop/installer/uninstall.nsh:34`），而 updater 会把约 292 MB 的未完成下载留在 `<该名>\pending`。该值来自 `appInfo.updaterCacheDirName`（`app-builder-lib/out/appInfo.js:126-128`，即 `sanitizedName.toLowerCase() + '-updater'`，`sanitizeFileName` 会保留 `@`），构建把它原样记成 `!define DSH_UPDATER_CACHE_NAME "@deepseek-aidsh-desktop-updater"` —— 在构建产物 `builder-debug.yml` 里实测得到。名字不一致不会让更新坏掉，只会在卸载时**静默留下**那笔下载，所以 `deploy-payload.test.mjs` 把它钉住了。引号是必需的：YAML 把行首的 `@` 当保留指示符。

### 组件状态面板（浏览器半边 `dsharness-ui.js`）

这里有两个来自用户的口径：

> 可以把…这些插件合并成码农 DSH 插件，其中包了多个组件。该插件虽然是已安装的自定义插件，但是是不可以关闭的
> 应该都是不能改的…插件的组件中只是显示组件状态，而不需要显示key的信息

第一条是「一个包四个组件、而不是四个包」的由来；第二条是「面板只读」的由来。合并同时消掉了重复：设置里那一行「检查更新」与面板里的更新行现在是同一个更新组件，不再是两个插件。

面板占的是插件页上**这个包自己的卡片**里的 `plugins.bundle.config` 槽位（按 `key` 注册，必须等于包名 `dsharness`），所以不用多一张卡、也不用多一行 Loader 行就能看到组件状态。它画四行，前两行各自带一个复制按钮（见下）：

| 组件 | 显示的状态 | 显示的事实 |
|------|------------|------------|
| 本机网关 | 运行中 / 未启用 | 监听端口、本机地址、共享密钥配没配，**以及一个复制密钥的按钮** |
| 模型 Key | 已同步 / 未同步 / 未登录 | 凭据引用名（`DSHARNESS_MODEL_KEY`）、它有没有值，**以及一个复制 key 的按钮** |
| 检查更新 | 已是最新 / 有新版本 / 尚未检查 / 查询失败 | 当前版本、最新版本、实时 phase，以及打开桌面端更新对话框的按钮 |
| 账号与费用 | 已登录 / 未登录 | 用户名（或掩码后的联系方式），以及每个钱包的余额 |

数据来自网关组件注册的只读面 `GET /dsharness/status.json`。字段恰好是：

```text
{ok, port, address, tokenConfigured, cookieName, loginPath, gatewayPath,
 version:{current,latest,updateAvailable},
 modelKey:{ref,configured},
 account:{signedIn,name,contact,balance:[{currency,balance}]},
 checkedAt}
```

两点是刻意的：

- **它不含任何凭据。** `tokenConfigured` 与 `modelKey.configured` 是布尔，从不回值；没有任何字段装着共享密钥或模型 Key。取一个值是**另一次按需请求**（`/dsharness/secret.json`，见下），而会显示密钥的面是 `/dsharness/gateway`、`/dsharness/gateway.json` 与这一面 —— 三个都只在回环上回。
- **只在回环上、且只读。** 非回环请求得到 `403`；非 `GET` 得到 `405`。面板里没有任何可写的东西：没有输入框、没有开关、没有配置表单 —— 面板只渲染状态槽，其它 view 只回一行 summary。版本段有 60 秒 TTL 缓存，并与更新组件共用同一个 origin，所以面板与更新页不会对「最新版本」各说一套。

浏览器半边挂载时取一次状态面，之后每 10 秒轮询一次；拿到 403、超时或响应体不是对象时降级成「状态暂时读不到」，其余行照常渲染，绝不抛错。

#### 两个复制按钮，以及一面只有点击才会走到的取值面

用户口径：

> 码农dsh插件中的本机网关一行右侧要有复制密钥的按钮，点击之后复制共享密钥
> 模型key也是，要有复制key的按钮

复制凭据是唯一一个「目的就是把值搬出去」的动作，而这改变了该由哪一面来服务它。`status.json` 不行：面板每 10 秒轮询它一次，值放进去就等于**按定时器**把它发给每一个回环客户端。所以值有自己的一面，且**只在按按钮那一刻**读：

| 面 | 它给什么 | 读取节奏 |
|----|----------|----------|
| `GET /dsharness/status.json` | 只有状态 —— 布尔、版本、端口 | 每 10 秒轮询 |
| `GET /dsharness/secret.json` | `{ok, gateway:{token}, modelKey:{ref,value}}` | 点一下才取，其它任何时候都不取 |

`/dsharness/secret.json`（`SECRET_JSON_PATH`）与其它面并列注册为 `kind: 'exact'`，并进 `PUBLIC_PATHS`，所以门槛完全一样：回环 `GET` 得 `200`，任何非回环得 `403`，非 `GET` 得 `405`。`modelKey.value` 来自 `credentials.resolve('DSHARNESS_MODEL_KEY').value`，并降级成 `null` —— 凭据服务缺席、`resolve` 抛错、或解析不出东西，三种情况都只让这一个字段为空，而不是让请求失败，所以「没有凭据」表现为一次复制失败而不是一个 500。

因此 `status.json` 那组**钉住的字段一个都没变**，依旧不含任何凭据；`dsharness.test.mjs` 既逐字段断言它，也断言取值面自己的回环门。

浏览器半边里两个按钮在「本机网关」与「模型 Key」两行的右侧，两行原有的状态文字都保留。点击时取一次取值面、调 `navigator.clipboard.writeText`，然后在按钮旁显示「已复制」或「复制失败」两秒，之后回到空闲。三个性质是刻意的，且都有 `dsharness-ui.test.mjs` 的断言：

- **值从不渲染。** 它从响应直接进剪贴板；不进 React 状态、不进 props、不进渲染树。只有结果（空闲 / 已复制 / 失败）是状态，所以渲染出来的面板**即使出错也漏不出密钥**。
- **那一行没东西可复制时按钮是禁用的** —— 网关看 `tokenConfigured !== true`，模型 Key 看 `modelKey.configured !== true`。
- **普通浏览器里也能复制。** 它只需要 `fetch` 与 `navigator.clipboard`，不依赖更新按钮需要的 `dshDesktop` 桥。没有 `navigator.clipboard` 的非安全上下文被当作**正常环境**处理：那一下显示「复制失败」。

在一台装好本产品载荷、并设了 `DSHARNESS_MODEL_KEY` 的真 `dsh web` 上，用真 Chromium 实测：两个按钮都可用；两次点击都把正确的值放进了**真实剪贴板**（30 字符的网关密钥与 26 字符的模型 key，各自与取值面返回的一致）；两行都显示「已复制」；两个值都没有出现在页面文本里；而 `status.json` 依旧恰好是 `["account","address","checkedAt","cookieName","gatewayPath","loginPath","modelKey","ok","port","tokenConfigured","version"]`，里面没有任何 token。

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
