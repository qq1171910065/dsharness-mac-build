/**
 * The macOS packaging entry point's contract.
 *
 * This build is unsigned, which makes two things worth asserting rather than
 * trusting:
 *
 * - **It must refuse to run anywhere but macOS.** A macOS bundle can only be
 *   assembled on macOS, and the failure would otherwise appear deep inside
 *   electron-builder as a missing toolchain rather than as a clear refusal.
 * - **It must not silently regain signing.** Upstream's configuration enables
 *   signing and notarization; this fork's wrapper turns both off. If that
 *   override is lost, a machine with Apple credentials would produce a signed
 *   bundle while a machine without them would fail at the notary, and the two
 *   outcomes would look unrelated. The assertion below fails on the first,
 *   quieter case.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments } from './package-macos.mjs';

/**
 * Strip comments so assertions read the configuration rather than its prose.
 *
 * The comments in these files quote upstream's values (`forceCodeSigning: true`,
 * `notarize: true`) while explaining why they are overridden, so a naive search
 * for a forbidden value matches the explanation of its own absence. Only block
 * and line comments are removed; string literals are left alone.
 *
 * @param source - file contents.
 * @returns the contents with comments replaced by whitespace.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/^\s*\/\/.*$/gmu, ' ');
}

const here = dirname(fileURLToPath(import.meta.url));

test('package-macos: --arm64 and --x64 are mutually exclusive and one is required', () => {
  assert.deepEqual(parseArguments(['--arm64']), { arch: 'arm64', check: false });
  assert.deepEqual(parseArguments(['--x64', '--check']), { arch: 'x64', check: true });
  assert.throws(() => parseArguments([]), /pass --arm64 or --x64/u);
  assert.throws(() => parseArguments(['--arm64', '--x64']), /mutually exclusive/u);
});

test('package-macos: the shipped configuration disables signing and notarization', () => {
  const source = withoutComments(readFileSync(join(here, 'macos', 'electron-builder-config.mjs'), 'utf8'));
  // Assert the three fields that decide whether Apple is contacted, and the
  // values that keep it out of the build. `identity: null` is what stops the
  // certificate lookup; the other two stop the signature and the notary.
  assert.match(source, /\bidentity:\s*null\b/u);
  assert.match(source, /\bforceCodeSigning:\s*false\b/u);
  assert.match(source, /\bnotarize:\s*false\b/u);
  assert.doesNotMatch(source, /\bforceCodeSigning:\s*true\b/u);
  assert.doesNotMatch(source, /\bnotarize:\s*true\b/u);
  // It must extend upstream rather than restate the whole configuration: a
  // hand-copied config would silently miss every option upstream adds later.
  assert.match(source, /from '\.\.\/\.\.\/apps\/desktop\/electron-builder\.config\.mjs'/u);
});

test('package-macos: the entry point never delegates to upstream mac packaging', () => {
  const source = withoutComments(readFileSync(join(here, 'package-macos.mjs'), 'utf8'));
  // Upstream's mac route notarizes unconditionally (`package-target.ts:488,494`)
  // and its release environment requires a readable CSC_LINK p12
  // (`desktop-package-environment.mjs:105-108`), so invoking it would make this
  // build impossible rather than unsigned.
  assert.doesNotMatch(source, /package:mac:(?:arm64|x64)\b/u);
  assert.doesNotMatch(source, /['"]package-target/u);
  // The platform guard and the .env.macos requirement are the two preconditions
  // that turn an obscure builder failure into a stated reason.
  assert.match(source, /process\.platform !== 'darwin'/u);
  assert.match(source, /\.env\.macos/u);
});
