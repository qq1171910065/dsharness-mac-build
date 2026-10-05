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
  install.mjs              merge the above into $DSH_HOME/cordis.patch.yml
  install.test.mjs         the merge rules (7 cases)
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

## What it changes

`cordis.patch.yml` overrides the `deepseek-account` row that `packages/bundle/base/cordis.patch.yml` declares. A patch replaces a row's whole `config`, so the entry restates every key that row owns:

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
