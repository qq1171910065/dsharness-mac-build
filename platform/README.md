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
3. the machine-level host configuration (`$DSH_HOME/cordis.patch.yml`) applies overrides to every profile, including the application-owned `desktop` one — **only for rows the settings page does not write**; a `config:` there for a writable namespace is a lock, not a default (see “The model route…” below). The fork-owned plugin is provisioned as a bundle package instead, so the official Plugins page lists it as a real card.

## Layout

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

The script merges instead of overwriting, because the official plugin manager records user toggles in that same file, and it then provisions the plugin this product ships into every profile it finds (see the plugins section below). Its managed rows are `deepseek-account` plus the two upstream routes it switches off, `llm-deepseek` and `llm-deepseek-account`; it deliberately carries no `config:` for a namespace the settings page writes. `--no-marketplace` leaves the community marketplace alone; `--check` reports what would change without writing; `--remove` takes back the managed rows, our generated package, our dependency entry, our selection, and the model catalog block it wrote into each profile's own patch file (see the catalog section below).

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
is generated by `build-deploy-payload.mjs`: `home.mjs`, `provision.mjs`, `install.mjs`,
`dsharness.mjs` and `dsharness-ui.js` are byte-identical copies of the files above, and
`cordis.patch.yml` is the
same rows with **one line rewritten** — `platformOrigin` is baked to the origin this build
targets, because an installed machine has no `DSH_PLATFORM_ORIGIN` and the loader refuses to
let any `.env` supply a `DSH_`-prefixed name (`packages/boot/app-boot/src/index.ts:157`).
Both halves of the merged bundle are in that list because `provision.mjs` reads `plugin.entry`
and `plugin.clientEntry` relative to its own directory: a payload that carried only one would
fail to place the package. `buildDeployPayload` also **deletes payload files this round no
longer ships**, because NSIS embeds the directory wholesale (`File` per module), so a leftover
copy is not inert — it ships. Without that pruning the four replaced plugin sources stayed in
`windows/deploy/` and kept being embedded. `deploy-payload.test.mjs` fails when a copy drifts
or a stale file remains.

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

It is **not** how this product ships its plugin, though — such a row belongs to no
package, so the official Plugins page cannot list or switch it. See the next
section: the fork-owned plugin goes in as a bundle package, and only config overrides of
rows upstream already declares stay in the home-level patch.

### Plugins this product ships are real bundle packages

The product ships exactly one bundle package, `dsharness`, and it is **on by default and not
switchable**. Both facts are decided by packaging, not by anything a patch row can say.

The official Plugins page (`packages/client/ui-plugin-manager`) lists **packages**
(`pluginManager/listBundles`) and splits them with two package flags:

| group | condition |
|-------|-----------|
| Installed | `installed \|\| !optional` |
| Official | `optional && !installed` |

A row inserted straight from a patch file belongs to no package, so the page never
mentions it. Measured on the live desktop Host before the merge: such a row *was*
addressable by `listPlugins` (`patchId: dsharness-host-auth`) while `listBundles` knew
nothing about it — there was no card to switch, which is exactly what the request is about.
`optional` is not deployment-settable either; it comes from the launcher's own
`OPTIONAL_BUNDLES` allowlist.

What *is* deployment-actionable, and all `provision.mjs` writes, is the pair:

- **`installed`** — a real bundle package in the profile's `node_modules`, named in
  the profile manifest's `dependencies`;
- **`enabled`** — membership in `dsh.profile.bundles`. A bundle listed there runs;
  one that is merely installed does not.

So *on by default* is **installed and selected**. The community marketplace (`dshmarket`)
is provisioned the same way and stays switchable in the page; this product's own bundle is
the one that is not.

Measured on the live desktop Host with a real `boot()` and the real `PluginManager` after
`node platform/install.mjs`:

```text
enabled: true   installed: true   removable: false   readOnlyReason: 'management-required'
rows: [dsharness]        overrides: []
```

`--dump-config` composes that package's row exactly as the package's own patch declares it.
The channel itself answers 200 for the correct secret while wrong or absent secrets stay
401 — `check-host-auth.mjs` covers that against the live Host.

Provisioning writes three things, not one: the package and those two manifest flags, plus a
managed **model-catalog block** into the profile's own `cordis.patch.yml` — the layer the
Settings › Models page reads (see that section below). `provisionProfile(...).catalog` reports
which ids it wrote, and `--remove` takes the block back together with everything else.

#### One row, three sub-plugins, per-component config

`apply()` mounts the three host components as Cordis sub-plugins —
`ctx.plugin(gatewayComponent, config.gateway)` and the two siblings — so the Loader holds one
row (`id: dsharness`) and the page shows one card; the fourth component, the status panel,
is drawn inside that same card by the browser half and adds no row of its own. The generated
patch carries one config section per component:

```yaml
gateway:  { token: !!js process.env.DSH_AUTH_TOKEN ?? '', cookieName: dsharness_auth, loginPage: true }
modelKey: {}
update: {}
```

A missing section means that component's own defaults, so any section may be left out. Only
`gateway` has a real deployment-time input (the secret); the other two are empty today.

#### No default state is ever written into a patch layer

The tempting alternative — insert our own row from a patch file and write
`disabled: true` somewhere — is a dead end, and worth recording because it looks
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
that `insert` used to be, and `install.test.mjs` asserts that no fork-owned row is
addressed by that layer at all. The only `disabled:` rows it does assert are the two
**upstream** routes this deployment must switch off — no Plugins-page switch governs
either of them. What keeps our own package's row from being switched off is a separate
row inside the package's own patch, explained next.

#### The shipped bundle cannot be switched off or uninstalled

The user asked for one plugin with several components that **cannot be closed**, and the
whole mechanism is one extra row in the bundle's generated patch — the same patch that
inserts the product row:

```yaml
- insert:
    - id: dsharness
      name: ./index.mjs
    - name: '@deepseek-ai/dsh-plugin-manager'
      disabled: true
```

`PluginManager.protectsManager(name)` (`packages/boot/plugin-manager/src/index.ts:763-773`)
is true when **any row a bundle's patch inserts** names a module in that file's
`protectedModules` (`:66-76`), and `@deepseek-ai/dsh-plugin-manager` is one of them. Both
mutations fail, measured on a real `boot()` with the real `PluginManager`:

```text
setBundleEnabled('dsharness', false) → application: 'failed', changed: false, error: { code: 'management-required' }
removeBundle('dsharness')            → application: 'failed', changed: false, error: { code: 'not-removable' }
```

Two details make the shield row invisible and free:

- **It carries no `id`.** `declaredRows` (`:647+`) collects only rows whose `id` is a string,
  so it never reaches the card's row list — the person sees one row, not two.
- **`disabled: true`.** The Loader returns **before** `import()` for a disabled row
  (`vendor/loader/src/config/entry.ts:136-139`), so the module name is never resolved and no
  dependency is added.

The second half of the predicate, `` `include:${row.id}` === this.ownerEntryId ``, is dead
code: `ownerEntryId` (`:207`) is the literal `'include'`, so no row id can produce that
string. The whole protection rests on the module-name half.

#### A profile provisioned before the merge retires the replaced packages

An older build provisioned four separate bundles — `dsharness-model-key`, `dsharness-update`,
`dsharness-update-ui` and `dsharness-host-auth` — so such a profile still names them in the
manifest's `dependencies` and in `dsh.profile.bundles`, and still has their directories under
`node_modules`. Left behind, they would keep running: their rows would mount a second gateway,
a second model-key delivery loop and a **second** update surface — the duplication the merge
exists to remove.

`provision.mjs` retires them explicitly and idempotently. `REPLACED_PLUGINS` is the list;
`planProvisioning(...).retired` and `provisionProfile(...).retired` report it. Retirement
removes the dependency entry, removes the selection, and deletes the directory **before**
placing the replacement — the dependency entry because a manifest that does not declare a
package lets pnpm prune it on the next run, so deleting only the directory would not hold.
This is the one documented exception to "selection only ever grows".

#### One asymmetry worth knowing

`pnpm` prunes a `link:` target that lives outside the profile, so the generated
package is a real directory **inside** `<profile>/node_modules` declared as
`file:./node_modules/<name>` (`pluginInstallSpec`). It also needs no symlink
privilege, which on Windows would otherwise mean Developer Mode.

Our own package is placed directly and needs no package manager at all, so the bundle
works on a machine that has never reached npm; only `dshmarket` goes through pnpm. A failed
marketplace install is reported with the exact manual command and never fails the deployment.

#### A connection cookie already issued outlives the wrap

Measured while the bundle was still switchable: after `setBundleEnabled` disabled it,
`listBundles` said `enabled: false` and `pluginInventory/list` no longer listed the row — yet
a request carrying the correct secret **still got 200** (absent and wrong secrets still 401,
so it is not a vacuous pass). The cleanup restores the `connection` method references, and
the connection cookie already exchanged remains a valid short-lived credential: upstream does
not re-ask who minted it on each request. Nothing here can fix that without touching
upstream's `connection`. The page can no longer reach that state for this bundle, and the
default has always been enabled; to invalidate an issued cookie immediately, change
`DSH_AUTH_TOKEN` and restart — those cookies are signed with the connection secret.

### Server-to-server access to the official `/api` (gateway component of `dsharness.mjs`)

The official `/api` authenticates with a cookie that only a browser holding the launch token `dsh web` printed can obtain (`packages/client/connection/src/browser-auth.ts`). A caller with **no browser** — another product's server, a script, a mini program backend — cannot get one, and should not have to drive a browser to try.

The gateway component of `dsharness.mjs` adds a second credential that lands in the same place: a correct shared secret (`Authorization: Bearer <secret>`, or the cookie this component issues) is converted into a one-request connection cookie and appended to the request. The official checks still run; they just see a request that already satisfies them.

| caller | how it gets in |
|--------|----------------|
| no credential | 401 from the official connection layer — this component does not open anything by itself |
| wrong or short secret | 401, same as above |
| `Authorization: Bearer <secret>` | admitted; covers unary RPC **and** the `/api/remote.mux` upgrade |
| browser on the LAN | `/dsharness/auth` exchanges the secret for a cookie, then `/` and `/api` both work |
| secret unset | one is generated and stored on first run, so the channel works and can be read off `/dsharness/gateway` |

### A stable, reachable bind (`DSH_GATEWAY_PORT` / `DSH_GATEWAY_HOST`)

An external integration stores one address and calls it. The original defect had **two** halves, and
fixing only one of them left the integration still reporting "service unreachable":

1. The Desktop Host launches the Web application with a hard-coded `--port 0`
   (`apps/desktop-host/src/index.ts:30`), so every restart binds a different OS-assigned port.
   Measured on this machine: `19387` now, `58733` in an earlier session, while the integration that
   had stored `:3080` reported "service unreachable" against a healthy listener.
2. The bind was **loopback-only**, and a loopback port is unreachable from another machine *in
   principle* — so even a correct, stable address could not work. This is the half that survives
   pinning the port, and the reason the shipped default is now `0.0.0.0:3080`.

The `webserver` row in `cordis.patch.yml` carries both defaults and both overrides. It is not a new
plugin: `packages/bundle/web-app/cordis.patch.yml:178` already declares that row, and a patch
replaces the targeted row's whole config, so these are the upstream expressions with the deployment
values substituted ahead of the literals.

| value | shipped default | override |
|-------|-----------------|----------|
| host | `0.0.0.0` (every interface) | `DSH_GATEWAY_HOST` |
| port | `3080` | `DSH_GATEWAY_PORT` |

```powershell
node platform/install.mjs                          # prints "host 0.0.0.0, port 3080 (defaults; …)"
node apps/cli/lib/bin.js web --no-open --port 0    # → LAN: http://10.32.250.50:3080/…
```

**No configuration is required, and that is the point**: the machines this deployment targets have
operators who cannot set environment variables, so a default that needed `$env:` would not be a
default. Precedence, highest first — `DSH_GATEWAY_HOST`/`DSH_GATEWAY_PORT`, then an explicit
`--host`/`--port`, then these defaults.

Two deliberate details:

- **`webStartup` still wins over the defaults.** `dsh web --port 13096` keeps its own flag; only a
  deployment variable overrides it. Verified: `DSH_GATEWAY_PORT=13097` with the command line still
  `--port 0` came up on `0.0.0.0:13097` and advertised the LAN address.
- **`port` uses `||`, not `??`.** The Desktop Host always passes `--port 0`, and `0` means "pick any
  free port" — a sentinel, not an answer — so the default has to replace it rather than be shadowed
  by it.

Upstream refuses this bind **from the command line** — `--host 0.0.0.0` exits with
`it would expose remote code execution to the network` (asserted in `apps/cli/tests/built-bin.e2e.ts`).
It is not refused by the schema (`webserver` accepts `'127.0.0.1' | '0.0.0.0'`,
`packages/host/webserver/src/index.ts:127`), and upstream already supports the LAN case:
`resolveLanTrust()` (`packages/bundle/web-app/src/index.ts:136-143`) samples the LAN addresses and
adds them to the trusted set when the bind is `0.0.0.0`. Config is the seam for a deployment that
has decided to take that risk.

⚠️ **What `0.0.0.0` means.** Every caller who can reach the machine can reach the full Harness API,
including shell execution. The command-line gate exists for that reason, and this layer bypasses it
deliberately rather than by accident — which is why `install.mjs` prints the resolved address and a
warning naming the terms. The shared secret (`DSH_AUTH_TOKEN`, written into the deployment layer at
install time) remains **mandatory for every request**: the wider bind is what makes the client
usable, and the secret is what guards it. Set `DSH_GATEWAY_HOST=127.0.0.1` to restrict a machine to
loopback again.

⚠️ **This row is exempt from the "no `config:` for a page-writable namespace" rule**, and
`install.test.mjs` states why in executable form: no `ui-settings*` package edits this namespace
(`ui-settings-account` only listens to `webserver/index-inject`, which injects HTML into the served
index and never touches this row), so the home layer cannot lock a settings page the way an
`llm-pi-ai` entry did. A dedicated test scans those packages and fails if one ever gains an
`edit('webserver')` call, which is the signal to move these two keys into the profile layer.

### The port and the secret have to be readable (`/dsharness/gateway`)

"I cannot integrate with it" was the report, and the reason was structural: the port and the
shared secret existed only inside the process. `dsh web` prints `?token=` once, at startup,
into a terminal — and the desktop application has no terminal at all. So the gateway
component renders both:

| surface | what it gives |
|---------|---------------|
| `GET /dsharness/gateway` | an HTML page: port, local address, shared secret, cookie name, login path, and a copy button |
| `GET /dsharness/gateway.json` | the same facts as JSON, for callers and for the acceptance check |
| `GET /dsharness/secret.json` | the two values themselves, on demand — what the panel's two copy buttons read (see the status-panel section) |

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

These surfaces are registered as `kind: 'exact'` routes and additionally allowed through
`authorizeIndex`: `webServer.match()` checks the exact table first, but `frontend-static`
delegates index requests to `authorizeIndex`, which accepts only `GET /` — so without that
allowance these pages would be reachable only if route registration happened to win the race.
`/dsharness/secret.json` is registered the same way and named in the same `PUBLIC_PATHS` list;
the allow-list only decides whether a request reaches a handler, so the loopback gate inside
each handler stays the thing that refuses an off-host caller.


The gateway component wraps `connection.requestRejection` and `connection.authorizeIndex` instead of registering a route, because `/api` is already claimed: `webServer.register` throws on a duplicate `(kind, path)`, and the upgrade path is registered separately by `api-gateway`. Both admission decisions funnel through those two service methods, so one wrap covers every carrier.

It is **not a second authentication stack**: the Host/Origin fence and the connection-cookie check still decide, no new trust principal appears, and the comparison is `timingSafeEqual`. The whole bundle is zero-dependency `.mjs` (only `node:` imports) because this layer has no `node_modules`: each component reads config as a plain object and the gateway writes the connection key literal (`client-connection/browser-session`, the value `credentialKey(scope, id)` produces).

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

`cordis.patch.yml` addresses upstream-declared rows only, and only ones the settings page
does not write. A patch replaces a row's whole `config`, so an override restates every key
that row owns. No fork-owned plugin is inserted here — it ships as a bundle package instead,
for the reason given above.

| row | upstream default | this deployment |
|-----|------------------|-----------------|
| `deepseek-account` → `platformOrigin` | `https://platform.deepseek.com` | this product's server (`PUBLIC_BASE_URL`) |
| `deepseek-account` → `desktopPlatform` | `null` | the original expression is kept |
| `deepseek-account` → `allowLoopbackHttp` | `false` | enabled unless `DSH_PLATFORM_ALLOW_LOOPBACK_HTTP=0` |
| `llm-deepseek` → `disabled` | mounted | `true` — the built-in DeepSeek card, see below |
| `llm-deepseek-account` → `disabled` | mounted | `true` — its 401 signs the user out, see below |

`llm-pi-ai` and `agent-default-model` are **not** in this table any more, and that is the point
of the next section: both are namespaces 设置 › 模型 writes, and a `config:` for a writable
namespace in this layer does not provide a default — it refuses every write.

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

#### A `config:` in the home layer for a writable namespace is a lock

`llm-pi-ai` and `agent-default-model` used to be written by **both** patch layers — the profile's
own and this file's. That was a bug, and the user reported it as one:

> home 层占了 llm-pi-ai 这个 id，导致无法添加自定义模型 api 了，给我优化一下

`readProfilePatches` (`packages/boot/app-boot/src/profile-context.ts:63-73`) applies the home
layer **after** the profile layer, and `ConfigEditor.edit()`
(`packages/boot/config-editor/src/index.ts:136-141`) accepts a write only when the recomposed
effective config equals the value it is about to write. So a home-layer `config:` for a
namespace the settings page writes can never be edited from the page; every attempt throws

```text
Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay
```

Measured both ways with the real `composeEntries`: with the home row present the namespace
composes to `providers: ["dsharness-relay"]` and the write is refused; with the home row removed
it composes to `["dsharness-relay","my-custom-api"]` and the write is accepted.
`agent-default-model` carries the same defect through
`AgentDefaultModelConfig.saveSelection()` (`packages/core/agent-default-model/src/index.ts:82-94`),
which is how the composer's model choice is saved — so it left this layer too.

The rule that falls out of it, and what `install.test.mjs` now asserts: **this layer may state
`config:` only for rows the settings page does not own.** Today that is `deepseek-account`
(the login surface's own row) and `llm-deepseek-account` (disabled, with an explicitly emptied
`config`); `llm-pi-ai` and `agent-default-model` must stay writable from 设置 › 模型.

A machine upgrading from the shipped `.20261008.2` self-heals on the next provision: copying
that build's home file into a temp home and running the new `install.mjs` turns the managed rows
from `[deepseek-account, llm-pi-ai, agent-default-model, llm-deepseek-account]` into
`[deepseek-account, llm-deepseek, llm-deepseek-account]`.

#### The built-in DeepSeek card is off, and the official models are added instead

> 原本自带的deepseek这个模型配置可以去掉，添加模型供应商时可以选择添加官方的模型。但是默认的可以去掉，默认的只有码农ai这一个模型服务

That card is the `deepseek-official` route, registered by the `llm-deepseek` row
(`packages/llm/llm-deepseek-api-key/src/index.ts:15,36-38`) with `settingsPath: []`. An empty
`settingsPath` counts as always-configured (`ui-settings-models/src/client/store.ts:205-206`),
so the card always renders (`ModelsSection.tsx:341,398`) and is never addable (`:343-346`) nor
removable (`:208-210`). There is therefore **no zero-upstream-change mechanism that hides it
while keeping the route mounted**; the only lever is disabling the row in a deployment layer,
which is what this file does — the same move as the `llm-deepseek-account` disable beside it.

Disabling it does **not** make the official models unreachable. They move to the add-provider
path: `llm-pi-ai` declares every provider in the installed pi-ai catalog as a configurable
provider (`llm-pi-ai/src/index.ts:241-250` plus its `directoryEntries`), and that catalog ships
`deepseek` at `https://api.deepseek.com` with `deepseek-flash` (DeepSeek V4.1 Flash) and
`deepseek-v4-pro`. Unconfigured catalog providers are exactly what 添加模型提供商 ›
第三方模型提供商 lists. Measured: the catalog select holds 41 options including `deepseek`;
adding it reported `已保存 deepseek。` and produced a live route in the composer's model picker.

Only the llm route is affected: `web-search-deepseek` registers into `ctx.web` under its own id
(`web-search-deepseek/src/provider.ts:27`) and never touches `ctx.llm`, so web search keeps its
DeepSeek provider. The escape hatch, for anyone who wants the built-in card back, is to delete
the `llm-deepseek` row from this file — it carries no `config`, so removing it restores upstream
behaviour without touching anything else.

### The Settings › Models page reads its catalog from the profile's own patch layer

The user asked for the model catalog to be there by default, with the input types it supports:

> 码农ai模型配置中的模型目录要默认给我配置好deepseek-v4.1-flash，且输入类型要支持文本和图片

The runtime is served by these rows through `readProfilePatches`
(`packages/boot/app-boot/src/profile-context.ts:63`) as *bundle layers → the profile's patch →
`$DSH_HOME/cordis.patch.yml` → overlays*, last write wins — yet the page said
「正在使用适配器默认模型」 (the adapter's default model) and showed no models. The reason is that
the page reads a **different set of layers** than the runtime:

| reader | layers it composes | winner per row id |
|--------|--------------------|-------------------|
| the runtime (`readProfilePatches`) | bundle layers → profile patch → home patch → overlays | **last** |
| Settings › Models (`ConfigEditor.configuration()`, `packages/boot/config-editor/src/index.ts:49-70`) | bundle layers + the profile's patch only | **first** |

First-row-wins is why a bundle-layer override can never fix the page: every profile's bundle list
starts with `@deepseek-ai/dsh-base`, and that bundle already declares `- id: llm-pi-ai`
(`packages/bundle/base/cordis.patch.yml:127`) with no `providers`, so that empty row is the one
the card inherits. A row in the **profile's own** patch does win for the page (it becomes the
card's override, which renders as 「已自定义模型目录」 + 「恢复默认模型」), so that is where the
catalog goes.

The home layer is not an option for it either, and that is a second, independent reason: it is
applied **after** the profile layer, so a `config:` there for a writable namespace refuses every
write from the page (the lock described above). Both constraints point at the same layer, so the
catalog has exactly one home:

`provision.mjs` writes a managed block into **each profile's own `cordis.patch.yml`**:

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

`MODEL_CATALOG_ROWS` is that pair; `ensureProfileCatalog` writes it, `missingCatalogRows`
decides whether to, `removeProfileCatalog` takes it back (which `install.mjs --remove` calls),
and `provisionProfile` reports what it wrote as `catalog`. **`platform/cordis.patch.yml` carries
neither row** — deliberately, for the lock reason above; a reader who knows `install.mjs` manages
that file would otherwise expect the catalog there.

It never clobbers, and all three rules are in `missingCatalogRows`:

- the profile already has its own `llm-pi-ai` row **outside** the managed block — that catalog is
  the person's or the settings page's, and the whole file is left byte-identical;
- the managed block is already present — rewriting it would undo an edit the page made in place;
- composing the profile with the home layer yields something that is **not** this deployment's —
  an operator replaced the row, and a profile row would then silently take over the
  runtime, so it defers instead.

A rerun on a provisioned profile therefore writes no byte at all.

For the runtime this changes **nothing**: `--dump-config` prints the same `llm-pi-ai` and
`agent-default-model` rows whether the block is present or absent, and whether the home layer
carries a copy or not — they are now composed from `profiles/<name>/cordis.patch.yml` instead of
from `$DSH_HOME/cordis.patch.yml`, which changes only the per-layer provenance comments the dump
emits. Writing it changes what the page shows and what it can save, not what the model runs on.
Measured on a real `dsh web` home with a real Chromium, on a fresh profile: the card shows
「已自定义模型目录」 + 「恢复默认模型」, `模型 ID 1` is `deepseek-v4.1-flash`, `显示名称 1` is
`DeepSeek V4.1 Flash`, the context window is `262144`, the maximum output is `32768` tokens, and
the 输入类型 checkboxes are **文本 checked and 图片 checked**.

The same run is what proves the lock is gone: 设置 › 模型 lists only `码农AI`, and
添加模型提供商 › 自定义模型 API with Provider ID `lead-custom-api`, a base URL, a key and one model
leaves 创建提供商 enabled, after which the card list reads `["码农AI","lead-custom-api"]` and the
write lands in `profiles/web/cordis.patch.yml` under `llm-pi-ai.providers.lead-custom-api`.

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

Only these two LLM rows are disabled — `llm-deepseek` (the built-in DeepSeek card, above) and
this account-backed route. `deepseek-account` itself (login, balance, bonuses, sign-out)
must stay mounted or the whole official account surface disappears, and `web-search-deepseek`
is untouched because it registers into `ctx.web`, not `ctx.llm`.

**This is one known sign-out path, not a complete explanation.** The other paths that can
clear the same credential are: a 401/`code: 40003` from the product's own account endpoints
(`server/src/lib/dsh-account.ts:84-86`, which `tokenVersion` bumps reproduce after a sign-out
or a user suspension); and `issuer-mismatch` at startup, which discards the grant without
sending any request (`.../deepseek-account-platform/src/index.ts:167-176`) — visible in the
Host log as `stored grant discarded`. Diagnosing a report of "thrown back to login" means
checking which of the three it was, not assuming this one.

### The delivery step the key needs (model-key component of `dsharness.mjs`)

The product server has always returned the per-user gateway key at
`GET /api/account/model-access`, and nothing in this fork ever read it: a search for
`model-access`, `apiKeyCreated` and `dshModelKey` across `client/` was zero hits. So the route
above had no credential and every request failed with `MISSING_CREDENTIAL`.

The model-key component of `dsharness.mjs` is that consumer. On the account session's changes
it asks the
product server for the key and writes it into the credential store under
`DSHARNESS_MODEL_KEY` — the reference `llm-pi-ai`'s `apiKeyEnv` names — and removes it on
sign-out or an unauthorized answer. A transport failure keeps the stored key, because a `503`
says nothing about whether the gateway key is still valid.

### Check for updates (update component of `dsharness.mjs`)

The official updater needs `app-update.yml` next to the application resources, and an unsigned
build never gets one: `publish: null` (`apps/desktop/scripts/electron-builder-config.mjs:249`)
means electron-builder writes none (`app-builder-lib/out/publish/PublishManager.js:87-90`),
while `update-coordinator.ts:54` requires exactly that file and `:185` throws without it. The
installer ships one itself (`platform/windows/app-update.yml`), and that is enough, because
`NsisUpdater.verifySignature()` returns null — accepts the package without checking anything —
while `publisherName` is absent (`electron-updater/out/NsisUpdater.js:84-100`). That key is
deliberately not in the file; adding it starts a real Authenticode check and every update would
fail with `ERR_UPDATER_INVALID_SIGNATURE`.

The update component of `dsharness.mjs` serves the answer itself at `/dsharness/update` (HTML)
and
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

### The in-app update entry (browser half `dsharness-ui.js`)

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
touched. `dsharness-ui.js` therefore contributes one row to Settings › General, ordered 90
(between `developer-tools` and `current-version`), whose button calls
`globalThis.dshDesktop?.updates?.open()` and whose status line renders the subscribed
`status()` phase in words. It is the **same** update component the panel shows; there is no
second update plugin and no duplicated copy.

Three details are deliberate, and each is asserted by `dsharness-ui.test.mjs`:

- **The browser half is a classic script, so the bundle is two files.** The client module system
  loads bundles with `document.createElement('script')`
  (`packages/client/modules/src/client/system.ts:16-29`) and reconciles the registration `id`
  against the package name — so `dsharness-ui.js` may only register itself through
  `window.__ModuleLoader__.load(...)` and cannot be an ESM plugin, while Node imports the bundle
  row's ESM entry. The host half is therefore a **real plugin**, `dsharness.mjs`, which mounts
  the three host components as sub-plugins; `provision.mjs`'s `clientEntry` field copies the
  browser half into the package as
  `client.js` — a package needs both to be a bundle row **and** a served browser bundle. The
  registration `id` must equal the package name (`dsharness`) byte for byte.
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

### The component status panel (browser half `dsharness-ui.js`)

Two decisions came from the user here:

> 可以把…这些插件合并成码农 DSH 插件，其中包了多个组件。该插件虽然是已安装的自定义插件，但是是不可以关闭的
> 应该都是不能改的…插件的组件中只是显示组件状态，而不需要显示key的信息

The first is why there is one bundle with four components instead of four packages; the second
is why the panel is display-only. Merging also removed the duplicate: the "check for updates"
Settings row and the panel's update row are now the same update component, not two plugins.

The panel is the `plugins.bundle.config` slot on the bundle's **own card** in the Plugins page
(registered by `key`, which must equal the package name `dsharness`), so the component state is
visible without adding a card or a Loader row. It draws four rows, and the first two carry a
copy button of their own (see below):

| component | state it shows | facts it shows |
|-----------|----------------|----------------|
| 本机网关 (local gateway) | running / off | listening port, local address, whether the shared secret is configured, **and a copy button for the secret** |
| 模型 Key (model key) | synced / not synced / signed out | the credential reference name (`DSHARNESS_MODEL_KEY`), whether it holds a value, **and a copy button for the key** |
| 检查更新 (update check) | up to date / a version is available / not checked yet / check failed | current version, latest version, the live phase, and the button that opens the Desktop update dialog |
| 账号与费用 (account & billing) | signed in / signed out | the user's name (or a masked contact), and the balance per wallet |

The data comes from `GET /dsharness/status.json`, the read-only face the gateway component
registers. Its fields are exactly:

```text
{ok, port, address, tokenConfigured, cookieName, loginPath, gatewayPath,
 version:{current,latest,updateAvailable},
 modelKey:{ref,configured},
 account:{signedIn,name,contact,balance:[{currency,balance}]},
 checkedAt}
```

Two properties are deliberate:

- **It carries no credential.** `tokenConfigured` and `modelKey.configured` are booleans,
  never values; there is no field holding the shared secret or the model key. Reading a value is
  a separate, on-demand request (`/dsharness/secret.json`, next), and the surfaces that show the
  secret are `/dsharness/gateway`, `/dsharness/gateway.json` and that one — all loopback-only.
- **It is loopback-only and read-only.** A non-loopback request gets `403`; a non-`GET` gets
  `405`. Nothing in the panel is writable: no input, no switch, no config form — the panel
  renders the status slot and returns a one-line summary for any other view. The version
  section has a 60 s TTL cache and shares its origin with the update component, so the panel
  and the update page cannot disagree about the latest release.

The browser half polls the face once at mount and then every 10 s, and degrades to "status is
unavailable right now" on a 403, a timeout, or a malformed body — the other rows still render,
and it never throws.

#### Two copy buttons, and a second face that only a click reaches

The user asked for a copy button on two of those rows:

> 码农dsh插件中的本机网关一行右侧要有复制密钥的按钮，点击之后复制共享密钥
> 模型key也是，要有复制key的按钮

Copying a credential is the one action whose whole point is to move a value out, and that
changes which face can serve it. `status.json` cannot: the panel polls it every 10 s, so a
value in it would be sent to every loopback client on a timer. The value therefore has its own
face, read **only** when the button is pressed:

| surface | what it gives | cadence |
|---------|---------------|---------|
| `GET /dsharness/status.json` | state only — booleans, versions, the port | polled every 10 s |
| `GET /dsharness/secret.json` | `{ok, gateway:{token}, modelKey:{ref,value}}` | fetched on a click, and never otherwise |

`/dsharness/secret.json` (`SECRET_JSON_PATH`) is registered `kind: 'exact'` beside the other
faces and added to `PUBLIC_PATHS`, so it is reachable on the same terms: a loopback `GET` gets
`200`, anything non-loopback gets `403`, and a non-`GET` gets `405`. `modelKey.value` comes from
`credentials.resolve('DSHARNESS_MODEL_KEY').value` and degrades to `null` — no store, a
`resolve` that throws, or nothing resolved — rather than failing the request, so a missing
credential reads as a failed copy and not as a 500.

The pinned field set of `status.json` is therefore **unchanged** and still holds no credential;
that is what `dsharness.test.mjs` asserts, field by field, alongside the value face's own
loopback gate.

In the browser half the two buttons sit at the right of the 本机网关 and 模型 Key rows, both rows
keeping their existing state text. A click fetches the value face and calls
`navigator.clipboard.writeText`, then shows 「已复制」 or 「复制失败」 next to the button for two
seconds before returning to idle. Three properties are deliberate and each is asserted by
`dsharness-ui.test.mjs`:

- **The value never renders.** It goes from the response straight into the clipboard; it is
  never put in React state, in props, or in the tree. Only the outcome (idle / copied / failed)
  is state, which is why a rendered panel cannot leak the secret even by accident.
- **A button is disabled when its row has nothing to copy** — `tokenConfigured !== true` for the
  gateway, `modelKey.configured !== true` for the model key.
- **Copy works in a plain browser.** It needs only `fetch` and `navigator.clipboard`, so it does
  not depend on the `dshDesktop` bridge the update button needs. A non-secure context without
  `navigator.clipboard` is treated as a normal environment: the click reports 「复制失败」.

Verified against a real `dsh web` host with the product payload installed and
`DSHARNESS_MODEL_KEY` set, driven in a real Chromium: both buttons enabled, both clicks put the
right value on the actual clipboard (a 30-character gateway secret and a 26-character model key,
each equal to what the face returns), each row showed 「已复制」, neither value appeared anywhere
in the page text, and `status.json` still had exactly
`["account","address","checkedAt","cookieName","gatewayPath","loginPath","modelKey","ok","port","tokenConfigured","version"]`
with no token in it.

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
