import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installInto, mergeManagedBlock, removeFrom, resolveDshHome } from './install.mjs';
import { MARKETPLACE_PACKAGE, PROFILE_PLUGINS } from './provision.mjs';

/**
 * The deployment patcher's contract.
 *
 * This file is written to a path the official loader reads at **every** boot of
 * every profile, so two properties matter more than anything else:
 *
 * - it must never destroy rows it does not own (the official plugin manager
 *   records user toggles in the same file);
 * - it must be idempotent (running it on every start cannot grow the file).
 *
 * The rows themselves are applied in order with last-write-wins per row id
 * (`vendor/include/src/index.ts#applyEntryPatches`), which is why appending is
 * semantically sufficient and no YAML parser is required.
 *
 * What this file may **not** contain is equally load-bearing, and is asserted
 * below: no fork-owned plugin row and no `disabled:` of ours. Both would be
 * applied *after* the profile layer and would therefore be the last word over the
 * user's own switch in the Plugins page. Fork-owned plugins ship as bundle
 * packages instead (`provision.mjs`).
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Provision with a runner that never shells out; these tests are about the patch file. */
const noPnpm = { run: () => { throw new Error('these tests must not run pnpm'); } };

test('resolveDshHome: explicit DSH_HOME wins, otherwise falls back to ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\tmp\\home' }), resolve('C:\\tmp\\home'));
  assert.match(resolveDshHome({}), /[\\/]\.dsh$/);
  // A whitespace-only value counts as unset, the same rule the loader uses.
  assert.match(resolveDshHome({ DSH_HOME: '   ' }), /[\\/]\.dsh$/);
});

test('empty file: writes the managed block directly', () => {
  const merged = mergeManagedBlock('', '- id: deepseek-account\n  config: {}\n');
  assert.match(merged, /^# >>> dsharness platform rows/);
  assert.match(merged, /- id: deepseek-account/);
  assert.match(merged, /# <<< dsharness platform rows\n$/);
});

test('existing user rows: preserved verbatim, managed block appended after them', () => {
  const existing = '- id: tool-ralph\n  disabled: false\n';
  const merged = mergeManagedBlock(existing, '- id: deepseek-account\n  config: {}\n');
  assert.ok(merged.startsWith(existing.trimEnd()), 'user content must survive byte for byte');
  assert.ok(
    merged.indexOf('tool-ralph') < merged.indexOf('dsharness platform rows (managed'),
    'the managed block must come last so last-write-wins overrides the same row id'
  );
});

test('idempotent: two runs leave exactly one block', () => {
  const once = mergeManagedBlock('- id: tool-ralph\n  disabled: false\n', '- id: deepseek-account\n  config: {}\n');
  const twice = mergeManagedBlock(once, '- id: deepseek-account\n  config: {}\n');
  assert.equal(twice, once);
  assert.equal(twice.match(/# >>> dsharness platform rows/g)?.length, 1);
  assert.equal(twice.match(/# <<< dsharness platform rows/g)?.length, 1);
});

test('truncated managed block (begin marker only): rewritten whole, never duplicated', () => {
  const truncated = '# >>> dsharness platform rows (managed by platform/install.mjs)\n- id: deepseek-account\n';
  const merged = mergeManagedBlock(truncated, '- id: deepseek-account\n  config: {}\n');
  assert.equal(merged.match(/# >>> dsharness platform rows/g)?.length, 1);
  assert.equal(merged.match(/# <<< dsharness platform rows/g)?.length, 1);
});

test('content after the managed block is not lost either', () => {
  const once = mergeManagedBlock('', '- id: deepseek-account\n  config: {}\n');
  const withTail = `${once}\n- id: tool-ralph\n  disabled: false\n`;
  const merged = mergeManagedBlock(withTail, '- id: deepseek-account\n  config: {}\n');
  assert.ok(merged.includes('tool-ralph'), 'rows after the managed block must be kept');
  assert.equal(merged.match(/# >>> dsharness platform rows/g)?.length, 1);
});

test('the shipped cordis.patch.yml targets deepseek-account and asserts no name', () => {
  const text = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  // The account row: a non-insert patch, aimed at a row id that really exists upstream.
  assert.match(text, /^- id: deepseek-account$/m);
  /*
   * `name` in a NON-INSERT patch is an ASSERTION: a mismatch makes the whole
   * patch silently skip (`vendor/include/src/index.ts`: name mismatch -> warn and
   * skip). Leaving it out of that row means an upstream package rename cannot
   * quietly turn this deployment back into "login talks to DeepSeek".
   */
  assert.ok(!/^ {4}name:/m.test(text), 'the account patch must not assert name: a mismatch silently skips it');
  // The account origin must be configurable, and loopback HTTP must be allowed
  // for local development where platformOrigin is http://127.0.0.1:13090.
  assert.match(text, /platformOrigin: !!js process\.env\.DSH_PLATFORM_ORIGIN/);
  assert.match(text, /allowLoopbackHttp:/);
  // The whole config must be restated: a patch replaces it, it does not merge.
  for (const key of ['desktopPlatform', 'inferenceOrigin', 'requestTimeoutMs', 'attemptTimeoutMs']) {
    assert.match(text, new RegExp(`^ {4}${key}:`, 'm'), `config must restate ${key}`);
  }
});

/**
 * The row this file must **not** carry any more.
 *
 * A bare `insert` of our plugin made it a Loader row with no package: measured on
 * the live desktop Host, `listPlugins` could address it (`patchId:
 * dsharness-host-auth`) while `listBundles` knew nothing about it, so the official
 * Plugins page had no card to switch. The ask is precisely that such a card
 * exists, so the plugin ships as a bundle package instead.
 */
test('the shipped cordis.patch.yml inserts no fork-owned plugin row', () => {
  const text = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  assert.ok(!/^ {4}- id: dsharness-/m.test(text), 'no fork-owned insert may remain');
  assert.ok(!/^insert:$/m.test(text), 'the whole file is config overrides only');
  for (const plugin of PROFILE_PLUGINS) {
    assert.ok(!text.includes(`\n    - id: ${plugin.name}\n`), `${plugin.name} must not be inserted here`);
  }
  // The secret is read from the environment and must never be written into the repo.
  assert.ok(!/token:\s*['"]?[A-Za-z0-9_-]{16,}/.test(text), 'no literal secret may appear in the shipped rows');
});

/**
 * Enablement of the bundles this product ships is never decided here.
 *
 * Measured with the real `applyEntryPatches`, this file is applied **after** the
 * profile's own patch, so a `disabled` written for one of our own bundle rows would
 * be the last word: the Plugins page's `setBundleEnabled` writes into the profile
 * layer, and the switch would appear to do nothing. Which of our plugins starts
 * switched on is expressed once, in `PROFILE_PLUGINS[...].defaultEnabled`.
 *
 * The `disabled:` rows this file IS allowed — and required — to state are
 * **upstream-declared** routes that must not run in this deployment, because no
 * Plugins-page switch governs either of them:
 *
 * - `llm-deepseek`: the built-in `DeepSeek` model card (`settingsPath: []`, so it is
 *   always `configured`, never `addable`, never `removable` — `ui-settings-models/
 *   src/client/store.ts:205-210`). The user asked for the default list to hold only
 *   码农AI; the official models stay addable through `llm-pi-ai`'s catalog, which
 *   ships `deepseek` (`llm-pi-ai/src/index.ts:124-146`).
 * - `llm-deepseek-account`: it sends the account grant as `x-dsh-auth-token` to the
 *   model endpoint, this product's gateway does not read that header, and the
 *   resulting 401 drives `rejectToken` → `expireCredential`, which deletes the stored
 *   grant (`packages/credentials/deepseek-account-platform/src/index.ts:322-344`) and
 *   signs the user out.
 *
 * So the assertion is two-sided rather than a blanket ban.
 */
test('the shipped cordis.patch.yml states no default enablement for a shipped bundle', () => {
  const text = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  // No row we ship may carry a disabled flag: that belongs to the selection.
  for (const plugin of PROFILE_PLUGINS) {
    const block = new RegExp(`^- id: ${plugin.name}\\n(?:.*\\n)*?(?=\\n- |\\n#|$)`, 'mu').exec(text);
    assert.equal(block, null, `${plugin.name} must not be addressed by this layer at all`);
  }
  const disabled = [...text.matchAll(/^- id: ([A-Za-z0-9-]+)\n(?:.*\n)*?(?=\n- id: |\n#|$)/gmu)]
    .filter((match) => /^\s+disabled: true$/mu.test(match[0]))
    .map((match) => match[1]);
  assert.deepEqual(disabled, ['llm-deepseek', 'llm-deepseek-account'],
    'exactly the two upstream routes this deployment must switch off: '
    + 'the built-in DeepSeek card, and the account-backed LLM route whose 401 signs the user out');
});

/**
 * The rows this layer must never regain: a `config:` block for a namespace the
 * settings page writes.
 *
 * `config-editor.edit()` (`packages/boot/config-editor/src/index.ts:136-141`) accepts a
 * write only when the composed effective config equals what it is about to write, and
 * `readProfilePatches` (`packages/boot/app-boot/src/profile-context.ts:63-73`) appends
 * **this** layer after the profile's own. So a `config:` here is the last word, and
 * every write from 设置 › 模型 to that namespace is refused with
 * `Configuration for "<id>" is overridden by a home patch or command-line overlay`.
 *
 * That is the reported bug: `llm-pi-ai` was carried here, so 添加模型提供商 ›
 * 自定义模型 API could never create anything. `agent-default-model` had the same defect
 * through `AgentDefaultModelConfig.saveSelection()`. The catalog itself is not lost by
 * moving it: `provision.mjs` writes both rows into each profile's own patch layer
 * (`MODEL_CATALOG_ROWS`), which is the layer the page reads *and* can write back to.
 */
test('the shipped cordis.patch.yml carries no config for a page-writable row', () => {
  const text = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  for (const id of ['llm-pi-ai', 'agent-default-model']) {
    assert.ok(!new RegExp(`^- id: ${id}$`, 'mu').test(text),
      `${id} must not be addressed by this layer: a config here makes every 设置 › 模型 write throw`);
  }
  /*
   * Every row with a `config:` block must be one whose own writer is not the models
   * page: `deepseek-account` (the login surface's own row) and `llm-deepseek-account`
   * (disabled with an explicitly emptied config). A `config:` for a models-page
   * namespace is the lock this test exists to catch.
   */
  const configured = [...text.matchAll(/^- id: ([A-Za-z0-9-]+)\n((?:.*\n)*?)(?=\n- id: |\n#|$)/gmu)]
    .filter((match) => /^ {2}config:/mu.test(match[2]))
    .map((match) => match[1]);
  assert.deepEqual(configured, ['deepseek-account', 'llm-deepseek-account'],
    'only the account rows carry a config; anything else is a page-writable namespace being locked');
  for (const id of configured) {
    assert.ok(!['llm-pi-ai', 'agent-default-model'].includes(id), `${id} must stay writable from 设置 › 模型`);
  }
});

test('installInto: writes the rows and provisions the profile plugins', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-install-'));
  try {
    const block = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
    const { target, reports } = installInto(home, block, noPnpm);
    assert.equal(target, join(home, 'cordis.patch.yml'));
    assert.match(readFileSync(target, 'utf8'), /# >>> dsharness platform rows/);
    // No profile yet: nothing to provision, and nothing invented.
    assert.deepEqual(reports, []);
    assert.equal(existsSync(join(home, 'profiles')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installInto: rerunning is idempotent and leaves no stray files', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-install-'));
  try {
    const block = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
    installInto(home, block, noPnpm);
    const once = readFileSync(join(home, 'cordis.patch.yml'), 'utf8');
    installInto(home, block, noPnpm);
    assert.equal(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'), once);
    assert.deepEqual(readdirSync(home), ['cordis.patch.yml'], 'the patch file is the only artifact here');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installInto: an operator row outside the block survives, and last-write-wins holds', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-install-'));
  try {
    writeFileSync(join(home, 'cordis.patch.yml'), '- id: tool-ralph\n  disabled: false\n', 'utf8');
    installInto(home, '- id: deepseek-account\n  config: {}\n', noPnpm);
    const text = readFileSync(join(home, 'cordis.patch.yml'), 'utf8');
    assert.ok(text.startsWith('- id: tool-ralph'), 'the operator row must survive verbatim');
    assert.ok(text.indexOf('tool-ralph') < text.indexOf('dsharness platform rows (managed'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('removeFrom: takes back the rows and leaves operator content alone', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-install-'));
  try {
    writeFileSync(join(home, 'cordis.patch.yml'), '- id: tool-ralph\n  disabled: false\n', 'utf8');
    installInto(home, readFileSync(join(here, 'cordis.patch.yml'), 'utf8'), noPnpm);
    const { reports } = removeFrom(home, { profiles: [] });
    const text = readFileSync(join(home, 'cordis.patch.yml'), 'utf8');
    assert.ok(text.includes('tool-ralph'), 'operator rows must not be removed with ours');
    assert.ok(!text.includes('dsharness platform rows (managed'), 'our block must be gone');
    assert.deepEqual(reports, [], 'no profile was named, so nothing to unprovision');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('removeFrom: unprovisions every profile it finds', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-install-'));
  try {
    installInto(home, readFileSync(join(here, 'cordis.patch.yml'), 'utf8'), noPnpm);
    // A profile that our provisioning has already touched.
    const profileDir = join(home, 'profiles', 'probe');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-probe',
      private: true,
      dependencies: { [PROFILE_PLUGINS[0].name]: 'file:./node_modules/x' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket'] } },
    }, undefined, 2)}\n`, 'utf8');
    mkdirSync(join(profileDir, 'node_modules', PROFILE_PLUGINS[0].name), { recursive: true });
    const { reports } = removeFrom(home);
    assert.deepEqual(reports.map((report) => report.profile), ['probe']);
    assert.deepEqual(reports[0].removed, [PROFILE_PLUGINS[0].name]);
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    assert.ok(!Object.hasOwn(manifest.dependencies, PROFILE_PLUGINS[0].name), 'our dependency is gone');
    assert.ok(!manifest.dsh.profile.bundles.includes(MARKETPLACE_PACKAGE), 'our selection is gone');
    assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'), 'the person\'s own bundles stay');
    assert.equal(existsSync(join(profileDir, 'node_modules', PROFILE_PLUGINS[0].name)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
