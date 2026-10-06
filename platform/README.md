# dsharness deployment layer (fork-owned; no upstream counterpart)

English | [中文](README.zh.md)

This directory is the single home for every change this fork owns. Upstream deepseek-harness has no `platform/` directory, so following upstream can never conflict here:

```sh
git fetch upstream
git merge upstream/master      # never conflicts in platform/
```

## Why not patch-package patches

The replaced `client/` was a third-party shell that tracked upstream through 24 `patch-package` patches (+3285 lines) rewriting the built `@deepseek-ai/*` client bundles:

| patch | size | why it cannot survive an update |
|-------|------|----------------------------------|
| `dsh-client-ui-settings-models` | 100 KB / 51 hunks | every upstream bundle rebuild means recomputing hunk headers by hand |
| `dsh-api-session-controller` | 45 KB / 17 files | one upstream move rewrites a whole remote contract |
| `dsh-client-ui-workspace` | 56 KB / 60 hunks | upstream ships no session-row menu slot to extend |

The official harness is built so that approach is unnecessary:

> There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads. -- `docs/architecture.md`

This layer therefore edits no upstream file and uses three public mechanisms:

1. the profile patch layer (`cordis.patch.yml`) overrides or disables rows by `id`;
2. cordis plugin packages (`dsh.bundle.patch` for the Host half, `dsh.client` for the browser half) add capability;
3. the machine-level host configuration (`$DSH_HOME/cordis.patch.yml`) applies overrides to every profile, including the application-owned `desktop` one.

## Layout

```text
platform/
  cordis.patch.yml         deployment rows: point the official login at this product
  host-auth.mjs            fork-owned plugin: shared-secret access to the official /api
  install.mjs              merge the rows into $DSH_HOME/cordis.patch.yml, copy the plugin beside them
  install.test.mjs         the merge and copy rules (12 cases)
  host-auth.test.mjs       the plugin's pure functions (18 cases)
  check-host-auth.mjs      live check against a running profile (unary, cookie, index, WebSocket)
  check-desktop.mjs        live check against the real Electron renderer (CDP)
  verify-fork-update.mjs   prove the fork can still take upstream updates
  README.md
  README.zh.md
```

## Following upstream

```sh
git fetch upstream
git merge upstream/master
```

That is the whole update procedure, and it can never conflict, because every
file this fork owns lives in `platform/`, which upstream does not have. Verify
that property mechanically rather than trusting it — an accidental edit to an
upstream file breaks nothing today, only the next upstream release:

```sh
node platform/verify-fork-update.mjs
node platform/verify-fork-update.mjs --no-fetch
```

It checks that `upstream` is the official repository, that no owned change
touches an upstream-tracked file, that `platform/` exists only here, and that a
real `git merge upstream/master` applies cleanly — on a throwaway branch, with
the original HEAD restored on every exit path. A dirty worktree makes it refuse
rather than merge on top of uncommitted work.

## Usage

```sh
node platform/install.mjs
DSH_PLATFORM_ORIGIN=https://www.czmanong.com node platform/install.mjs
```

The script merges instead of overwriting, because the official plugin manager records user toggles (`- id: ...` / `disabled: true`) in that same file.

### Packaging this product's Desktop build

Upstream reads packaging settings from `apps/desktop/.env.windows` (or `.env.macos`), which `.gitignore` excludes, so a local deployment file never reaches the repository. This product needs it to supply the application identity and the updater origin, because upstream requires an explicit `DSH_DESKTOP_APP_ID` and hard-codes the production updater origin:

```
DSH_DESKTOP_APP_ID=com.czmanong.dsharness
DSH_DESKTOP_AUTO_UPDATE_ENV=test
DOWNLOAD_TEST_ORIGIN=https://www.czmanong.com
DOWNLOAD_TEST_RELEASE_ID=<32 hex characters>
```

The `test` deployment is fully environment-driven; the `production` one is not, which is why the updater can only point at this product through the test channel until that becomes a configuration seam upstream.

### Rows here can mount fork-owned code

A row's `name` resolves relative to the patch file that declares it, so this layer can mount a plugin that lives beside it instead of upstream:

```yaml
- insert:
    - id: dsharness-some-plugin
      name: ./some-plugin.mjs
```

That was verified by booting the `web` profile with a home-level patch that inserted such a row and observing the plugin's side effect (`loaded:dsharness-platform-probe`). It means fork-owned capability needs neither an upstream package nor a published npm name.

But a relative `name` resolves against **the patch file that declares it**, and `install.mjs` writes that file into `$DSH_HOME`. So the plugin has to live **beside the copy**, not beside this README: `install.mjs` copies every entry of `PLUGIN_FILES` into the home directory and the row references the copy (`name: ./dsharness-host-auth.mjs`). One script then keeps the row and its code on the same path, so they cannot disagree, and `--remove` takes both back.

### Server-to-server access to the official `/api` (`host-auth.mjs`)

The official `/api` authenticates with a cookie that only a browser holding the launch token `dsh web` printed can obtain (`packages/client/connection/src/browser-auth.ts`). A caller with **no browser** — another product's server, a script, a mini program backend — cannot get one, and should not have to drive a browser to try.

`host-auth.mjs` adds a second credential that lands in the same place: a correct shared secret (`Authorization: Bearer <secret>`, or the cookie this plugin issues) is converted into a one-request connection cookie and appended to the request. The official checks still run; they just see a request that already satisfies them.

| caller | how it gets in |
|--------|----------------|
| no credential | 401 from the official connection layer — this plugin does not open anything by itself |
| wrong or short secret | 401, same as above |
| `Authorization: Bearer <secret>` | admitted; covers unary RPC **and** the `/api/remote.mux` upgrade |
| browser on the LAN | `/dsharness/auth` exchanges the secret for a cookie, then `/` and `/api` both work |
| secret unset or shorter than 16 chars | plugin does nothing (one warning); `/api` keeps upstream behaviour |

It wraps `connection.requestRejection` and `connection.authorizeIndex` instead of registering a route, because `/api` is already claimed: `webServer.register` throws on a duplicate `(kind, path)`, and the upgrade path is registered separately by `api-gateway`. Both admission decisions funnel through those two service methods, so one wrap covers every carrier.

It is **not a second authentication stack**: the Host/Origin fence and the connection-cookie check still decide, no new trust principal appears, and the comparison is `timingSafeEqual`. The plugin is zero-dependency `.mjs` (only `node:` imports) because this layer has no `node_modules`: it reads config as a plain object and writes the connection key literal (`client-connection/browser-session`, the value `credentialKey(scope, id)` produces).

On startup it self-checks by minting a cookie and running it through the official `requestRejection`; a format drift upstream warns immediately instead of surfacing as a 401 in production. `check-host-auth.mjs` covers the whole thing against a running profile:

```sh
# one terminal: a gated profile
$env:DSH_HOME="$env:TEMP\dsh-auth"; $env:DSH_AUTH_TOKEN='<at least 16 chars>'
node platform/install.mjs
node apps/cli/lib/bin.js web --port 13096 --no-open
# another
$env:DSH_AUTH_TOKEN='<the same secret>'; node platform/check-host-auth.mjs
```

Verified locally: no credential / wrong secret / short secret all 401; the correct secret reaches the real RPC surface (`result.ok: true`); the login page issues a cookie that also passes; `/` is 401 without and 200 with; the mux upgrade opens and delivers a frame.

### Desktop (Electron) is the same surface

The Desktop application launches the same web composition: `apps/desktop-host/src/index.ts` boots `webServer` + `connection` and Electron only owns the window. Because `install.mjs` writes the rows to `$DSH_HOME/cordis.patch.yml`, which **every** profile reads, the Desktop profile needs no extra work to get both the account row and the host-auth channel.

`check-desktop.mjs` verifies that against the real renderer over CDP (Electron is started with `--remote-debugging-port=9222` by `apps/desktop/scripts/dev.ts`):

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

It asserts what the Web check cannot: the Desktop shell injects `dshDesktop` **itself** (with `browser`, `deviceInfo`, `keyboard`, `shortcuts`, `updates`), so the account UI is the real one rather than a fixture; the official sign-in points at this product's server; the callback is accepted; `getProfile`/`getBalance` return this product's data; and the account page renders the balance.

Four things that cost time and are worth knowing before writing against this surface:

| symptom | cause |
|---------|-------|
| `electron.exe: bad option: --remote-debugging-port=…` | `ELECTRON_RUN_AS_NODE=1` is inherited when you launch from inside DSH; clear it |
| `Target.createTarget: Not supported` | CDP does not support `context.newPage()`; drive the existing page and use HTTP for extra steps |
| a visible button reads as "not visible" | the overlays are `position: fixed`, so `offsetParent` is always null; `checkVisibility({checkOpacity,checkVisibilityCSS})` also returns false here. Use geometry |
| the account section never appears | the sidebar trigger's text is the **user name**, and the menu item's text is `设置Ctrl+,`; select by `button[aria-label="账号菜单"]` then `[role=menuitem]`. The official onboarding overlay also has to be dismissed first (loop it, preferring the confirmation dialog's own keys) |

## What it changes

`cordis.patch.yml` has two rows, and they are deliberately different kinds:

1. **an override** of the `deepseek-account` row that `packages/bundle/base/cordis.patch.yml` declares — a patch replaces a row's whole `config`, so the entry restates every key that row owns;
2. **an insert** of `dsharness-host-auth`, which upstream does not declare. An insert cannot conflict with upstream by construction, which is why the fork-owned plugin goes in as a new row rather than as an edit to an existing one.

| key | upstream default | this deployment |
|-----|------------------|-----------------|
| `platformOrigin` | `https://platform.deepseek.com` | this product's server (`PUBLIC_BASE_URL`) |
| `desktopPlatform` | `null` | the original expression is kept |
| `allowLoopbackHttp` | `false` | enabled unless `DSH_PLATFORM_ALLOW_LOOPBACK_HTTP=0` |

### Why one row wires every official login

The official Electron welcome window's Sign in, the Settings account page, the desktop onboarding quota page, and the `deepseek-account` model provider all reach the platform through `ctx.deepseekAccount` and talk only to `platformOrigin`. Pointing that row at this product routes all of them to the official protocol surface in `server/src/routes/dsh-account.ts`, which forwards them to the existing `/api/auth/*` endpoints.

### What is still missing: getting the per-user gateway key into the provider

The gateway does serve the Anthropic Messages format, so no second adapter is
needed: this product's New API deployment answers `POST /v1/messages` as
`RelayFormatClaude` (`relay/server/router/relay-router.go`) and accepts the
credential as `x-api-key` (`relay/server/middleware/auth.go`, `TokenAuth`, which
maps `x-api-key` to `Authorization: Bearer` for `/v1/messages`).

That makes the official **API-key** provider the right route: `llm-deepseek`
(`packages/llm/llm-deepseek-api-key`) already sends `x-api-key`, and it only needs

- `baseURL: https://ai.czmanong.com/v1` (Messages requests go to `<root>/messages`),
- `models` naming this product's catalog,
- `apiKeyEnv` naming the credential that holds the user's gateway key.

The account provider cannot serve this route: `llm-deepseek-account` sends the
stored grant as `x-dsh-auth-token`, which the gateway does not read. So the
account still owns login, balance and sign-out, while inference authenticates
with the per-user `sk-` that `GET /api/account/model-access` issues.

What is missing is the delivery step: nothing yet fetches that endpoint and
writes the key into the credentialed `apiKeyEnv` reference on startup and after
sign-in. The previous shell did it in `src/main/account/provider-sync.ts`; here it
belongs in a fork-owned plugin row mounted from this layer.
