/**
 * Preflight for the macOS packaging configuration, runnable on any host.
 *
 * The macOS build itself needs a macOS runner
 * (`apps/desktop/scripts/package-target.ts:182`) and takes a long time, so every
 * check that does not actually need macOS runs here first. Without this the only
 * feedback loop would be a CI round trip per missing setting, and the failures
 * would be one at a time: the release environment resolves its settings
 * sequentially, so each run reveals the next required value.
 *
 * This reproduces what the workflow's environment produces — the same
 * `apps/desktop/.env.macos` contents — and asserts the configuration resolves
 * with signing disabled. It runs on Windows and Linux too, because the
 * configuration and the release environment are plain Node modules and the
 * platform only decides what is packaged.
 *
 * The signing assertions are the point: they fail if the fork's override is
 * lost, which would otherwise let a machine with Apple credentials produce a
 * signed bundle while a machine without them fails at the notary.
 *
 * @example
 *   node platform/check-macos-config.mjs
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');
const desktopDir = join(clientDir, 'apps', 'desktop');

/**
 * The release settings the workflow writes into `apps/desktop/.env.macos`.
 *
 * Duplicated from `.github/workflows/macos-build.yml` on purpose: if the two
 * drift, this check passes while CI fails, so the workflow is what must stay
 * authoritative. Keeping the values here in the open makes a drift visible in
 * review rather than only in a failed build.
 */
const SETTINGS = {
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: 'arm64',
  DSH_DESKTOP_APP_ID: 'com.czmanong.dsharness',
  DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
  DSH_DESKTOP_NPM_REGISTRY: 'https://registry.npmmirror.com',
  DSH_DESKTOP_MACOS_PACK_CONCURRENCY: '4',
  DOWNLOAD_TEST_ORIGIN: 'https://www.czmanong.com',
  DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://www.czmanong.com',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{"allowedAuthOrigins":["https://www.czmanong.com"]}',
};

// The configuration evaluates its environment at import time, so the settings
// must be in place before the module is loaded, exactly as the build arranges
// them through the child process environment.
Object.assign(process.env, SETTINGS);

const { createUnsignedMacOSConfig, PLACEHOLDER_SIGNING } = await import(pathToFileURL(join(here, 'macos', 'electron-builder-config.mjs')).href);
const { assertUnsigned } = await import(pathToFileURL(join(here, 'package-macos.mjs')).href);
const config = createUnsignedMacOSConfig();

// The same fields `package-macos.mjs --check` asserts, through the same
// function, so the two checks cannot disagree about what "unsigned" means.
assertUnsigned(config);
assert.deepEqual(config.mac.target, ['dmg', 'zip'], 'the mac targets come from upstream and must not change here');
assert.equal(typeof config.appId, 'string', 'the configuration must come from upstream, not be hand-built');
assert.ok(config.mac.icon.length > 0, 'upstream mac settings must survive the override');
// The factory must ignore real credentials rather than let them re-enable
// signing: that is the failure the placeholders exist to prevent.
assertUnsigned(createUnsignedMacOSConfig({ ...process.env, CSC_LINK: '/real/certificate.p12' }));
// The entry point must reuse these placeholders rather than keep its own copy.
const entry = readFileSync(join(here, 'package-macos.mjs'), 'utf8');
assert.match(entry, /PLACEHOLDER_SIGNING/u, 'the entry point must reuse the configuration\'s placeholders');
assert.ok(Object.keys(PLACEHOLDER_SIGNING).length > 0, 'placeholder signing settings must not be empty');

process.stdout.write('[check-macos-config] configuration resolves with signing disabled\n');
process.stdout.write(`[check-macos-config]   identity=${JSON.stringify(config.mac.identity)} forceCodeSigning=${config.mac.forceCodeSigning} notarize=${config.mac.notarize}\n`);
process.stdout.write(`[check-macos-config]   appId=${config.appId} productName=${config.productName} targets=${JSON.stringify(config.mac.target)}\n`);
process.stdout.write(`[check-macos-config]   placeholders=${Object.keys(PLACEHOLDER_SIGNING).join(',')}\n`);
process.stdout.write(`[check-macos-config]   environment=${Object.keys(process.env).length} variables; host=${process.platform}/${process.arch}\n`);
