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
  cordis.patch.yml     deployment rows: point the official login at this product
  install.mjs          merge the above into $DSH_HOME/cordis.patch.yml
  install.test.mjs     the merge rules (7 cases)
  README.md
  README.zh.md
```

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

脚本是**合并**而不是覆盖 —— 因为官方插件管理器把用户开关（`- id: ...` / `disabled: true`）也记在同一个文件里。

## 它改了什么

`cordis.patch.yml` 覆盖 `packages/bundle/base/cordis.patch.yml` 声明的 `deepseek-account` 行。补丁是**整块替换** `config`，所以条目要把该行拥有的键全部重述一遍：

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
