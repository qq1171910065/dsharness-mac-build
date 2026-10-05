# dsharness deployment layer (fork-owned; no upstream counterpart)

This directory is the **single home for every change this fork owns**.

Upstream `deepseek-harness` has no `platform/` directory, so:

```sh
git fetch upstream
git merge upstream/master      # can never conflict here
```

## Why not patch-package patches

The previous `client/` (a third-party shell) tracked upstream through
**24 `patch-package` patches, `+3285` lines**, rewriting the built
`@deepseek-ai/*` `lib/client.js` artifacts:

| patch | size | cost |
|-------|------|------|
| `dsh-client-ui-settings-models` | 100 KB / 51 hunks | every upstream bundle rebuild means hand-recomputing hunk headers |
| `dsh-api-session-controller` | 45 KB / 17 files | one upstream move rewrites a whole remote contract |
| `dsh-client-ui-workspace` | 56 KB / 60 hunks | upstream ships no session-row menu slot |

The official harness is designed so that approach is unnecessary:

> There is no privileged core to patch: you extend dsh by mounting a plugin
> beside the others, and registrations are effects that unwind when their
> plugin unloads. -- `docs/architecture.md`

So this layer edits **no upstream file** and uses three public mechanisms:

1. **profile patch layer** (`cordis.patch.yml`) -- override or disable rows by `id`;
2. **cordis plugin packages** (`dsh.bundle.patch` / `dsh.client`) -- add capability;
3. **host configuration** (`$DSH_HOME/cordis.patch.yml`) -- machine-level overrides,
   read for **every** profile including the app-owned `desktop` one.

## Layout

```text
platform/
  cordis.patch.yml     # deployment rows: point the official login at our server
  install.mjs          # merge the above into $DSH_HOME/cordis.patch.yml
  README.md
  README.zh.md
```

## Usage

```sh
node platform/install.mjs                      # defaults (local development)
DSH_PLATFORM_ORIGIN=https://www.czmanong.com node platform/install.mjs
```

The script **merges** rather than overwrites: an existing
`$DSH_HOME/cordis.patch.yml` (for example the `- id: ... / disabled: true` rows the
official plugin manager writes) is preserved.

## What it changes

`cordis.patch.yml` overrides the `deepseek-account` row from
`packages/bundle/base/cordis.patch.yml`. A patch replaces a row's **whole
`config`**, so the entry restates every key that row owns:

| key | upstream default | this deployment |
|-----|------------------|-----------------|
| `platformOrigin` | `https://platform.deepseek.com` | this product's server (`PUBLIC_BASE_URL`) |
| `desktopPlatform` | `null` | the original expression is kept |

(The original `desktopPlatform` expression is
`ctx.get('profileContext')?.name === 'desktop' && ['darwin','win32'].includes(process.platform) ? process.platform : null`
-- the desktop must report `desktop-mac` / `desktop-win`.)

### This one row is what makes "every official login uses Platform" true

The official Electron welcome window's Sign in, the Settings account page, the
desktop onboarding quota page, and the `deepseek-account` model provider all go
through `ctx.deepseekAccount` and only ever talk to `platformOrigin`. Pointing
that row at this product's server routes all of them to the official protocol
surface implemented in `server/src/routes/dsh-account.ts`, which in turn calls the
existing `/api/auth/*` endpoints (WeChat scan / email code / email binding, all
forwarded to the Platform portal by the server).

## The remaining piece: the model route

`llm-deepseek-account` speaks the **Anthropic Messages** protocol
(`packages/llm/llm-deepseek`, `PUBLIC_BASE_URL = https://api.deepseek.com/anthropic`),
while this product's gateway (New API, `ai.czmanong.com`) is **OpenAI-compatible**
`/v1`.

So after login and balance are wired, models must go through `llm-pi-ai`:

- the official `packages/bundle/base/cordis.patch.yml` already mounts
  `llm-pi-ai` (dormant: with an empty `llm-pi-ai:` settings section it registers
  no routes at all);
- what is missing is a **client plugin** (`dsh.client`) that on sign-in and on
  startup fetches `GET {platformOrigin}/api/config` and
  `/api/account/model-access`, then writes the `llm-pi-ai` settings section and
  the `apiKeyEnv` credential reference. That is exactly what the previous shell's
  `src/main/account/provider-sync.ts` did -- but expressed as a plugin instead of
  a main-process source edit.

This piece is **not implemented yet**; see the repository `docs/` plan.