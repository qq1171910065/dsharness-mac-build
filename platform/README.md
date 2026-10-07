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
3. the machine-level host configuration (`$DSH_HOME/cordis.patch.yml`) applies overrides to every profile, including the application-owned `desktop` one — **config overrides only**; fork-owned plugins are provisioned as bundle packages instead, so the official Plugins page can switch them.

## Layout

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

The script merges instead of overwriting, because the official plugin manager records user toggles in that same file, and it then provisions the plugins this product ships into every profile it finds (see the plugins section below). `--no-marketplace` leaves the community marketplace alone; `--check` reports what would change without writing; `--remove` takes back the managed rows, our generated packages, our dependency entries and our selections.

`DSHARNESS_SKIP_INSTALL=1` makes `dev-all.ps1` pass `--no-marketplace`, because that switch already means "do not use the network here".

### Packaging this product's Desktop build

Upstream reads packaging settings from `apps/desktop/.env.windows` (or `.env.macos`), which `.gitignore` excludes, so a local deployment file never reaches the repository. This product needs it to supply the application identity and the updater origin, because upstream requires an explicit `DSH_DESKTOP_APP_ID` and hard-codes the production updater origin:

```
DSH_DESKTOP_APP_ID=com.czmanong.dsharness
DSH_DESKTOP_AUTO_UPDATE_ENV=test
DOWNLOAD_TEST_ORIGIN=https://www.czmanong.com
DOWNLOAD_TEST_RELEASE_ID=<32 hex characters>
```

The `test` deployment is fully environment-driven; the `production` one is not, which is why the updater can only point at this product through the test channel until that becomes a configuration seam upstream.

Build the installer through this layer, not through the upstream script:

```sh
node platform/package-windows.mjs --unsigned --build-version 0.2.1-alpha.1.20261007.1
node platform/package-windows.mjs --check          # print the plan without building
```

Upstream's packager is used unchanged; two things are added from outside it.

**The configuration.** `apps/desktop/scripts/package-target.ts:269` hardcodes
`['exec','electron-builder','--config','electron-builder.config.mjs',…]` and its own
`parseArgs` rejects unknown options, so the extra `--config` cannot be appended to the
packaging command. Every Node process in the tree does inherit `NODE_OPTIONS`, so
`--import platform/windows/nsis-config-hook.mjs` preloads into the whole run and rewrites
that one argument in the process that is electron-builder itself. The hook guards on two
sentinels and on `argv[1]` naming `electron-builder/cli.js`, and it fails the build loudly
when it cannot substitute: building with upstream's configuration would produce an installer
that silently carries no deployment layer.

`platform/windows/electron-builder-config.mjs` is what it substitutes: it imports upstream's
module and replaces exactly one field. Loading upstream's factory rather than restating the
configuration is what keeps a new upstream option from being dropped here.

**The installer script.** `nsis.include` points at `platform/windows/installer.nsh`, which
`!include`s `apps/desktop/scripts/installer.nsh` first — keeping upstream's custom pages,
staged extraction and lifecycle hooks — and then adds one hook. That hook has to be a stock
callback, because upstream defines `customHeader`, `customInit`, `customInstall`,
`customCheckAppRunning` and the rest as `!macro`, and NSIS refuses to redefine a macro.
`.onInstSuccess` is defined by nothing in the electron-builder templates, so it is the free
place to run work after the application files are in place.

### The installer already carries the deployment layer

That is the point of the seam: a person who installs the application gets this product's
login, balance and account service without running a script first.

`platform/windows/installer.nsh` copies `platform/windows/deploy/` into
`<install>\resources\installer-ui\dsharness\` and runs `deploy-entry.mjs` with the Node
runtime the application itself ships, so no system Node, npm or pnpm is needed. It also copies
`platform/windows/app-update.yml` into `<install>\resources`, which is what the packaged
updater looks for — see the update section below. The payload
is generated by `build-deploy-payload.mjs`: `home.mjs`, `provision.mjs`, `install.mjs` and
`host-auth.mjs` are byte-identical copies of the files above, and `cordis.patch.yml` is the
same rows with **one line rewritten** — `platformOrigin` is baked to the origin this build
targets, because an installed machine has no `DSH_PLATFORM_ORIGIN` and the loader refuses to
let any `.env` supply a `DSH_`-prefixed name (`packages/boot/app-boot/src/index.ts:157`).
`deploy-payload.test.mjs` fails when a copy drifts.

```
node platform/build-deploy-payload.mjs                        # write, default origin
node platform/build-deploy-payload.mjs --platform-origin https://example.test
node platform/build-deploy-payload.mjs --check                # fail when stale
```

The origin must be a **bare origin**. `platformOrigin(value, allowLoopbackHttp)`
(`packages/credentials/deepseek-account-platform/src/protocol.ts:22`) rejects any URL whose
`pathname` is not `/`, so a reverse-proxy prefix such as `https://www.czmanong.com/dsharness`
cannot be used even though that is where the container is reachable. The gateway carries this
product's paths at the bare origin instead.

What the payload does, in order:

1. **Create the Desktop profile if it is absent.** The application would create it on the
   first launch (`apps/desktop/src/project-manager.ts:88`) and `initProfile` never overwrites
   an existing file, so writing the same three files here makes the application's own
   initialization a no-op instead of a rewrite — and gives `provisionProfile` a manifest to
   work with. Without this step it would find no manifest and skip.
2. **Write the deployment rows and provision the plugins** for that profile, through the same
   `install.mjs` a development machine runs. The payload is generated from those files; the
   only thing `deploy-entry.mjs` adds is a pnpm runner built from
   `resources\runtime\pnpm\bin\pnpm.mjs` and the bundled Node.

The three profile files are written literally, because the payload runs under plain `node.exe`
and cannot import `@deepseek-ai/dsh-app-boot` out of `app.asar` (only Electron's patched `fs`
reads an asar). `deploy-payload.test.mjs` runs upstream's `initProfile` through `tsx` and
compares all three byte for byte.

A failed deployment is reported and does not fail the install: the application still runs, it
just talks to the upstream account service, and the exit code reaches the install log and the
detail view through `DetailPrint`.

To prove the seam end to end without repeating the preparation stages, re-wrap an existing
`win-unpacked`:

```sh
node platform/windows/verify-installer.mjs --output "$env:TEMP\seam"
```

It uses `--prepackaged`, which short-circuits `doPack`
(`app-builder-lib/out/platformPackager.js:146`) so only `NsisTarget` runs — the piece this
product replaces. Deleting `deploy/deploy-entry.mjs` makes the build fail with
`File: … -> no files found`, which is the negative case: a missing payload is a failed build,
not a silently stripped installer.

### Rows here can mount fork-owned code

A row's `name` resolves relative to the patch file that declares it, so a layer can mount a plugin that lives beside it instead of upstream:

```yaml
- insert:
    - id: dsharness-some-plugin
      name: ./some-plugin.mjs
```

That was verified by booting the `web` profile with a home-level patch that inserted such a row and observing the plugin's side effect (`loaded:dsharness-platform-probe`). It means fork-owned capability needs neither an upstream package nor a published npm name.

It is **not** how this product ships its plugins, though — such a row belongs to no
package, so the official Plugins page cannot list or switch it. See the next
section: fork-owned plugins go in as bundle packages, and only config overrides of
rows upstream already declares stay in the home-level patch.

### Plugins this product ships are real bundle packages

The product decision is two-sided: the gateway plugin is a **custom plugin, off by
default**, and the community marketplace (`dshmarket`) is **on by default**. Both
are decided by packaging, not by anything a patch row can say.

The official Plugins page (`packages/client/ui-plugin-manager`) lists **packages**
(`pluginManager/listBundles`) and splits them with two package flags:

| group | condition |
|-------|-----------|
| Installed | `installed \|\| !optional` |
| Official | `optional && !installed` |

A row inserted straight from a patch file belongs to no package, so the page never
mentions it. Measured on the live desktop Host: the row *was* addressable by
`listPlugins` (`patchId: dsharness-host-auth`) while `listBundles` knew nothing
about it — there was no card to switch, which is exactly what the request is about.
`optional` is not deployment-settable either; it comes from the launcher's own
`OPTIONAL_BUNDLES` allowlist.

What *is* deployment-actionable, and all `provision.mjs` writes, is the pair:

- **`installed`** — a real bundle package in the profile's `node_modules`, named in
  the profile manifest's `dependencies`;
- **`enabled`** — membership in `dsh.profile.bundles`. A bundle listed there runs;
  one that is merely installed does not.

So *off by default* is **installed but not selected**, and *on by default* is
**installed and selected**. Both are then switchable in the page through the
official `setBundleEnabled`, with no mechanism of ours in the loop.

Measured on the live desktop Host after `node platform/install.mjs`:

```text
dsharness-host-auth  installed=true   enabled=false  title{zh: "DSH Desktop 网关"}   rows=[dsharness-host-auth]
dshmarket            installed=true   enabled=true   title{zh: "插件市场"}          rows=[dsh-market]
```

`--dump-config` agrees: with the selection list as written, the composed tree has
`dsh-market` and **no** `dsharness-host-auth` row. Turning ours on through the
official switch (`pluginManager/setBundleEnabled`) then makes the shared-secret
channel answer 200 for the right secret while wrong/absent secrets stay 401 —
`check-host-auth.mjs` covers that against the live Host.

#### No default state is ever written into a patch layer

The tempting alternative — keep inserting the row from `$DSH_HOME/cordis.patch.yml`
and write `disabled: true` — is a dead end, and worth recording because it looks
right. `readProfilePatches` (`packages/boot/app-boot/src/profile-context.ts:63`)
applies *bundle layers → profile patch → `$DSH_HOME` patch → overlays*, and a later
layer overwrites an earlier one per row id. Measured with the real
`applyEntryPatches`:

```text
[profile(disabled=false), home(insert + disabled=true)] → disabled=true
[home(insert, neutral),   profile(disabled=true)]       → disabled=true
[home(insert, neutral),   profile(disabled=false)]      → disabled=false
```

A default written into our managed block is therefore the last word and the page's
switch could never turn the plugin on. Letting the package own its row removes the
question: `platform/cordis.patch.yml` now carries a comment-only explanation where
that `insert` used to be, and `install.test.mjs` asserts no fork-owned insert and no
`disabled:` remain there.

#### One asymmetry worth knowing

`pnpm` prunes a `link:` target that lives outside the profile, so the generated
package is a real directory **inside** `<profile>/node_modules` declared as
`file:./node_modules/<name>` (`pluginInstallSpec`). It also needs no symlink
privilege, which on Windows would otherwise mean Developer Mode.

Our own packages are placed directly and need no package manager at all, so the
gateway plugin works on a machine that has never reached npm; only `dshmarket`
goes through pnpm. A failed marketplace install is reported with the exact manual
command and never fails the deployment.

#### Turning it off in a live process does not revoke issued cookies

Measured: after enabling and then disabling through `setBundleEnabled`,
`listBundles` says `enabled: false` and `pluginInventory/list` no longer lists the
row — yet a request carrying the correct secret **still gets 200** (absent and
wrong secrets still 401, so it is not a vacuous pass). The cleanup restores the
`connection` method references, but the connection cookie already exchanged
remains a valid short-lived credential: upstream does not re-ask who minted it on
each request. Nothing here can fix that without touching upstream's `connection`,
and it does not affect the default state, which was never enabled. To invalidate
immediately, change `DSH_AUTH_TOKEN` and restart — those cookies are signed with
the connection secret.

### Server-to-server access to the official `/api` (`host-auth.mjs`)

The official `/api` authenticates with a cookie that only a browser holding the launch token `dsh web` printed can obtain (`packages/client/connection/src/browser-auth.ts`). A caller with **no browser** — another product's server, a script, a mini program backend — cannot get one, and should not have to drive a browser to try.

`host-auth.mjs` adds a second credential that lands in the same place: a correct shared secret (`Authorization: Bearer <secret>`, or the cookie this plugin issues) is converted into a one-request connection cookie and appended to the request. The official checks still run; they just see a request that already satisfies them.

| caller | how it gets in |
|--------|----------------|
| no credential | 401 from the official connection layer — this plugin does not open anything by itself |
| wrong or short secret | 401, same as above |
| `Authorization: Bearer <secret>` | admitted; covers unary RPC **and** the `/api/remote.mux` upgrade |
| browser on the LAN | `/dsharness/auth` exchanges the secret for a cookie, then `/` and `/api` both work |
| secret unset | one is generated and stored on first run, so the channel works and can be read off `/dsharness/gateway` |

### The port and the secret have to be readable (`/dsharness/gateway`)

"I cannot integrate with it" was the report, and the reason was structural: the port and the
shared secret existed only inside the process. `dsh web` prints `?token=` once, at startup,
into a terminal — and the desktop application has no terminal at all. So `host-auth.mjs`
renders both:

| surface | what it gives |
|---------|---------------|
| `GET /dsharness/gateway` | an HTML page: port, local address, shared secret, cookie name, login path, and a copy button |
| `GET /dsharness/gateway.json` | the same facts as JSON, for callers and for the acceptance check |

Three details are deliberate:

- **Loopback only.** A non-loopback request gets a page explaining that, and the JSON surface
  answers `403`. The secret is meant to be readable on the machine that runs DSH and nowhere
  else.
- **The port comes from the request's own authority**, not from a stored config:
  `webServer.port` is only known after listening when the configured port is `0`, and the
  authority is the `host:port` the caller actually reached, so it is always the right one.
- **No `?token=`.** The token `dsh web` prints is the *connection layer's* one-shot credential,
  which this plugin neither has nor needs; mixing it with the shared secret in one URL would
  make "which is which" permanently unclear.

A secret that is unset (or too short) is now **generated and persisted** rather than leaving
the plugin unmounted: the deployment row always supplies a `token` key, so "unset" is the
normal default, and a channel that switches itself off has nothing to display. The generated
value goes into the credential layer under `DSHARNESS_AUTH_TOKEN`, which makes it stable
across restarts — a secret that changed every launch would be a secret the user could never
copy down. `enabled: false` is the one way to turn the channel off.

Both surfaces are registered as `kind: 'exact'` routes and additionally allowed through
`authorizeIndex`: `webServer.match()` checks the exact table first, but `frontend-static`
delegates index requests to `authorizeIndex`, which accepts only `GET /` — so without that
allowance these pages would be reachable only if route registration happened to win the race.


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

### The account page's two links must be rendered by this product

The official provider builds the account page's usage and top-up links as `<platformOrigin>/usage` and `<platformOrigin>/top_up` (`deepseek-account-platform/src/index.ts:188`), and **Desktop opens them in a same-origin `WebContentsView`** whose navigation guard is:

```js
const allowNavigation = (url) => new URL(url).origin === account.origin
view.webContents.on('will-redirect', (event, url) => { if (!allowNavigation(url)) event.preventDefault() })
```

So a redirect out of `platformOrigin` is **cancelled** and the user sees a blank surface. That is exactly why "the top-up button does nothing": those two paths used to `302` to `ai.czmanong.com`. They must be rendered by this product instead — see `server/src/lib/page-shell.ts`, `topup-page.ts`, `usage-page.ts`, `page-session.ts` and `server/src/routes/pages.ts`.

`check-pages.mjs` exercises the path the embedded view takes: it injects `window.dsh.getAuthToken()` (the bridge the official preload exposes) and deliberately sets **no cookie**, so it cannot accidentally test the browser route instead. Run it after `npm run e2e`, which ends with a sign-out that revokes every existing session.

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

`cordis.patch.yml` addresses four rows that upstream already declares. A patch replaces a
row's whole `config`, so an override restates every key that row owns. No fork-owned plugin
is inserted here — those ship as bundle packages instead, for the reason given above.

| row | upstream default | this deployment |
|-----|------------------|-----------------|
| `deepseek-account` → `platformOrigin` | `https://platform.deepseek.com` | this product's server (`PUBLIC_BASE_URL`) |
| `deepseek-account` → `desktopPlatform` | `null` | the original expression is kept |
| `deepseek-account` → `allowLoopbackHttp` | `false` | enabled unless `DSH_PLATFORM_ALLOW_LOOPBACK_HTTP=0` |
| `llm-pi-ai` → `providers.dsharness-relay` | `{}` (no routes) | this product's gateway, shown as 「码农AI」 |
| `agent-default-model` | `deepseek-official` / `deepseek-flash` | `dsharness-relay` / `deepseek-v4.1-flash` |
| `llm-deepseek-account` → `disabled` | mounted | `true` — see below |

The installed copy of this file carries a literal origin rather than the `!!js process.env…`
expression the development copy uses: an installed machine has no environment variable to
read, and the loader refuses `DSH_`-prefixed names from any `.env`.

### The model route is this product's gateway, not DeepSeek's

Upstream's default selection names `deepseek-official`, whose provider package hardcodes the
display name `DeepSeek`, the endpoint `api.deepseek.com`, and a catalog containing neither
`deepseek-v4.1-flash` nor anything else this product serves. Changing that row is not possible
without editing the package, so the route is declared where upstream leaves room for one:
`llm-pi-ai` ships mounted but with an empty `providers` dict, and its comment says exactly that
a settings section is what fills it (`packages/bundle/base/cordis.patch.yml:120-128`). A
provider profile's dict key **is** the route, and `displayName` is ours to choose:

```yaml
dsharness-relay:
  displayName: '码农AI'
  api: 'openai-completions'
  baseURL: 'https://ai.czmanong.com/v1'
  apiKeyEnv: 'DSHARNESS_MODEL_KEY'
```

`baseURL`, `api` and the model catalog match what `GET /api/config` already delivers
(`server/src/lib/defaults.ts`), so the model picker and the server agree.

### Why the account-backed model route is switched off

`llm-deepseek-account` authenticates inference with `account.resolveToken(baseURL)` and sends
what it gets as `x-dsh-auth-token` (`packages/llm/llm-deepseek-account/src/index.ts:20-25`).
Two facts make that route unusable here, and the second is destructive:

1. `resolveToken` hands out the grant only when the request origin equals `inferenceOrigin`
   (`packages/credentials/deepseek-account-platform/src/index.ts:385-401`), and this
   deployment's inference origin is the gateway, which does not read that header at all.
   Measured on a valid key: `x-dsh-auth-token` → 401, `x-api-key` → 200.
2. A 401 through that route is handled by `onRequestError`, which calls `rejectToken`
   (`.../llm-deepseek-account/src/index.ts:26-36`). `rejectToken` → `expireCredential`
   **deletes the stored grant** and emits `deepseek-account/signed-out`
   (`.../deepseek-account-platform/src/index.ts:322-344`). So a single failed request signs the
   user out — which is what "sign in, start a new session, land back on the login page" was.

Only that LLM row is disabled. `deepseek-account` itself (login, balance, bonuses, sign-out)
must stay mounted or the whole official account surface disappears.

**This is one known sign-out path, not a complete explanation.** The other paths that can
clear the same credential are: a 401/`code: 40003` from the product's own account endpoints
(`server/src/lib/dsh-account.ts:84-86`, which `tokenVersion` bumps reproduce after a sign-out
or a user suspension); and `issuer-mismatch` at startup, which discards the grant without
sending any request (`.../deepseek-account-platform/src/index.ts:167-176`) — visible in the
Host log as `stored grant discarded`. Diagnosing a report of "thrown back to login" means
checking which of the three it was, not assuming this one.

### The delivery step the key needs (`model-key.mjs`)

The product server has always returned the per-user gateway key at
`GET /api/account/model-access`, and nothing in this fork ever read it: a search for
`model-access`, `apiKeyCreated` and `dshModelKey` across `client/` was zero hits. So the route
above had no credential and every request failed with `MISSING_CREDENTIAL`.

`platform/model-key.mjs` is that consumer. On the account session's changes it asks the
product server for the key and writes it into the credential store under
`DSHARNESS_MODEL_KEY` — the reference `llm-pi-ai`'s `apiKeyEnv` names — and removes it on
sign-out or an unauthorized answer. A transport failure keeps the stored key, because a `503`
says nothing about whether the gateway key is still valid.

### Check for updates (`update.mjs`)

The official updater needs `app-update.yml` next to the application resources, and an unsigned
build never gets one: `publish: null` (`apps/desktop/scripts/electron-builder-config.mjs:249`)
means electron-builder writes none (`app-builder-lib/out/publish/PublishManager.js:87-90`),
while `update-coordinator.ts:54` requires exactly that file and `:185` throws without it. The
installer ships one itself (`platform/windows/app-update.yml`), and that is enough, because
`NsisUpdater.verifySignature()` returns null — accepts the package without checking anything —
while `publisherName` is absent (`electron-updater/out/NsisUpdater.js:84-100`). That key is
deliberately not in the file; adding it starts a real Authenticode check and every update would
fail with `ERR_UPDATER_INVALID_SIGNATURE`.

So `platform/update.mjs` serves the answer itself at `/dsharness/update` (HTML) and
`/dsharness/update.json`, comparing the installed version against the release the product
server publishes at `GET /api/config/version`. It reports; it does not download or install.

The installed version comes from `<DSH_HOME>/dsharness-install.json`, written at install time
by the payload. The installer passes NSIS's `${VERSION}` — which electron-builder defines from
the packaged app version — because on an unsigned build that is the only witness to what the
user actually installed.

⚠️ The two release records **are different stores** and both must be written:
`wb_client_release` (Platform, what the website renders) and the product server's
`desktopRelease` (what the client reads). Measured drift is why `register-client-release.mjs`
now writes both: the website advertised `0.2.1-alpha.1.20261007.2` while `/api/config/version`
still answered `0.2.0`, so a freshly installed client was told it was current.

### The in-app update entry (`update-ui.js`)

The updater above answers "which version is this"; it is not a place a user goes. The shell
already exposes the real in-app update UI — `dshDesktop.updates.open()`
(`apps/desktop/src/preload-app.ts:49-57`, contract in `ipc.ts:82-86`) opens the native
check/download/install dialog from `main.ts`'s `openUpdatePrompt()` — but **nothing in the
shipped UI calls it**. The one component that knows about update state
(`DesktopUpdateIndicator.tsx:64`) renders nothing while idle, so in the shipped product the
action has no clickable path at all; a search for `updates.open` under `packages/` and `apps/`
finds the preload, its test, and that indicator, and no entry point.

That is why this layer has to be a plugin rather than an upstream edit: `settings.general.item`
is a documented extension point (declared in
`packages/client/ui-settings/src/client/contract/slots.ts:92`) and a registrant needs one
`slots.register`, while the fork's rule is that nothing under `packages/` or `apps/` is
touched. `update-ui.js` therefore contributes one row to Settings › General, ordered 90
(between `developer-tools` and `current-version`), whose button calls
`globalThis.dshDesktop?.updates?.open()` and whose status line renders the subscribed
`status()` phase in words.

Three details are deliberate, and each is asserted by `update-ui.test.mjs`:

- **The bundle is a classic script, so the plugin is two files.** The client module system
  loads bundles with `document.createElement('script')`
  (`packages/client/modules/src/client/system.ts:16-29`) and reconciles the registration `id`
  against the package name, so `update-ui.js` may only register itself through
  `window.__ModuleLoader__.load(...)`; it cannot be an ESM plugin. Node, meanwhile, imports a
  bundle row's `index.mjs`. `update-ui.host.mjs` is that no-op host half, and
  `provision.mjs`'s `clientEntry` field copies the browser half into the package as
  `client.js` — a package needs both to be a bundle row **and** a served browser bundle.
- **The row needs no context.** Owner props on `settings.general.item` are empty, and
  `dsh-client-locale` is not one of the nine baseline modules a client bundle may `require`
  (`packages/client/web/src/platform.ts`), so the copy is built-in and picks zh/en from
  `navigator.language` (falling back to `<html lang>`). Nothing about the row disappears when
  a service is absent — there is no service in the path.
- **A browser degrades instead of failing.** With no `dshDesktop` (a plain `dsh web` profile)
  the row says so and disables its button.

`platform/windows/app-update.yml` is the other half of the same feature and travels two ways on
purpose. The NSIS include copies it into `$INSTDIR\resources` so the packaged updater has a feed
to read, **and** `windows/update-descriptor.mjs` adds it to electron-builder's `extraResources`
so it is already inside the package before the installer runs. The second path exists because of
a measured ordering fact: an update install is silent and force-run, and the assisted installer
relaunches the application at the end of the install section
(`app-builder-lib/templates/nsis/installSection.nsh:105-109`) — an NSIS ordering probe showed the
descriptor absent at relaunch time and `.onInstSuccess` writing it immediately afterwards. With
only the include, the freshly relaunched instance runs its startup check with
`enabled() === false` (`update-coordinator.ts:54`) and reports one failure before the retry
succeeds. `File` in the include therefore overwrites an identical copy rather than creating one.

The cache directory in that file is a contract with the **installer**, not a free label:
`updaterCacheDirName: '@deepseek-aidsh-desktop-updater'` must equal what the installer computes,
because the uninstaller removes exactly `%LOCALAPPDATA%\<that name>`
(`apps/desktop/installer/uninstall.nsh:34`) while the updater leaves a ~292 MB pending download in
`<that name>\pending`. The value comes from `appInfo.updaterCacheDirName`
(`app-builder-lib/out/appInfo.js:126-128`, `sanitizedName.toLowerCase() + '-updater'`, `@`
preserved by `sanitizeFileName`), which the build records verbatim as
`!define DSH_UPDATER_CACHE_NAME "@deepseek-aidsh-desktop-updater"` — measured in the built
`builder-debug.yml`. A mismatch breaks nothing visibly; it silently leaks the download on
uninstall, which is why `deploy-payload.test.mjs` asserts the name. The quotes are required:
YAML treats a leading `@` as a reserved indicator.

### The origin the client is built with must reach this product directly

`platformOrigin` is validated as an origin, and every path of the official protocol is
appended to it:

| path | served by |
|------|-----------|
| `/auth-api/v0/dsh/auth_init`, `/auth-api/v0/users/current`, `/auth-api/v0/users/logout` | `server/src/routes/dsh-account.ts` |
| `/api/v0/users/get_user_summary`, `/api/v0/users/get_unnotified_bonuses`, `/api/v0/users/ack_bonus_notified` | `server/src/routes/dsh-account.ts` |
| `/dsh/authorize`, `/dsh/authorize/complete`, `/dsh/authorized` | `server/src/routes/dsh-account.ts` |
| `/top_up`, `/usage`, `/api/page/*` | `server/src/routes/pages.ts` |
| `/api/config`, `/api/config/version` | `server/src/routes/api.ts` (the release the updater page reads) |

So the gateway has to send those paths to the product server's port, and it must do so
**without stripping a prefix**: `browserUrl()` in the official provider compares
`url.pathname` against the literal `/dsh/authorize` and `/dsh/authorized`
(`packages/credentials/deepseek-account-platform/src/protocol.ts:40`), and it also rejects a
platform that answers with a different origin than the one it was configured with. A
prefix-mapped deployment therefore cannot work through this provider at all — the origin has
to be a host that serves the product's paths at the root.

The account page's two links must be **rendered**, not redirected: Desktop opens them in a
same-origin `WebContentsView` whose `will-redirect` guard only allows `account.origin`, so a
`302` out of the origin is cancelled and the user sees a blank surface. That is why
`/top_up` and `/usage` are pages in `server/src/routes/pages.ts` rather than links to the
gateway.

### Why one row wires every official login

The official Electron welcome window's Sign in, the Settings account page, the desktop onboarding quota page, and the `deepseek-account` model provider all reach the platform through `ctx.deepseekAccount` and talk only to `platformOrigin`. Pointing that row at this product routes all of them to the official protocol surface in `server/src/routes/dsh-account.ts`, which forwards them to the existing `/api/auth/*` endpoints.
