import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_FILES, installInto, mergeManagedBlock, removeFrom, resolveDshHome } from './install.mjs';

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
 */

const here = dirname(fileURLToPath(import.meta.url));

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
   *
   * An `insert` row is the opposite: there `name` is the thing being created, and
   * it must be present -- the whole point of the insert is to mount our plugin.
   * So the assertion is scoped to the account row's own patch block.
   */
  const accountRowEnd = text.indexOf('\n\n# ---');
  const accountRow = accountRowEnd < 0 ? text : text.slice(0, accountRowEnd);
  assert.ok(!/^\s*name:/m.test(accountRow), 'the account patch must not assert name: a mismatch silently skips it');
  // The account origin must be configurable, and loopback HTTP must be allowed
  // for local development where platformOrigin is http://127.0.0.1:13090.
  assert.match(accountRow, /platformOrigin: !!js process\.env\.DSH_PLATFORM_ORIGIN/);
  assert.match(accountRow, /allowLoopbackHttp:/);
  // The whole config must be restated: a patch replaces it, it does not merge.
  for (const key of ['desktopPlatform', 'inferenceOrigin', 'requestTimeoutMs', 'attemptTimeoutMs']) {
    assert.match(accountRow, new RegExp(`^\\s*${key}:`, 'm'), `config must restate ${key}`);
  }
});

test('the shipped cordis.patch.yml mounts the fork-owned host-auth plugin', () => {
  const text = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  // It must be an insert: upstream has no such row, so an insert cannot conflict
  // with anything upstream declares.
  assert.match(text, /^- insert:$/m);
  assert.match(text, /- id: dsharness-host-auth$/m);
  // The installed file name, which is what installInto copies into $DSH_HOME.
  const installed = PLUGIN_FILES.map(([, target]) => target);
  for (const target of installed) {
    assert.ok(text.includes(`name: ./${target}`), `row must mount ./${target}`);
  }
  // The secret is read from the environment; it must never be written into the repo.
  assert.match(text, /token: !!js process\.env\.DSH_AUTH_TOKEN \?\? ''/);
  assert.ok(!/token:\s*['"]?[A-Za-z0-9_-]{16,}/.test(text), 'no literal secret may appear in the shipped rows');
});

test('installInto: copies every plugin beside the patch and drops the rows in', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-install-'));
  try {
    const block = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
    const { target, installed } = installInto(home, block);
    assert.equal(target, join(home, 'cordis.patch.yml'));
    assert.deepEqual(installed, PLUGIN_FILES.map(([, name]) => name));
    for (const [, fileName] of PLUGIN_FILES) {
      const copy = join(home, fileName);
      assert.ok(existsSync(copy), `${fileName} must land beside the patch file`);
      // Byte-identical: the copy is a deployment artifact, not an edit surface.
      assert.equal(readFileSync(copy, 'utf8'), readFileSync(join(here, fileName.replace('dsharness-', '')), 'utf8'));
    }
    assert.match(readFileSync(target, 'utf8'), /# >>> dsharness platform rows/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installInto: rerunning is idempotent and cannot accumulate copies', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-install-'));
  try {
    const block = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
    installInto(home, block);
    const once = readFileSync(join(home, 'cordis.patch.yml'), 'utf8');
    installInto(home, block);
    assert.equal(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'), once);
    assert.equal(readdirSync(home).length, PLUGIN_FILES.length + 1, 'no stray copies');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installInto: an operator row outside the block survives, and last-write-wins holds', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-install-'));
  try {
    writeFileSync(join(home, 'cordis.patch.yml'), '- id: tool-ralph\n  disabled: false\n', 'utf8');
    installInto(home, '- id: deepseek-account\n  config: {}\n');
    const text = readFileSync(join(home, 'cordis.patch.yml'), 'utf8');
    assert.ok(text.startsWith('- id: tool-ralph'), 'the operator row must survive verbatim');
    assert.ok(text.indexOf('tool-ralph') < text.indexOf('dsharness platform rows (managed'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('removeFrom: takes back both the rows and the copies this script owns', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-install-'));
  try {
    writeFileSync(join(home, 'cordis.patch.yml'), '- id: tool-ralph\n  disabled: false\n', 'utf8');
    installInto(home, readFileSync(join(here, 'cordis.patch.yml'), 'utf8'));
    removeFrom(home);
    const text = readFileSync(join(home, 'cordis.patch.yml'), 'utf8');
    assert.ok(text.includes('tool-ralph'), 'operator rows must not be removed with ours');
    assert.ok(!text.includes('dsharness platform rows (managed'), 'our block must be gone');
    for (const [, fileName] of PLUGIN_FILES) {
      assert.equal(existsSync(join(home, fileName)), false, `${fileName} must be removed`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
