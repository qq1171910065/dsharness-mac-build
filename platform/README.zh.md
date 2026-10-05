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

### 还没做的一环：模型路由

`llm-deepseek-account` 说的是 Anthropic Messages 协议，而本产品网关（New API）提供的是 OpenAI 兼容的 `/v1`。所以模型必须走 `llm-pi-ai` —— `packages/bundle/base/cordis.patch.yml` 已经把它挂好但处于休眠：

- `llm-pi-ai` 设置段为空时它一条路由都不注册；
- 缺的是一个客户端插件：在启动与登录时拉 `GET /api/config` 与 `/api/account/model-access`，然后写 `llm-pi-ai` 设置段和 `apiKeyEnv` 凭据引用。

这一环尚未实现。