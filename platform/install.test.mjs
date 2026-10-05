import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeManagedBlock, resolveDshHome } from './install.mjs';

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

test('the shipped cordis.patch.yml targets only deepseek-account and asserts no name', () => {
  const text = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  // Exactly one non-insert patch, aimed at a row id that really exists upstream.
  assert.match(text, /^- id: deepseek-account$/m);
  /*
   * `name` in a non-insert patch is an ASSERTION: a mismatch makes the whole
   * patch silently skip (`vendor/include/src/index.ts`: name mismatch -> warn and
   * skip). Leaving it out means an upstream package rename cannot quietly turn
   * this deployment back into "login talks to DeepSeek".
   */
  assert.ok(!/^\s*name:/m.test(text), 'must not assert name: a mismatch silently skips the whole patch');
  // The account origin must be configurable, and loopback HTTP must be allowed
  // for local development where platformOrigin is http://127.0.0.1:13090.
  assert.match(text, /platformOrigin: !!js process\.env\.DSH_PLATFORM_ORIGIN/);
  assert.match(text, /allowLoopbackHttp:/);
  // The whole config must be restated: a patch replaces it, it does not merge.
  for (const key of ['desktopPlatform', 'inferenceOrigin', 'requestTimeoutMs', 'attemptTimeoutMs']) {
    assert.match(text, new RegExp(`^\\s*${key}:`, 'm'), `config must restate ${key}`);
  }
});
