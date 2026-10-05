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
  cordis.patch.yml     deployment rows: point the official login at this product
  install.mjs          merge the above into $DSH_HOME/cordis.patch.yml
  install.test.mjs     the merge rules (7 cases)
  README.md
  README.zh.md
```

## Usage

```sh
node platform/install.mjs
DSH_PLATFORM_ORIGIN=https://www.czmanong.com node platform/install.mjs
```

The script merges instead of overwriting, because the official plugin manager records user toggles (`- id: ...` / `disabled: true`) in that same file.

## What it changes

`cordis.patch.yml` overrides the `deepseek-account` row that `packages/bundle/base/cordis.patch.yml` declares. A patch replaces a row's whole `config`, so the entry restates every key that row owns:

| key | upstream default | this deployment |
|-----|------------------|-----------------|
| `platformOrigin` | `https://platform.deepseek.com` | this product's server (`PUBLIC_BASE_URL`) |
| `desktopPlatform` | `null` | the original expression is kept |
| `allowLoopbackHttp` | `false` | enabled unless `DSH_PLATFORM_ALLOW_LOOPBACK_HTTP=0` |

### Why one row wires every official login

The official Electron welcome window's Sign in, the Settings account page, the desktop onboarding quota page, and the `deepseek-account` model provider all reach the platform through `ctx.deepseekAccount` and talk only to `platformOrigin`. Pointing that row at this product routes all of them to the official protocol surface in `server/src/routes/dsh-account.ts`, which forwards them to the existing `/api/auth/*` endpoints.

### The remaining piece: the model route

`llm-deepseek-account` speaks the Anthropic Messages protocol, while this product's gateway (New API) serves an OpenAI-compatible `/v1`. Models therefore have to run through `llm-pi-ai`, which `packages/bundle/base/cordis.patch.yml` already mounts dormant:

- with an empty `llm-pi-ai` settings section it registers no route at all;
- what is missing is a client plugin that on startup and on sign-in fetches `GET /api/config` and `/api/account/model-access`, then writes the `llm-pi-ai` settings section plus the `apiKeyEnv` credential reference.

That last piece is not implemented yet.
