#!/usr/bin/env node
/**
 * Provision the plugins this product ships into a profile — in the shape the
 * official **Plugins** page (`packages/client/ui-plugin-manager`) can address.
 *
 * ## The two asks, and why both are decided by *packaging*
 *
 * > 我希望把这个插件作为一个自定义插件，默认不启用。
 * > 还有插件市场这个插件，默认启用
 *
 * Both are about two flags on a **package**, not about anything a patch file can
 * say. The page lists packages (`pluginManager/listBundles`) and splits them with:
 *
 * | group | condition |
 * |-------|-----------|
 * | 「已安装」Installed | `installed \|\| !optional` |
 * | 「官方」Official | `optional && !installed` |
 *
 * A row inserted straight from a patch file belongs to no package, so the page
 * never mentions it. Measured on the live desktop Host: the row *was* addressable
 * by `listPlugins` (`patchId: dsharness-host-auth`) while `listBundles` returned
 * nothing for it — so there was no card to switch, which is exactly what the ask
 * is about. `optional` is not deployment-settable either: it comes from the
 * launcher's own `OPTIONAL_BUNDLES` allowlist.
 *
 * What *is* deployment-actionable, and what this script writes, is the pair:
 *
 * - **`installed`** — a real bundle package under the profile's `node_modules`,
 *   named in the profile manifest's `dependencies`. That is what produces the card.
 * - **`enabled`** — membership in `dsh.profile.bundles`. A bundle listed there
 *   contributes its patch layer and runs; one that is merely installed does not.
 *
 * So **默认不启用** is "installed but not selected", and **默认启用** is "installed
 * and selected". Both are then switchable in the page, through the official
 * `setBundleEnabled`, with no mechanism of ours in the loop.
 *
 * Verified by measurement on the running desktop Host: a package with
 * `dsh.bundle.patch` placed in the profile's `node_modules` and named in
 * `dependencies` (but not in `dsh.profile.bundles`) is reported by `listBundles`
 * as `installed: true, enabled: false, removable: true` with its rows, and
 * `--dump-config` composes its row exactly as the package's patch declares it.
 *
 * ### Why no `disabled:` row in any patch layer
 *
 * The obvious alternative — keep inserting our row from `$DSH_HOME/cordis.patch.yml`
 * and write `disabled: true` somewhere — is a dead end, and it is worth recording
 * because it looks right:
 *
 * `readProfilePatches` (`packages/boot/app-boot/src/profile-context.ts:63`) applies
 * layers as *bundle layers → profile's own patch → `$DSH_HOME` patch → overlays*,
 * and a later layer overwrites an earlier one per row id. Measured with the real
 * `applyEntryPatches`:
 *
 * ```text
 * [profile(disabled=false), home(insert + disabled=true)] → disabled=true    ← the user's toggle is lost
 * [home(insert, neutral),   profile(disabled=true)]       → disabled=true    ← default off, toggle sticks …
 * [home(insert, neutral),   profile(disabled=false)]      → disabled=false
 * ```
 *
 * i.e. a default written into our managed block would be the last word and the
 * page's switch could never turn the plugin on. Dropping the `insert` from
 * `platform/cordis.patch.yml` and letting the package own its row removes the
 * question entirely.
 *
 * ### Why the bundle's own row carries a `disabled` shield
 *
 * 用户口径：「该插件虽然是已安装的自定义插件，但是是不可以关闭的」。The switch is
 * `setBundleEnabled`, and the only documented way a bundle refuses it is
 * `protectsManager(name)` → `readOnlyReason: 'management-required'`. That predicate is
 * true when any row the bundle inserts names a `protectedModules` entry, so the bundle's
 * patch carries one extra **id-less**, **disabled** row naming
 * `@deepseek-ai/dsh-plugin-manager`. See {@link pluginPatch} for why that row is
 * invisible on the card and costs nothing at boot. Measured on a real `boot()`:
 * `listBundles()` → `readOnlyReason: 'management-required', removable: false`;
 * `setBundleEnabled('dsharness', false)` → `management-required`;
 * `removeBundle('dsharness')` → `not-removable`.
 *
 * ## What this writes, where
 *
 * 1. `<profile>/node_modules/<name>/` — the bundle package, generated from the
 *    plugin's single source in `platform/`. Inside the profile on purpose: it is a
 *    real dependency of that profile, which is what `listBundles` reports as
 *    `installed`.
 * 2. `<profile>/package.json` — the `dependencies` entry for it, plus the
 *    `dsh.profile.bundles` selection of anything that should start switched on.
 *    A selection is only ever **added**, never removed: what the person switched in
 *    the page is theirs. The one exception is a package a **previous round shipped and
 *    this round replaced** ({@link REPLACED_PLUGINS}) — that one loses both flags and its
 *    directory, because leaving it would run a second copy of the same behaviour.
 * 3. Whatever is missing from a registry, through pnpm (today only `dshmarket`).
 *
 * ## Failure policy
 *
 * Everything here is best-effort and reported. A missing marketplace, no network,
 * or no pnpm must never stop the application from starting, so a failure is
 * printed with the exact manual command and the exit code stays 0.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from './home.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');

/**
 * The dependency spec recorded for a locally generated plugin package.
 *
 * `file:` — and the target is a **real directory inside the profile's own
 * `node_modules`**, not a link to a shared tree. Three properties have to hold at
 * once, and only this form has all three:
 *
 * - pnpm resolves and prunes it like any other dependency, so a later `pnpm
 *   install` in the profile keeps it (a `link:` target outside the profile is what
 *   pnpm prunes away);
 * - it needs no symlink privilege (Windows would otherwise want Developer Mode);
 * - it is the path the profile's own resolution walks first — the same anchor
 *   `resolveBundleDir` uses for profile-owned bundles.
 *
 * @param name - the plugin's package name.
 * @returns the spec written into the profile manifest's `dependencies`.
 */
export function pluginInstallSpec(name) {
  return `file:./node_modules/${name}`;
}

/**
 * Plugins this product ships as profile bundles.
 *
 * `defaultEnabled: false` means installed-but-unselected: the card exists in the
 * page, switched off, ready to be turned on. Nothing else about the deployment
 * differs between the two plugins, which is the point — one mechanism, two states.
 *
 * @property name - package name; the profile manifest's dependency key.
 * @property entry - single-file plugin in `platform/` that becomes `index.mjs`.
 * @property clientEntry - optional browser half in `platform/`; becomes the
 *   package's `client.js`, which is what `exports["./client"]` names.
 * @property rowId - the Loader row the package's patch inserts.
 * @property title - card title (`locale/en.json`), so the card is not the bare name.
 * @property description - card one-liner.
 * @property defaultEnabled - whether to select the bundle on first provisioning.
 */
export const PROFILE_PLUGINS = [
  {
    name: 'dsharness',
    entry: 'dsharness.mjs',
    /*
     * The browser half, copied in as the package's `client.js`.
     *
     * Why it must be a second file: the client module system loads a bundle with
     * `document.createElement('script')` (`packages/client/modules/src/index.ts` →
     * `client/system.ts:16-29`), so it is a **classic script** — no `import`/`export`, and
     * it registers itself through `window.__ModuleLoader__.load({id, factory})`. Node
     * cannot `import()` that file (its first line touches `window`), while the Loader
     * entry must be an ESM plugin. One file cannot be both, so the host half is the entry
     * and this one rides along as `clientEntry`. The registration `id` must equal the
     * package name byte for byte, or the roster drops the bundle silently.
     */
    clientEntry: 'dsharness-ui.js',
    rowId: 'dsharness',
    title: 'DSH Desktop (CoderAI DSH)',
    zhTitle: '码农 DSH',
    /*
     * English card text stays pure ASCII: the generated `locale/en.json` travels inside
     * the NSIS payload and is read back on machines with a non-UTF-8 console, and a
     * mojibake'd card title is not reported as an error anywhere.
     */
    description: 'This product\'s own plugin: local gateway, model key, update check, and a read-only status panel. Cannot be switched off.',
    zhDescription: '本产品自带的插件：本机网关、模型 Key、检查更新，以及一张只读的组件状态面板。随安装包投放，不能关闭或卸载。',
    defaultEnabled: true,
    /*
     * 这一行（由 {@link pluginPatch} 生成）带三段配置，对应三个组件各自的开关：
     * `gateway` 是唯一有部署期输入的一段（密钥来自环境变量）。
     */
    configLines: [
      '        gateway:',
      '          # 留空＝未配置：组件会自己生成一把并写进凭据层（这样网关信息页才有东西可显示）。',
      "          token: !!js process.env.DSH_AUTH_TOKEN ?? ''",
      '          cookieName: dsharness_auth',
      '          loginPage: true',
      '        modelKey: {}',
      '        update: {}',
    ],
  },
];

/**
 * Plugin packages earlier rounds wrote, and this round replaces with {@link PROFILE_PLUGINS}.
 *
 * The merge happened after the product had already shipped four separate bundles, so a
 * profile provisioned by an older build still names them in `dependencies` and in
 * `dsh.profile.bundles`, and still has their directories under `node_modules`. Left
 * behind, they would keep running: their own rows would mount a second gateway, a second
 * model-key delivery loop and a **second** update surface — the exact duplication the
 * merge exists to remove.
 *
 * A dependency the manifest does not declare is a package pnpm prunes on its next run, so
 * removal has to happen in the manifest, not just on disk.
 */
export const REPLACED_PLUGINS = [
  'dsharness-model-key',
  'dsharness-update',
  'dsharness-update-ui',
  'dsharness-host-auth',
];

/**
 * The configured model catalog the 设置 › 模型 page must show, written into each
 * profile's **own** patch layer.
 *
 * ## Why the page needs a different layer from the runtime
 *
 * The runtime and the page answer the same question from two different places, and the
 * home layer can serve neither:
 *
 * - **Runtime.** `readProfilePatches` (`packages/boot/app-boot/src/profile-context.ts:63`)
 *   composes *bundle layers → the profile's patch → `$DSH_HOME/cordis.patch.yml` → overlays*
 *   and applies them to the entry list with last-write-wins per row id. The row written here
 *   is therefore the last one carrying this id that the runtime sees, and it is what
 *   `--dump-config` prints and what the adapter actually serves. The home layer no longer
 *   carries a copy: because it is applied *after* this one, a `config:` there would be the
 *   last word, and `ConfigEditor.edit()` refuses any write whose namespace the home layer
 *   overrides (`config-editor/src/index.ts:136-141`) — every 设置 › 模型 write would throw
 *   `Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay`,
 *   which is what 「home 层占了 llm-pi-ai 这个 id，导致无法添加自定义模型 api 了」 was.
 *   `platform/cordis.patch.yml` states the invariant; `install.test.mjs` asserts it.
 * - **The page.** `ConfigEditor.configuration()`
 *   (`packages/boot/config-editor/src/index.ts:49-70`) never reads the home layer. It
 *   loads *bundle layers + the profile's patch*, then takes the **first** row per id:
 *
 *   ```ts
 *   for (const row of flatten(composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches]))) {
 *     if (!composed.has(row.id)) composed.set(row.id, row)
 *   }
 *   ```
 *
 *   First-row-wins is exactly why a bundle-layer override does not surface: every
 *   profile's bundle list starts with `@deepseek-ai/dsh-base`, and that bundle already
 *   declares `- id: llm-pi-ai` (`packages/bundle/base/cordis.patch.yml:127`), so the
 *   empty bundle row is the first one seen and it is the one that becomes
 *   `namespace.base` — the value `ProviderEditor`'s `inheritedModels()` reads
 *   (`ui-settings-models/src/client/ProviderEditor.tsx:339-342`). With no `models` key
 *   anywhere in it, the card renders 「正在使用适配器默认模型」 and no rows.
 *
 *   A row in the **profile's own** patch wins over the bundle row for `inherited`
 *   (it is the `overridden` branch, `:54` → `this.inherited(...)`, `:72-80`, which
 *   recomposes with the profile row's `config` stripped) and becomes the card's
 *   `override` (`:66-68`), which is the state the page renders as
 *   「已自定义模型目录」 + 「恢复默认模型」.
 *
 * Writing these rows into the profile layer therefore changes **only what the page
 * shows**. For the runtime the same config is composed last, so `--dump-config` prints
 * the same rows either way — measured on a real `dsh web` home: adding the block and
 * removing it again leaves every row byte-identical and changes only the `# == … patched
 * by …` provenance comments the dump emits per layer. {@link catalogDrift} is what keeps
 * that true for an operator's own rows.
 *
 * ## Why writing a user layer is safe here
 *
 * The rows are written only when the profile carries no row for {@link CATALOG_SUBJECT}
 * of its own and the value composed from the home layer is still this deployment's
 * ({@link missingCatalogRows}) — so a person or operator who edited the catalog keeps it,
 * and a rerun on a provisioned profile writes no byte. The bundle's own shield row is not
 * touched; the catalog is not part of it.
 */
export const MODEL_CATALOG_ROWS = [
  {
    id: 'llm-pi-ai',
    body: [
      '    providers:',
      '      dsharness-relay:',
      "        displayName: '码农AI'",
      "        api: 'openai-completions'",
      "        baseURL: 'https://ai.czmanong.com/v1'",
      "        apiKeyEnv: 'DSHARNESS_MODEL_KEY'",
      '        models:',
      "          - id: 'deepseek-v4.1-flash'",
      "            name: 'DeepSeek V4.1 Flash'",
      '            contextWindow: 262144',
      '            maxTokens: 32768',
      "            input: ['text', 'image']",
    ].join('\n'),
  },
  {
    id: 'agent-default-model',
    body: [
      "    provider: 'dsharness-relay'",
      "    model: 'deepseek-v4.1-flash'",
    ].join('\n'),
  },
];

/** The begin marker of the catalog block in a profile patch. */
const CATALOG_BEGIN = '# >>> dsharness model catalog';
/** The end marker of the catalog block. */
const CATALOG_END = '# <<< dsharness model catalog';
/**
 * The row the catalog exists for. The page renders the `llm-pi-ai` card; a profile
 * that already declares this id owns its catalog and is left entirely alone.
 */
const CATALOG_SUBJECT = 'llm-pi-ai';
/** The note above the rows inside the catalog block. */
const CATALOG_NOTE = [
  '# Written by platform/provision.mjs: the deployment model catalog the 设置 › 模型 page',
  "# reads as this profile's own override. Rows are edited from that page; everything",
  '# outside this block is left exactly as it was.',
];

/** One row of {@link MODEL_CATALOG_ROWS}, rendered as YAML at the profile layer. */
function catalogRowText(id) {
  const row = MODEL_CATALOG_ROWS.find((entry) => entry.id === id);
  return [`- id: ${row.id}`, '  config:', row.body].join('\n');
}

/** The full managed block for the ids given, markers included, without a trailing newline. */
function catalogBlockText(ids) {
  return [CATALOG_BEGIN, ...CATALOG_NOTE, ...ids.map(catalogRowText), CATALOG_END].join('\n');
}

/** One file's contents, or the empty string when it is absent. */
function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Leading whitespace of a line. */
function indentOf(line) {
  return /^([ \t]*)/u.exec(line)[1];
}

/**
 * The top-level rows of a patch file.
 *
 * A row starts at the outermost `- ` indentation the file uses; a nested list item
 * (a `config:` list, such as the `models:` entries) is indented deeper and stays part
 * of its parent's text. Only `id` and the `config:` value are read, so a row this
 * function does not model (`insert:`, a row with no `id`) is still recognized as a
 * boundary.
 *
 * @param text - patch file contents.
 * @returns one `{ id, config }` per row; `config` is the value's text dedented one
 *   level from the `config:` key, or `undefined` when the row declares no block value.
 */
function parseRows(text) {
  const rows = [];
  let row;
  for (const line of text.split('\n')) {
    const start = /^([ \t]*)- (.*)$/u.exec(line);
    if (start !== null && (row === undefined || start[1].length <= row.indent.length)) {
      const id = /^id:\s*(\S+)\s*$/u.exec(start[2]);
      row = { id: id === null ? undefined : id[1], indent: start[1], lines: [line] };
      rows.push(row);
      continue;
    }
    if (row !== undefined) row.lines.push(line);
  }
  return rows.map(({ id, lines }) => ({ id, config: configTextOf(lines) }));
}

/**
 * The value of a row's `config:` key: the lines below it, dedented by the indentation
 * the value actually uses.
 *
 * The value's own indent is read from its first line rather than assumed to be one
 * column past `config:`, because a hand-written patch file or a YAML dumper may use any
 * deeper indent, and a wrong guess would turn every comparison into a mismatch.
 *
 * @param lines - the row's lines, starting at its `- ` line.
 * @returns the value's text, or `undefined` when the row declares no `config:` block.
 */
function configTextOf(lines) {
  const at = lines.findIndex((line) => /^\s+config:\s*$/u.test(line));
  if (at < 0) return undefined;
  const rest = lines.slice(at + 1);
  const first = rest.find((line) => line.trim() !== '');
  if (first === undefined || !first.startsWith(`${indentOf(lines[at])} `)) return '';
  const valueIndent = indentOf(first);
  const kept = [];
  for (const line of rest) {
    if (line.trim() === '') continue;
    if (!line.startsWith(valueIndent)) break;
    kept.push(line.slice(valueIndent.length));
  }
  return kept.join('\n');
}

/** The `id → config` rows of a patch file with the managed block removed. */
function rowsOutsideCatalog(text) {
  const outside = replaceCatalogBlock(text, '');
  const rows = new Map();
  for (const row of parseRows(outside)) if (row.id !== undefined) rows.set(row.id, row.config);
  return rows;
}

/** The last `config:` value one id composes to over the patch files given. */
function composedBody(id, ...texts) {
  let found;
  for (const text of texts) {
    for (const row of parseRows(text)) if (row.id === id && row.config !== undefined) found = row.config;
  }
  return found;
}

/** The body of one {@link MODEL_CATALOG_ROWS} entry, dedented one level. */
function catalogBodyOf(id) {
  const row = MODEL_CATALOG_ROWS.find((entry) => entry.id === id);
  return row.body.split('\n').map((line) => line.slice(4)).join('\n');
}

/**
 * Whether writing the catalog would **change what the runtime serves**.
 *
 * The home layer is what `readProfilePatches`
 * (`packages/boot/app-boot/src/profile-context.ts:63`) applies last for the runtime. This
 * deployment writes no catalog row there any more, so the only way a home answer exists
 * for one of these ids is an operator's own row — and composing it with the profile layer
 * answers whether the row about to be written would then be shadowed:
 *
 * - nothing composes for the id → writing it is the only way that id ever reaches the
 *   page, and the runtime keeps the bundle default, so this is not drift;
 * - the composed value is this deployment's → the profile row is a no-op for the runtime;
 * - anything else → an operator answered for the id in the home layer, and since that
 *   layer wins for the runtime while the **page** takes the first row (the profile's), a
 *   profile row here would show a catalog the runtime does not use.
 *
 * The last case defers rather than writes: the operator's catalog stays the only
 * catalog, and the page keeps its inherited state. That is deliberate — this row is
 * written into a file the settings page and the plugin manager share, and inventing a
 * page-only catalog over an operator's would be the exact "clobber someone else's
 * catalog" this guard exists to prevent.
 *
 * @param profileDir - the profile directory.
 * @param ids - the ids being considered.
 * @returns whether any of them would be shadowed by the home layer.
 */
function catalogDrift(profileDir, ids) {
  const home = readOptional(join(dirname(dirname(profileDir)), 'cordis.patch.yml'));
  const own = readOptional(join(profileDir, 'cordis.patch.yml'));
  for (const id of ids) {
    const current = composedBody(id, own, home);
    if (current !== undefined && current !== catalogBodyOf(id)) return true;
  }
  return false;
}

/**
 * The catalog ids that must be added to a profile's own patch layer.
 *
 * Empty in the three cases where the profile already answers the question, which is
 * the whole "idempotent and never clobber" behaviour:
 *
 * - the profile carries a `config` row for {@link CATALOG_SUBJECT} outside the managed
 *   block: that is the person's (or the settings page's) catalog and is left alone;
 * - the managed block exists: it is this layer's, and rewriting it would undo edits
 *   the settings page made in place;
 * - composing the home layer with the profile layer yields a value that is not this
 *   deployment's: an operator answered for the id inside the home layer, which wins for
 *   the runtime, so a profile row would show the page a catalog the runtime ignores.
 *
 * @param profileDir - the profile directory.
 * @returns the ids to write, in {@link MODEL_CATALOG_ROWS} order.
 */
export function missingCatalogRows(profileDir) {
  const text = readOptional(join(profileDir, 'cordis.patch.yml'));
  if (text.includes(CATALOG_BEGIN)) return [];
  const own = rowsOutsideCatalog(text);
  /*
   * The row the page actually renders is `llm-pi-ai`. A profile that already names it
   * has an owner for the catalog, so the whole file is left byte-identical: appending
   * only `agent-default-model` would edit the person's document without fixing anything
   * the page shows.
   */
  if (own.get(CATALOG_SUBJECT) !== undefined) return [];
  const ids = MODEL_CATALOG_ROWS
    .filter((row) => own.get(row.id) === undefined)
    .map((row) => row.id);
  if (ids.length === 0 || catalogDrift(profileDir, ids)) return [];
  return ids;
}

/**
 * Give a profile's own patch layer the deployment catalog the settings page reads.
 *
 * Byte-preserving outside the managed block, and a no-op when
 * {@link missingCatalogRows} is empty — so a rerun writes nothing, a catalog the person
 * already has is never overwritten, and rows the page edited in place inside the block
 * stay as the page left them. What keeps such an in-place edit from being undone is that
 * {@link missingCatalogRows} returns empty as soon as `CATALOG_BEGIN` is present: this
 * function only ever writes into a file whose block is absent.
 *
 * @param profileDir - the profile directory.
 * @returns the ids written; empty when the profile needed nothing.
 */
export function ensureProfileCatalog(profileDir) {
  const ids = missingCatalogRows(profileDir);
  if (ids.length === 0) return [];
  const path = join(profileDir, 'cordis.patch.yml');
  writeFileSync(path, replaceCatalogBlock(readOptional(path), catalogBlockText(ids)), 'utf8');
  return ids;
}

/**
 * Remove the managed catalog block from a profile patch, leaving everything else.
 * @param profileDir - the profile directory.
 * @returns whether a block was present.
 */
export function removeProfileCatalog(profileDir) {
  const path = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  if (!text.includes(CATALOG_BEGIN)) return false;
  const merged = replaceCatalogBlock(text, '');
  if (merged.trim() === '') rmSync(path, { force: true });
  else writeFileSync(path, merged, 'utf8');
  return true;
}

/**
 * Whether a patch file carries a YAML value of its own — a row, or any scalar other
 * than an empty sequence.
 *
 * The profile template's `[]` is the one value that does not count: a flow sequence
 * cannot share a document with the block sequence a row needs, so a file whose only
 * value is `[]` is empty for this purpose and the marker is dropped when rows are
 * appended.
 */
function hasYamlValue(text) {
  return text.split('\n').some((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#') && !/^\[\s*\]$/u.test(trimmed);
  });
}

/** A file's text without its empty flow-sequence markers, so rows can follow its comments. */
function withoutEmptySequence(text) {
  return text.split('\n').filter((line) => !/^\s*\[\s*\]\s*$/u.test(line)).join('\n').trimEnd();
}

/**
 * Replace the managed catalog block in a patch file, or append one when absent.
 *
 * Idempotent, and content-preserving outside the block: comments, operator rows and
 * everything the settings page wrote keep their exact text and order, and the block is
 * replaced in place rather than appended again. A begin marker with no end marker (a
 * hand-edited or truncated file) is treated as running to the end, so a damaged block
 * can never be duplicated.
 *
 * The profile patch `initProfile` creates is a comment header followed by `[]`
 * (`packages/boot/app-boot/src/profile.ts:230-234`), and rows cannot follow a flow
 * sequence in the same document — appending to it produces YAML the loader refuses
 * (`end of the stream or a document separator is expected`). That empty sequence is
 * dropped when the block goes in, and written back when a removal would otherwise
 * leave a document with no value at all.
 *
 * @param existing - current file contents.
 * @param block - rows to manage, or the empty string to remove the block.
 * @returns the merged contents, ending with exactly one newline.
 */
export function replaceCatalogBlock(existing, block) {
  const raw = String(existing ?? '');
  const body = String(block ?? '').trimEnd();
  const managed = body === '' ? '' : `${body}\n`;
  const start = raw.indexOf(CATALOG_BEGIN);
  if (start < 0 && managed === '') return raw;
  const end = start < 0 ? -1 : raw.indexOf(CATALOG_END, start);
  const before = withoutEmptySequence(start < 0 ? raw : raw.slice(0, start));
  const after = withoutEmptySequence(end < 0 ? '' : raw.slice(end + CATALOG_END.length));
  const parts = [before, managed.trim(), after].filter((part) => part !== '');
  const merged = parts.join('\n\n');
  if (!hasYamlValue(merged)) return merged === '' ? '[]\n' : `${merged}\n[]\n`;
  return `${merged}\n`;
}

/**
 * The community plugin marketplace, installed from npm and selected by default.
 *
 * `dshmarket` (`github.com/dsh-market/dsh-market`) is the **插件市场** page: browse,
 * search, and one-click install of community plugins. It is a third-party package,
 * so it is installed through pnpm rather than vendored, and it is default-enabled
 * per the product decision.
 */
export const MARKETPLACE_PACKAGE = 'dshmarket';

/**
 * The shield row that makes the whole bundle unclosable.
 *
 * The Plugins page decides `readOnlyReason: 'management-required'` from
 * `PluginManager.protectsManager(name)`
 * (`packages/boot/plugin-manager/src/index.ts:763-773`), which is true when **any row
 * this bundle's patch inserts** names a module in that file's `protectedModules`
 * (`:66-76`) — and `@deepseek-ai/dsh-plugin-manager` is one of them. So one extra row is
 * the entire mechanism: it needs no code of ours, no upstream change, and no new service.
 *
 * Two properties make the row invisible and harmless:
 *
 * - **No `id`.** `declaredRows` (`:647`) collects only rows whose `id` is a string, so
 *   this one never reaches the card's row list — the person sees one row, not two.
 * - **`disabled: true`.** The Loader returns *before* `init()` for a disabled row
 *   (`vendor/loader/src/config/entry.ts:136-139`), so the module is never imported and
 *   the name need not resolve at all. Measured on a real `boot()`: the row reports
 *   `{enabled: false, fiberPhase: null}` and nothing logs an import failure.
 *
 * Why `@deepseek-ai/dsh-plugin-manager` and not one of the client rows: the protection is
 * on the *bundle*, and a name used only as an unimported shield costs nothing. Choosing a
 * row that actually runs would mean shipping a second live copy of it.
 */
const SHIELD_ROW_NAME = '@deepseek-ai/dsh-plugin-manager';

/**
 * The bundle's Loader patch.
 *
 * Two rows, and the reasons are different:
 *
 * - the product's own row (`id: ${plugin.rowId}`), which is the plugin;
 * - the id-less shield row above, whose only job is to pin the bundle's read-only state.
 *
 * `configLines` carries each plugin's own config block; a plugin without one gets a row
 * with no `config` key at all, which Cordis accepts and the plugin's own `resolveConfig`
 * turns into its defaults.
 *
 * @param plugin - one {@link PROFILE_PLUGINS} entry.
 * @returns the patch file contents.
 */
function pluginPatch(plugin) {
  const row = [
    '# dsharness bundle patch: the product row plus the shield that locks this bundle.',
    '# Neither row carries `disabled` on the product row: selection is the switch the',
    '# Plugins page writes — except that the shield below makes that switch read-only.',
    '- insert:',
    `    - id: ${plugin.rowId}`,
    '      name: ./index.mjs',
  ];
  if (plugin.configLines !== undefined) {
    row.push('      config:');
    row.push(...plugin.configLines);
  }
  row.push(
    '    # No `id` on purpose: `declaredRows` only lists rows whose id is a string, so this',
    '    # one never shows up as a phantom row on the card. Being switched off means the Loader',
    '    # returns before importing it, so the name below is never resolved.',
    `    - name: '${SHIELD_ROW_NAME}'`,
    '      disabled: true',
    '',
  );
  return row.join('\n');
}

/**
 * `package.json` for a generated plugin package.
 *
 * A plugin with a browser half additionally declares the two fields the client
 * roster reads: `exports["./client"]` (the bundle the shell serves, resolved by
 * `clientExportOf` in `packages/client/modules/src/index.ts:195`) and
 * `dsh.client.platform: 'web'` (the activation scan's filter, `:841`). The
 * spellings matter and are the whole reason `dsh.client` exists here: a
 * misspelled subkey is not a warning anywhere — `parseDshClient`
 * (`.../modules/src/client/manifest.ts:161`) only ever looks at `platform`, and
 * an unrecognized sibling is silently ignored, so the bundle would simply never
 * be served and the row would render nothing.
 *
 * @param plugin - one {@link PROFILE_PLUGINS} entry.
 * @returns the manifest file contents.
 */
function pluginManifest(plugin) {
  const hasClient = plugin.clientEntry !== undefined;
  return `${JSON.stringify({
    name: plugin.name,
    version: '1.0.0',
    private: true,
    description: plugin.description,
    type: 'module',
    main: './index.mjs',
    ...hasClient ? { dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }
      : { dsh: { bundle: { patch: './cordis.patch.yml' } } },
    exports: {
      '.': './index.mjs',
      ...hasClient ? { './client': './client.js' } : {},
      './cordis.patch.yml': './cordis.patch.yml',
      './locale/*.json': './locale/*.json',
      './package.json': './package.json',
    },
  }, undefined, 2)}\n`;
}

/**
 * Write one plugin package into a profile's `node_modules`.
 *
 * It goes **inside the profile** rather than pointing at a shared directory with a
 * link, and the entry is a **copy** rather than a symlink/junction. All three
 * choices are deliberate:
 *
 * - a real directory needs no link privilege (Windows would otherwise want
 *   Developer Mode for symlinks);
 * - it lands on the path the profile's own resolution walks first, which is the
 *   same anchor `resolveBundleDir` uses for profile-owned bundles;
 * - copying matches what the loader already assumes elsewhere — the installed
 *   artifact is a copy and `platform/<file>` stays the only place to edit. The
 *   gateway plugin is one dependency-free `.mjs`, so the copy is small, and
 *   re-running provisioning refreshes it.
 *
 * The row's `name` is relative to the package's own patch file, which
 * `anchorInsertedPluginNames` rewrites against that file's directory
 * (`packages/boot/app-boot/src/index.ts:347`) — so the package can be moved or
 * copied without the row pointing anywhere else.
 *
 * A plugin with a `clientEntry` additionally gets that file copied in as
 * `client.js`, the name `exports["./client"]` declares. Copied, not linked, for
 * the same reason as the host half: the installed package is self-contained and
 * `platform/` stays the single place to edit.
 *
 * @param pluginDir - the destination package directory.
 * @param plugin - one {@link PROFILE_PLUGINS} entry.
 * @returns the package directory.
 */
export function writePluginPackage(pluginDir, plugin) {
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(join(pluginDir, 'locale'), { recursive: true });
  const source = join(here, plugin.entry);
  if (!existsSync(source)) throw new Error(`missing ${source}`);
  cpSync(source, join(pluginDir, 'index.mjs'));
  if (plugin.clientEntry !== undefined) {
    const clientSource = join(here, plugin.clientEntry);
    if (!existsSync(clientSource)) throw new Error(`missing ${clientSource}`);
    cpSync(clientSource, join(pluginDir, 'client.js'));
  }
  writeFileSync(join(pluginDir, 'cordis.patch.yml'), pluginPatch(plugin), 'utf8');
  writeFileSync(join(pluginDir, 'package.json'), pluginManifest(plugin), 'utf8');
  writeFileSync(
    join(pluginDir, 'locale', 'en.json'),
    `${JSON.stringify({ meta: { title: plugin.title, description: plugin.description } }, undefined, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(pluginDir, 'locale', 'zh.json'),
    `${JSON.stringify({ meta: { title: plugin.zhTitle ?? plugin.title, description: plugin.zhDescription ?? plugin.description } }, undefined, 2)}\n`,
    'utf8',
  );
  return pluginDir;
}

/**
 * Read a profile manifest, or undefined when the profile is not initialized yet.
 * @param profileDir - the profile directory.
 * @returns the parsed manifest.
 */
export function readManifest(profileDir) {
  const path = join(profileDir, 'package.json');
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Write a profile manifest back.
 *
 * Two spaces and a trailing newline, matching `initProfile`
 * (`packages/boot/app-boot/src/profile.ts:254`) so our edits produce no
 * formatting churn next to the rest of the profile.
 *
 * @param profileDir - the profile directory.
 * @param manifest - the manifest to write.
 */
function writeManifest(profileDir, manifest) {
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
}

/**
 * The bundle selections to add, and the packages to obtain, for one profile.
 *
 * Pure so the spec can assert the whole policy without touching a filesystem. The
 * split between the two lists is the point:
 *
 * - **`link`** — our own packages. They are generated locally, so they are placed
 *   under the profile's `node_modules` and recorded as a dependency directly, with
 *   no package manager and no network in the loop. That matters because the
 *   gateway plugin must work on a machine that has never reached npm.
 * - **`add`** — registry packages, today only the marketplace. These need pnpm.
 *
 * @param manifest - the current profile manifest.
 * @param options - `plugins` overrides the shipped list; `withMarketplace: false`
 *   drops the marketplace; `specOf` overrides the recorded dependency spec for our
 *   own packages (defaults to {@link pluginInstallSpec}); `replaced` overrides the
 *   package names a previous round shipped (defaults to {@link REPLACED_PLUGINS}).
 * @returns what to obtain, what to select, and what a previous round left behind.
 */
export function planProvisioning(manifest, options = {}) {
  const plugins = options.plugins ?? PROFILE_PLUGINS;
  const withMarketplace = options.withMarketplace !== false;
  const specOf = options.specOf ?? ((plugin) => pluginInstallSpec(plugin.name));
  const dependencies = manifest.dependencies ?? {};
  const selected = manifest.dsh?.profile?.bundles ?? [];
  const wanted = withMarketplace
    ? [...plugins.map((plugin) => ({ ...plugin, external: false })), { name: MARKETPLACE_PACKAGE, defaultEnabled: true, external: true }]
    : plugins.map((plugin) => ({ ...plugin, external: false }));
  const link = [];
  const add = [];
  const select = [];
  for (const plugin of wanted) {
    if (!Object.hasOwn(dependencies, plugin.name)) {
      const entry = { name: plugin.name, spec: plugin.external ? plugin.name : specOf(plugin) };
      (plugin.external ? add : link).push(entry);
    }
    /*
     * Selection is only ever ADDED. A bundle the person switched on from the page
     * is theirs, and a bundle they switched off must stay off — so a plugin whose
     * `defaultEnabled` is false is never selected here, not even on the first run.
     */
    if (plugin.defaultEnabled === true && !selected.includes(plugin.name)) select.push(plugin.name);
  }
  /*
   * Retirement is the one exception to "selection only grows": a package this round
   * *replaces* must lose both flags, or it keeps running beside its replacement.
   *
   * A profile provisioned by an earlier build names the four old bundles in
   * `dependencies` AND in `dsh.profile.bundles`. Clearing only the selection would
   * leave them installed-but-off (still listed as cards); clearing only the dependency
   * would leave a selection nothing resolves, which the Loader reports as a skipped
   * bundle on every boot. Both are cleared, and the directories are deleted, so the
   * replacement is the only copy.
   */
  const retired = (options.replaced ?? REPLACED_PLUGINS)
    .filter((name) => Object.hasOwn(dependencies, name) || selected.includes(name))
    .filter((name) => !wanted.some((plugin) => plugin.name === name));
  return { link, add, install: [...link, ...add], select, retired };
}

/** Resolve the pnpm entry this repository already depends on, falling back to PATH. */
function pnpmCommand() {
  for (const candidate of [join(clientDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')]) {
    if (existsSync(candidate)) return { file: process.execPath, args: [candidate] };
  }
  return { file: 'pnpm', args: [] };
}

/**
 * Run pnpm in the profile directory.
 *
 * `ELECTRON_RUN_AS_NODE` is dropped from the child environment: this script can be
 * launched from inside the desktop app, and inheriting it would make the spawned
 * Node behave as a plain Electron rather than as a package manager.
 *
 * @param profileDir - working directory for pnpm.
 * @param args - pnpm arguments.
 * @returns exit code and combined output.
 */
function runPnpm(profileDir, args) {
  const { file, args: prefix } = pnpmCommand();
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(file, [...prefix, ...args], {
    cwd: profileDir,
    env: environment,
    encoding: 'utf8',
    shell: process.platform === 'win32' && file === 'pnpm',
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    error: result.error === undefined ? undefined : String(result.error),
  };
}

/**
 * Bring one profile to the wanted plugin state.
 *
 * Order matters, and it is not the obvious one:
 *
 * 1. **Generate and place our packages first**, into the profile's own
 *    `node_modules`, and record the dependency. No package manager runs, so the
 *    gateway plugin works on a machine that has never reached npm.
 * 2. **Then `pnpm add` whatever is missing from a registry** (today only the
 *    marketplace). Measured: `pnpm add` in the profile keeps a hand-placed package
 *    that the manifest declares with `file:./node_modules/<name>` — its only
 *    network operation is the new package.
 * 3. **Then re-read the manifest and add selections.** pnpm has just rewritten it,
 *    so writing from the copy read before step 2 would drop the dependency it
 *    recorded — and a dependency that is not in the manifest is a package pnpm
 *    prunes on the next run, i.e. the plugin would silently disappear.
 *
 * @param home - the Harness home.
 * @param profile - the profile name.
 * @param options - `plugins`, `withMarketplace`, `write: false` for a dry run,
 *   and `run` to inject a fake pnpm runner.
 * @returns a report of what was installed, selected, and skipped.
 */
export function provisionProfile(home, profile, options = {}) {
  const profileDir = join(home, 'profiles', profile);
  const manifest = readManifest(profileDir);
  if (manifest === undefined) {
    return { profile, status: 'skipped', reason: 'profile not initialized' };
  }
  const plugins = options.plugins ?? PROFILE_PLUGINS;
  const plan = planProvisioning(manifest, {
    plugins,
    withMarketplace: options.withMarketplace !== false,
    specOf: (plugin) => pluginInstallSpec(plugin.name),
  });
  if (options.write === false) return { profile, status: 'planned', ...plan, catalog: missingCatalogRows(profileDir) };

  /*
   * 0. Retire the packages a previous round shipped, **before** anything is written.
   *
   * Doing it first is what makes the change observable in one run: the replacement is
   * placed immediately afterwards, so a profile never boots with both the old bundles and
   * the new one. Both flags have to go, for the reasons in {@link planProvisioning}.
   */
  const retired = [];
  {
    const current = readManifest(profileDir);
    const dependencies = { ...current.dependencies };
    const selected = current.dsh?.profile?.bundles ?? [];
    let touched = false;
    for (const name of plan.retired) {
      rmSync(join(profileDir, 'node_modules', name), { recursive: true, force: true });
      retired.push(name);
      if (Object.hasOwn(dependencies, name)) {
        delete dependencies[name];
        touched = true;
      }
    }
    const kept = selected.filter((name) => !plan.retired.includes(name));
    if (kept.length !== selected.length) touched = true;
    if (touched) {
      current.dependencies = dependencies;
      current.dsh = { ...current.dsh, profile: { ...current.dsh?.profile, bundles: kept } };
      writeManifest(profileDir, current);
    }
  }

  /*
   * 1. Our own packages: **always rewritten**, generated locally, no package manager.
   *
   * Rewriting unconditionally (not only when the dependency is missing) is what
   * keeps `platform/host-auth.mjs` the single source of truth: the installed
   * `index.mjs` is a copy, so an edit that did not refresh the copy would appear
   * to do nothing on a machine that had already provisioned once. Measured: the
   * first version refreshed only on first install, and a plugin edit was silently
   * ignored on the next `install.mjs`.
   */
  const refreshed = [];
  const installed = [];
  {
    const current = readManifest(profileDir);
    current.dependencies = { ...current.dependencies };
    for (const plugin of plugins) {
      writePluginPackage(join(profileDir, 'node_modules', plugin.name), plugin);
      refreshed.push(plugin.name);
      if (!Object.hasOwn(current.dependencies, plugin.name)) {
        current.dependencies[plugin.name] = pluginInstallSpec(plugin.name);
        installed.push(plugin.name);
      }
    }
    writeManifest(profileDir, current);
  }

  /* 2. Registry packages, through pnpm. */
  const failures = [];
  const added = [];
  if (plan.add.length > 0) {
    const run = options.run ?? runPnpm;
    const result = run(profileDir, ['add', ...plan.add.map((entry) => entry.spec), '--config.confirmModulesPurge=false']);
    if (result.status !== 0) {
      failures.push({
        what: plan.add.map((entry) => entry.name).join(', '),
        reason: (result.error ?? result.output.split('\n').slice(-4).join(' ')).trim(),
      });
    } else {
      added.push(...plan.add);
    }
  }

  /* 3. Selections, from the manifest as pnpm left it. */
  const after = readManifest(profileDir) ?? manifest;
  const selected = after.dsh?.profile?.bundles ?? [];
  const installedNames = new Set(Object.keys(after.dependencies ?? {}));
  /*
   * Selection only ever grows, and only for a package that is really installed:
   * a name in `dsh.profile.bundles` that nothing resolves is reported as a skipped
   * bundle on every single boot. A registry install that just failed is exactly
   * that case, and the spec caught it here first.
   */
  const select = plan.select.filter((name) => !selected.includes(name) && installedNames.has(name));
  if (select.length > 0) {
    after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: [...selected, ...select] } };
    writeManifest(profileDir, after);
  }

  /*
   * 4. The model catalog the 设置 › 模型 page reads, into the profile's own patch layer.
   *
   * Last, and after every manifest write: the write is the one part that changes what the
   * settings page shows rather than what boots (see {@link MODEL_CATALOG_ROWS}), and it is
   * a no-op — no file touched at all — on every run after the first.
   */
  const catalog = ensureProfileCatalog(profileDir);

  return {
    profile,
    status: failures.length === 0 ? 'ok' : 'partial',
    installed: [...installed, ...added.map((entry) => entry.name)],
    refreshed,
    retired,
    catalog,
    selected: select,
    failures,
  };
}

/**
 * Take back what {@link provisionProfile} installed, for `install.mjs --remove`.
 *
 * Only what this script owns: our generated packages, their dependency entries,
 * and the marketplace **selection** (never its installation — a package the person
 * may have installed themselves stays, and so does anything else in the manifest).
 *
 * @param home - the Harness home.
 * @param profile - the profile name.
 * @param options - `plugins` overrides the shipped list.
 * @returns what was removed.
 */
export function unprovisionProfile(home, profile, options = {}) {
  const profileDir = join(home, 'profiles', profile);
  const manifest = readManifest(profileDir);
  if (manifest === undefined) return { profile, status: 'skipped', removed: [] };
  const plugins = options.plugins ?? PROFILE_PLUGINS;
  const names = new Set([...plugins.map((plugin) => plugin.name), ...REPLACED_PLUGINS, MARKETPLACE_PACKAGE]);
  const removed = [];
  const dependencies = { ...manifest.dependencies };
  for (const name of [...plugins.map((plugin) => plugin.name), ...REPLACED_PLUGINS]) {
    rmSync(join(profileDir, 'node_modules', name), { recursive: true, force: true });
    if (Object.hasOwn(dependencies, name)) {
      delete dependencies[name];
      removed.push(name);
    }
  }
  const bundles = (manifest.dsh?.profile?.bundles ?? []).filter((name) => !names.has(name));
  manifest.dependencies = dependencies;
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } };
  writeManifest(profileDir, manifest);
  // The catalog is ours too, and it is the one thing here that lives in the patch file
  // rather than the manifest; only the block is taken back, never the rest of the file.
  const catalog = removeProfileCatalog(profileDir);
  return { profile, status: 'ok', removed, catalog };
}

/** Profile directories to provision, excluding the shared dependency tree. */
function profileNames(home, requested) {
  if (requested.length > 0) return requested;
  const dir = join(home, 'profiles');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => entry.name);
}

/**
 * Provision every profile under a Harness home.
 *
 * The single entry point `install.mjs` calls, so the deployment rows and the
 * plugin packages are always written together — a profile that got the rows but
 * not the packages would have a patch layer pointing at nothing.
 *
 * @param home - the Harness home.
 * @param options - `profiles` overrides the discovered list; otherwise see
 *   {@link provisionProfile}.
 * @returns one report per profile, in discovery order.
 */
export function provisionAll(home, options = {}) {
  return profileNames(home, options.profiles ?? []).map(
    (profile) => provisionProfile(home, profile, options),
  );
}

function main() {
  const args = process.argv.slice(2);
  const home = resolveDshHome();
  const dryRun = args.includes('--check');
  const withMarketplace = !args.includes('--no-marketplace');
  const requested = args.filter((arg) => !arg.startsWith('-'));
  const profiles = profileNames(home, requested);
  if (profiles.length === 0) {
    process.stdout.write(`[platform] no profile under ${join(home, 'profiles')}; nothing to provision\n`);
    return;
  }
  const reports = provisionAll(home, { profiles, withMarketplace, write: !dryRun });
  for (const line of describeReports(reports, dryRun)) process.stdout.write(`${line}\n`);
  if (!withMarketplace) process.stdout.write('[platform] marketplace left alone (--no-marketplace)\n');
}

/** One clause naming what the marketplace install did, when it ran. */
function installedNote(installed) {
  const marketplace = installed.includes(MARKETPLACE_PACKAGE);
  const ours = installed.filter((name) => name !== MARKETPLACE_PACKAGE);
  const parts = [];
  if (ours.length > 0) parts.push(`installed ${ours.join(', ')}`);
  if (marketplace) parts.push(`installed ${MARKETPLACE_PACKAGE} and selected it`);
  return parts.length === 0 ? '' : `; ${parts.join('; ')}`;
}

/** One clause naming the model catalog the run wrote, when it wrote one. */
function catalogNote(catalog) {
  return (catalog ?? []).length === 0
    ? ''
    : `; configured the model catalog (${catalog.join(', ')}) in the profile patch`;
}

/**
 * One report line per profile, for both the standalone script and `install.mjs`.
 *
 * The same wording in both places on purpose: an operator reading `install.mjs`
 * output should not have to know that a second script did the plugin work.
 *
 * @param reports - reports from {@link provisionAll}.
 * @param dryRun - whether the run only planned.
 * @returns printable lines.
 */
export function describeReports(reports, dryRun = false) {
  return reports.map((report) => {
    if (report.status === 'skipped') return `[platform] ${report.profile}: ${report.reason}`;
    const state = PROFILE_PLUGINS.map(
      (plugin) => `${plugin.name} (${plugin.defaultEnabled === true ? 'on' : 'off'} by default)`,
    ).join(', ');
    if (dryRun) {
      // `link` is what we generate and `add` is what a registry has to serve.
      const generate = (report.link ?? []).map((entry) => entry.name);
      const fetch = (report.add ?? []).map((entry) => entry.name);
      const what = [...generate, ...fetch].join(', ') || 'nothing';
      return `[platform] ${report.profile}: ${state}; would install ${what}${catalogNote(report.catalog)}`;
    }
    return `[platform] ${report.profile}: ${state}${installedNote(report.installed)}`
      + `${catalogNote(report.catalog)}${failNote(report.failures, report.profile)}`;
  });
}

/** One clause naming a failed install and the exact manual command. */
function failNote(failures, profile) {
  return failures
    .map((failure) => `\n[platform]   NOT installed: ${failure.what}\n[platform]   reason: ${failure.reason}`
      + `\n[platform]   retry: pnpm --dir "<harness home>/profiles/${profile}" add ${failure.what}`)
    .join('');
}

// Only run when invoked directly; the exports above exist for the spec.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
