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
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The release settings the build supplies before the configuration is imported.
 *
 * The configuration evaluates its environment at import time, so anything
 * importing it — the test included — must arrange these first. This mirrors
 * `.github/workflows/macos-build.yml`; `platform/check-macos-config.mjs` is the
 * runnable form of the same check.
 */
const RELEASE_SETTINGS = {
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: 'arm64',
  DSH_DESKTOP_APP_ID: 'com.czmanong.dsharness',
  DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
  DOWNLOAD_TEST_ORIGIN: 'https://www.czmanong.com',
  DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://www.czmanong.com',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{"allowedAuthOrigins":["https://www.czmanong.com"]}',
};

// Set before the dynamic imports below. These modules resolve their environment
// when they load, exactly as they do in the build's child processes.
Object.assign(process.env, RELEASE_SETTINGS);
const { parseArguments } = await import(pathToFileURL(join(here, 'package-macos.mjs')).href);

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

test('package-macos: --arm64 and --x64 are mutually exclusive and one is required', () => {
  assert.deepEqual(parseArguments(['--arm64']), { arch: 'arm64', check: false });
  assert.deepEqual(parseArguments(['--x64', '--check']), { arch: 'x64', check: true });
  assert.throws(() => parseArguments([]), /pass --arm64 or --x64/u);
  assert.throws(() => parseArguments(['--arm64', '--x64']), /mutually exclusive/u);
});

test('package-macos: the built configuration disables signing and notarization', async () => {
  // Behavioral, not textual: the real module is imported with the real release
  // settings and the resulting configuration is inspected. This is what caught
  // upstream's notarization lookup, which throws at import time unless a
  // complete Apple strategy is present.
  Object.assign(process.env, RELEASE_SETTINGS);
  const module = await import(pathToFileURL(join(here, 'macos', 'electron-builder-config.mjs')).href);
  const config = module.createUnsignedMacOSConfig();
  assert.equal(config.mac.identity, null, 'no certificate must be looked up');
  assert.equal(config.mac.forceCodeSigning, false, 'no signature must be produced');
  assert.equal(config.mac.notarize, false, 'Apple must never be contacted');
  // `dmg.sign` is a separate switch upstream; leaving it true fails the disk
  // image after the application itself was built correctly.
  assert.equal(config.dmg.sign, false, 'the disk image must not be signed either');
  assert.deepEqual(config.mac.target, ['dmg', 'zip'], 'the targets come from upstream');
  assert.equal(typeof config.appId, 'string', 'the configuration must come from upstream');
  assert.ok(config.mac.icon.length > 0, 'upstream mac settings must survive the override');
  // Real credentials must not re-enable signing: that is the failure the
  // placeholders exist to prevent, and it is the difference between a build that
  // is quietly signed and one that is honestly unsigned.
  const withCredentials = module.createUnsignedMacOSConfig({ ...process.env, CSC_LINK: '/real/cert.p12' });
  assert.equal(withCredentials.mac.forceCodeSigning, false);
  assert.equal(withCredentials.mac.identity, null);
});

test('package-macos: the configuration is composed from upstream, not restated', () => {
  const source = withoutComments(readFileSync(join(here, 'macos', 'electron-builder-config.mjs'), 'utf8'));
  // Upstream's default export resolves the release environment at import time
  // and throws without Apple credentials, so the factory must be used instead.
  assert.match(source, /createElectronBuilderConfig\s*\(/u);
  assert.match(source, /from '\.\.\/\.\.\/apps\/desktop\/scripts\/electron-builder-config\.mjs'/u);
  assert.doesNotMatch(source, /from '\.\.\/\.\.\/apps\/desktop\/electron-builder\.config\.mjs'/u);
  // The forbidden values must not appear in code (the prose explains them).
  assert.doesNotMatch(source, /\bforceCodeSigning:\s*true\b/u);
  assert.doesNotMatch(source, /\bnotarize:\s*true\b/u);
  assert.doesNotMatch(source, /\bsign:\s*true\b/u);
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

test('package-macos: preparation lists upstream steps and never a bare prepare:primary-runtime', () => {
  const source = withoutComments(readFileSync(join(here, 'package-macos.mjs'), 'utf8'));
  // `prepare:primary-runtime` is a sub-step of `prepare:runtime`
  // (`prepare-runtime.ts:63`) and requires `--target`/`--output` when invoked
  // directly (`scripts/primary-runtime/prepare.ts:197`). A CI run failed here
  // before this list was corrected, so it is pinned.
  assert.doesNotMatch(source, /'prepare:primary-runtime'/u);
  const listed = (name) => new RegExp(`'${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'`, 'u').test(source);
  for (const step of ['build:official', 'release:pack', 'run', 'prepare:runtime', 'prepare:packages', 'prepare:dsh']) {
    assert.ok(listed(step), `preparation must include ${step}`);
  }
  // The signing steps upstream interleaves must NOT be here: this build signs
  // nothing, and the defer flags exist only to sequence those two steps. Both
  // are checked in code, not prose — the comments above explain why they are
  // absent, which is exactly the text a naive search would trip on.
  assert.doesNotMatch(source, /'sign:primary-runtime'/u);
  assert.doesNotMatch(source, /'--defer-primary-runtime-smoke'/u);
  assert.doesNotMatch(source, /'--defer-runtime-smoke'/u);
  assert.doesNotMatch(source, /'preflight:windows-signing'/u);
});

test('package-macos: the desktop-only preparation steps run from apps/desktop', () => {
  const source = withoutComments(readFileSync(join(here, 'package-macos.mjs'), 'utf8'));
  // `prepare:runtime`, `prepare:packages` and `prepare:dsh` are declared in
  // apps/desktop/package.json, NOT the workspace root. Upstream reaches them
  // with a cwd of `apps/desktop` (`package-target.ts:28` `APP_ROOT`), so a run
  // from the root fails with `ERR_PNPM_NO_SCRIPT: Missing script:
  // prepare:runtime` — which is exactly what CI reported.
  for (const step of ['prepare:runtime', 'prepare:packages', 'prepare:dsh']) {
    const escaped = step.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    assert.match(source, new RegExp(`desktop\\('run', '${escaped}'\\)`, 'u'),
      `${step} must run through the apps/desktop directory helper`);
    // ...and must not also be invoked bare, which is the failing form.
    assert.doesNotMatch(source, new RegExp(`\\['run', '${escaped}'\\]`, 'u'));
  }
  // The helper must actually carry the directory, or the prefix is decorative.
  assert.match(source, /const desktop = \(\.\.\.args\) => \['--dir', desktopPackageDir, \.\.\.args\]/u);
  assert.match(source, /const desktopPackageDir = 'apps\/desktop'/u);
  // `build:official` and `release:pack` really are workspace-root scripts, so
  // they must stay unprefixed.
  assert.match(source, /\['run', 'build:official'\]/u);
  assert.match(source, /\['run', 'release:pack'/u);

  // The claim above is checked against the manifests, not just the source text:
  // if upstream ever moves these scripts, this fails instead of silently
  // producing a build that dies ten minutes in.
  const desktopManifest = JSON.parse(readFileSync(join(here, '..', 'apps', 'desktop', 'package.json'), 'utf8'));
  const rootManifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  for (const step of ['prepare:runtime', 'prepare:packages', 'prepare:dsh']) {
    assert.ok(step in desktopManifest.scripts, `${step} must exist in apps/desktop`);
    assert.ok(!(step in rootManifest.scripts), `${step} must not be a workspace-root script`);
  }
  for (const step of ['build:official', 'release:pack']) {
    assert.ok(step in rootManifest.scripts, `${step} must exist at the workspace root`);
  }
});

test('package-macos: the preflight check asserts the same signing invariants as --check', () => {
  // No comment stripping: the file is assertions over an imported module, and
  // stripping would also remove the `//` inside module specifiers.
  const source = readFileSync(join(here, 'check-macos-config.mjs'), 'utf8');
  // It must go through the same assertion the build's own `--check` uses, so the
  // two cannot disagree about what "unsigned" means.
  assert.match(source, /assertUnsigned/u);
  // It must build the configuration from the same module the build uses, or it
  // would validate something the build never loads.
  assert.match(source, /'macos'/u);
  assert.match(source, /'electron-builder-config\.mjs'/u);
  assert.match(source, /createUnsignedMacOSConfig/u);
  // It must arrange the release settings before that import, because the
  // configuration evaluates its environment when it loads.
  const assigned = source.indexOf('Object.assign(process.env');
  const imported = source.indexOf('await import(');
  assert.ok(assigned >= 0 && imported >= 0 && assigned < imported,
    'the release settings must be set before the configuration is imported');
  // Real credentials must not be able to re-enable signing.
  assert.match(source, /CSC_LINK/u);
});

test('package-macos: preparation runs inside upstream\'s keychain context', () => {
  const source = withoutComments(readFileSync(join(here, 'package-macos.mjs'), 'utf8'));
  // `prepare:dsh` signs the runtime on every darwin build (`prepare-dsh.ts:156`),
  // and that path needs `CSC_KEYCHAIN` and a `DSH_DESKTOP_MACOS_SIGNING_PROBE`
  // signed by the same certificate. Upstream builds both from `CSC_LINK` /
  // `CSC_KEY_PASSWORD` (`macos-signing-keychain.mjs:48`), and
  // `package-target.ts:369` wraps its mac work in it for the same reason, so the
  // helper is reused instead of reimplemented.
  assert.match(source, /withMacOSSigningKeychain/u);
  assert.match(source, /'macos-signing-keychain\.mjs'/u);
  assert.match(source, /CSC_LINK/u);
  assert.match(source, /CSC_KEY_PASSWORD/u);
  // The preparation loop must be inside it; electron-builder must not be, since
  // this configuration signs nothing and must not inherit a keychain.
  const helper = source.indexOf('await withSigningKeychain(');
  const builder = source.indexOf("'exec', 'electron-builder'");
  const loop = source.indexOf('for (const args of preparation)');
  assert.ok(helper >= 0 && loop > helper, 'preparation must run inside the keychain context');
  assert.ok(builder > helper, 'electron-builder must run after it');
  assert.ok(loop < builder, 'electron-builder must not be inside the preparation loop');

  // A self-signed certificate is not a workaround, and the code must not imply
  // it is. Verification requires fields only Apple can issue.
  const verify = readFileSync(join(here, '..', 'apps', 'desktop', 'scripts', 'verify-macos-signature.mjs'), 'utf8');
  assert.match(verify, /TeamIdentifier=/u, 'the team identifier requirement must still exist upstream');
  assert.match(verify, /Timestamp=/u, 'the secure timestamp requirement must still exist upstream');
  assert.doesNotMatch(verify, /allowUnsigned|skipTimestamp/u, 'upstream must still have no unsigned escape');
});

test('package-macos: the documented signing blocker stays accurate', () => {
  const source = readFileSync(join(here, 'package-macos.mjs'), 'utf8');
  // The header explains why an unsigned macOS build is impossible. If upstream
  // ever gains an unsigned route, this text becomes wrong and should fail
  // rather than silently mislead.
  assert.match(source, /Known blocker/u);
  assert.match(source, /TeamIdentifier/u);
  assert.match(source, /secure timestamp/u);
  assert.match(source, /self-signed certificate was tried and is \*\*not\*\* a workaround/u);
  // The claim it depends on, checked against upstream rather than trusted.
  const prepare = readFileSync(join(here, '..', 'apps', 'desktop', 'scripts', 'prepare-dsh.ts'), 'utf8');
  assert.match(prepare, /if \(process\.platform === 'darwin'\) \{\n\s+await packagingStep\([^\n]*'sign:dsh-native'/u,
    'prepare:dsh must still sign unconditionally on darwin');
});

test('package-macos: --check validates the configuration instead of only printing a plan', () => {
  const source = withoutComments(readFileSync(join(here, 'package-macos.mjs'), 'utf8'));
  // The plan is printed from an environment the configuration has already
  // resolved. A `--check` that returned earlier reported a plan whose settings
  // had never been validated, and failed in CI with a bare
  // "DSH_DESKTOP_APP_ID must be set".
  const loaded = source.indexOf('await loadReleaseEnvironment()');
  const checked = source.indexOf('if (check)');
  assert.ok(loaded >= 0 && checked >= 0 && loaded < checked,
    'the release environment must be loaded before the --check branch');
  assert.match(source, /assertUnsigned\(/u);
  // The configuration must NOT be imported statically. It publishes a default
  // export, so a static import evaluates the whole release environment at module
  // load — before main() can read .env.macos — and CI failed exactly that way.
  assert.doesNotMatch(source, /^import .*electron-builder-config\.mjs/mu);
  const resolved = source.indexOf('await resolveConfiguration(');
  assert.ok(resolved >= 0 && resolved < checked,
    'the configuration must be resolved before the --check branch');
});
