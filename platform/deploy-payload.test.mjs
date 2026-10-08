import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildDeployPayload, DEFAULT_PLATFORM_ORIGIN, PAYLOAD_ENTRY, PAYLOAD_MODULES, payloadDirectory, renderDeployPatch,
} from './build-deploy-payload.mjs';
import { parseArguments, hookEnvironment } from './package-windows.mjs';
import { readConfigEnvironment, rewriteConfigArgument } from './windows/nsis-config-hook.mjs';
import { withUpdateDescriptor, updateDescriptor, assertUpdateDescriptor } from './windows/update-descriptor.mjs';
import { installInto } from './install.mjs';
import {
  deploy, ensureDesktopProfile, PROFILE_BUNDLES, PROFILE_PATCH_TEMPLATE, PROFILE_PNPM_WORKSPACE, profilesUnder,
  recordInstalledVersion,
} from './windows/deploy/deploy-entry.mjs';
import { PROFILE_PLUGINS } from './provision.mjs';

/**
 * The payload's own modules, imported through the **generated copies** the installer ships
 * rather than through `platform/` — the same bytes are what reach a machine, so the model
 * catalog and the key reference a test compares here are the ones a user gets.
 */
const payloadModules = {
  ...await import('./windows/deploy/provision.mjs'),
  ...await import('./windows/deploy/dsharness.mjs'),
};

/** The key reference the shipped bundle writes, read from the generated payload copy. */
const MODEL_KEY_REF = payloadModules.MODEL_KEY_REF;

/**
 * The installer seam's contract.
 *
 * Three things have to stay true for "the installer already carries the
 * deployment layer" to mean anything, and each is asserted below:
 *
 * 1. the payload really is the product's own deployment code, not a copy that
 *    drifted from it;
 * 2. the NSIS include really references the payload, opens with the **upstream**
 *    include, and stays compilable (pure ASCII, no macro redefinition);
 * 3. the profile the payload creates is indistinguishable from the one the
 *    application's own `initProfile` creates, because the application treats an
 *    existing profile as the user's and never rewrites it.
 *
 * The behavioural half of (3) runs upstream's function through `tsx` when the
 * repository has it; the source-text half always runs, so the check still fails
 * loudly on a machine without `tsx`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');
const upstreamProfile = join(clientDir, 'packages', 'boot', 'app-boot', 'src', 'profile.ts');
const windowsDir = join(here, 'windows');
const installer = join(windowsDir, 'installer.nsh');
const updateFeed = join(windowsDir, 'app-update.yml');

function temporaryDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('deploy payload: the committed copies are byte-identical to their platform/ sources', () => {
  const target = payloadDirectory(here);
  for (const name of PAYLOAD_MODULES) {
    assert.equal(
      readFileSync(join(target, name), 'utf8'),
      readFileSync(join(here, name), 'utf8'),
      `${name} must be a verbatim copy of platform/${name}`,
    );
  }
  assert.ok(existsSync(join(target, PAYLOAD_ENTRY)), 'the hand-written entry point must be committed');
});

test('deploy payload: --check reports drift instead of rewriting it', () => {
  const root = temporaryDirectory('deploy-payload-');
  try {
    for (const name of PAYLOAD_MODULES) {
      writeFileSync(join(root, name), `original ${name}\n`);
    }
    mkdirSync(payloadDirectory(root), { recursive: true });
    writeFileSync(join(payloadDirectory(root), PAYLOAD_ENTRY), 'hand written entry\n');
    writeFileSync(join(root, 'cordis.patch.yml'), "- id: deepseek-account\n  config:\n    platformOrigin: !!js process.env.DSH_PLATFORM_ORIGIN ?? 'http://127.0.0.1:13090'\n");
    buildDeployPayload({ root });
    buildDeployPayload({ root, check: true });
    writeFileSync(join(payloadDirectory(root), 'install.mjs'), 'drifted\n');
    assert.throws(() => buildDeployPayload({ root, check: true }), /install\.mjs in .* is stale/);
    // A check that finds drift must not have repaired it either.
    assert.equal(readFileSync(join(payloadDirectory(root), 'install.mjs'), 'utf8'), 'drifted\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deploy payload: the platform origin is baked in and must be a bare origin', () => {
  const row = "- id: deepseek-account\n  config:\n    platformOrigin: !!js process.env.DSH_PLATFORM_ORIGIN ?? 'http://127.0.0.1:13090'\n";
  assert.equal(renderDeployPatch(row, 'https://www.czmanong.com'), "- id: deepseek-account\n  config:\n    platformOrigin: 'https://www.czmanong.com'\n");
  // The official provider rejects any origin whose pathname is not `/`, so a prefixed URL is a build error, not a runtime surprise.
  assert.throws(() => renderDeployPatch(row, 'https://www.czmanong.com/dsharness'), /bare origin/);
  assert.throws(() => renderDeployPatch(row, 'https://user:pass@example.test'), /bare origin/);
  // A file whose origin line moved or multiplied means the file changed shape.
  assert.throws(() => renderDeployPatch('[]\n', 'https://example.test'), /exactly one platformOrigin line/);
  assert.throws(() => renderDeployPatch(`${row}${row}`, 'https://example.test'), /exactly one platformOrigin line/);
});

test('deploy payload: the committed patch carries the production origin', () => {
  const text = readFileSync(join(payloadDirectory(here), 'cordis.patch.yml'), 'utf8');
  assert.match(text, new RegExp(`platformOrigin: '${DEFAULT_PLATFORM_ORIGIN.replaceAll('.', '\\.')}'`));
  assert.doesNotMatch(text, /DSH_PLATFORM_ORIGIN/, 'the installed copy must not depend on an environment variable');
});

test('deploy payload: the installed layer carries no page-writable row, and the two disables', () => {
  const text = readFileSync(join(payloadDirectory(here), 'cordis.patch.yml'), 'utf8');
  /*
   * The rows that must NOT be here are as load-bearing as the ones that must.
   *
   * `config-editor.edit()` (`packages/boot/config-editor/src/index.ts:136-141`) accepts a
   * write only when the composed effective config equals the config about to be written,
   * and `readProfilePatches` (`packages/boot/app-boot/src/profile-context.ts:63-73`)
   * applies this layer **after** the profile's own. So a `config:` here for a namespace
   * the settings page writes is a lock: every write to it is refused with
   * `Configuration for "<id>" is overridden by a home patch or command-line overlay`.
   * That was the reported bug — 添加模型提供商 could not create anything while
   * `llm-pi-ai` was carried here. The catalog lives in each profile's own patch layer
   * instead (`provision.mjs`'s `MODEL_CATALOG_ROWS`), which is the layer the page reads
   * and can write back to.
   */
  assert.doesNotMatch(text, /^- id: llm-pi-ai$/mu, 'a config here would refuse every 设置 › 模型 write');
  assert.doesNotMatch(text, /^- id: agent-default-model$/mu, 'same defect, through AgentDefaultModelConfig.saveSelection()');
  // The two routes this deployment switches off, and why each must be.
  const disabled = [...text.matchAll(/^- id: ([A-Za-z0-9-]+)\n(?:.*\n)*?(?=\n- id: |\n#|$)/gmu)]
    .filter((match) => /^ {2}disabled: true$/mu.test(match[0]))
    .map((match) => match[1]);
  assert.deepEqual(disabled, ['llm-deepseek', 'llm-deepseek-account']);
  // `llm-deepseek-account` is disabled because a 401 through it deletes the stored
  // grant (`.../deepseek-account-platform/src/index.ts:322-344`), signing the user out.
  assert.match(text, /^- id: llm-deepseek-account\n {2}disabled: true\n {2}config: \{\}$/mu);
});

test('deploy payload: the model route and its catalog travel in the generated bundle layer', () => {
  /*
   * The route moved out of this file, so the pair that must not drift is now
   * `provision.mjs`'s catalog block against the key reference the browser half writes
   * and reads. A mismatch is a silent `MISSING_CREDENTIAL` on every request, so the two
   * are compared rather than each being checked against a literal — the same thing this
   * test did while the row lived here.
   */
  const { MODEL_CATALOG_ROWS } = payloadModules;
  const relay = MODEL_CATALOG_ROWS.find((row) => row.id === 'llm-pi-ai');
  assert.ok(relay !== undefined, 'the deployment catalog must still declare the llm-pi-ai row');
  // `body` is rendered one level under the row's `config:` key, so it starts at 4 spaces.
  assert.match(relay.body, /^ {4}providers:$/mu);
  assert.match(relay.body, /^ {6}dsharness-relay:$/mu);
  assert.match(relay.body, /^ {8}displayName: '码农AI'$/mu);
  assert.match(relay.body, /^ {8}api: 'openai-completions'$/mu);
  assert.match(relay.body, /^ {8}baseURL: 'https:\/\/ai\.czmanong\.com\/v1'$/mu);
  assert.match(relay.body, new RegExp(`^ {8}apiKeyEnv: '${MODEL_KEY_REF}'$`, 'mu'));
  // Exactly one model, and it is the one this product serves, with images.
  assert.equal((relay.body.match(/^ {10}- id: /gmu) ?? []).length, 1);
  assert.match(relay.body, /^ {10}- id: 'deepseek-v4\.1-flash'$/mu);
  assert.match(relay.body, /^ {12}input: \['text', 'image'\]$/mu);
  const selection = MODEL_CATALOG_ROWS.find((row) => row.id === 'agent-default-model');
  assert.match(selection.body, /^ {4}provider: 'dsharness-relay'$/mu);
  assert.match(selection.body, /^ {4}model: 'deepseek-v4\.1-flash'$/mu);
});

test('deploy payload: the shipped key reference matches the plugin that writes it', async () => {
  // The reference is named in the catalog row and stored by the merged bundle; the pair
  // is compared rather than each being checked against a literal.
  const { MODEL_CATALOG_ROWS } = payloadModules;
  const { PROFILE_PLUGINS } = await import('./provision.mjs');
  const relay = MODEL_CATALOG_ROWS.find((row) => row.id === 'llm-pi-ai');
  assert.match(relay.body, new RegExp(`apiKeyEnv: '${MODEL_KEY_REF}'`, 'u'));
  assert.equal(MODEL_KEY_REF, 'DSHARNESS_MODEL_KEY');
  const writer = PROFILE_PLUGINS.find((plugin) => plugin.entry === 'dsharness.mjs');
  assert.ok(writer !== undefined, 'provisioning must ship the plugin that writes the key');
  assert.equal(writer.defaultEnabled, true, 'a model route with no credential fails every request');
});

test('installer include: opens with the upstream include and stays pure ASCII', () => {
  const bytes = readFileSync(installer);
  assert.equal(bytes.filter((byte) => byte > 0x7f).length, 0, 'makensis rejects a non-ASCII byte in an include without a BOM');
  const text = bytes.toString('utf8');
  const first = text.split('\n').find((line) => line.startsWith('!include '));
  assert.equal(first, '!include "${__FILEDIR__}\\..\\..\\apps\\desktop\\scripts\\installer.nsh"');
  assert.doesNotMatch(text, /!macro\s+(?:customHeader|customInit|customInstall|customCheckAppRunning)\b/u,
    'NSIS forbids redefining an upstream macro');
});

test('installer include: ships the unsigned update feed beside the application resources', () => {
  const text = readFileSync(installer, 'utf8');
  // The file lands in `$INSTDIR\resources`, which is what `process.resourcesPath`
  // means at runtime -- the exact directory `update-coordinator.ts:54` probes.
  assert.match(text, /SetOutPath "\$INSTDIR\\resources"[\s\S]*?File "\$\{__FILEDIR__\}\\app-update\.yml"/u,
    'the feed descriptor must be placed into the resources directory');
  // `SetOutPath` is stateful, so the payload directory has to be selected again
  // after it; otherwise later `File` statements embed into the wrong directory.
  assert.match(text, /File "\$\{__FILEDIR__\}\\app-update\.yml"\s*\n\s*SetOutPath "\$INSTDIR\\resources\\installer-ui\\dsharness"/u,
    'the output directory must be restored after shipping the feed descriptor');
  // The feed descriptor deliberately does not go through `deploy/`.
  assert.ok(!PAYLOAD_MODULES.includes('app-update.yml'), 'it is one file at a fixed location, not a generated payload module');

  const feed = readFileSync(updateFeed, 'utf8');
  assert.match(feed, /^provider: generic$/mu);
  assert.match(feed, /^channel: nightly$/mu);
  /*
   * The cache directory name is a contract with the *installer*, not a free
   * label. The uninstaller removes exactly `%LOCALAPPDATA%\<that name>`
   * (`apps/desktop/installer/uninstall.nsh:34`), while the updater drops a
   * ~292 MB pending download under `<that name>\pending`. The installer's value
   * is `appInfo.updaterCacheDirName` (`app-builder-lib/out/appInfo.js:126-128`),
   * and the build records it verbatim — measured in the built
   * `builder-debug.yml` as `@deepseek-aidsh-desktop-updater`, `@` intact because
   * `sanitizeFileName` keeps it. A mismatch does not break updating; it silently
   * leaves the download behind on uninstall, which is exactly the kind of defect
   * nobody reports. Quoted because YAML reserves a leading `@`.
   */
  assert.match(feed, /^updaterCacheDirName: '@deepseek-aidsh-desktop-updater'$/mu);
  assert.doesNotMatch(feed, /^updaterCacheDirName: dsh-desktop-updater$/mu,
    'a name the installer never removes leaves the pending download behind');
  // A base URL without the trailing slash concatenates into a wrong artifact path.
  const url = /^url:\s*(\S+)\s*$/mu.exec(feed)?.[1];
  assert.ok(url !== undefined);
  assert.ok(url.endsWith('/'), 'the update base URL must end with a slash');
  assert.ok(url.startsWith('https://'));
  /*
   * The one key that must never come back. `NsisUpdater.verifySignature()`
   * (`node_modules/electron-updater/out/NsisUpdater.js:84-100`) returns null --
   * accepts the package -- exactly while `publisherName` is null or absent; the
   * moment it is present, an unsigned build fails every update with
   * `ERR_UPDATER_INVALID_SIGNATURE`. A regression here is silent until a user
   * cannot update, so it is asserted rather than commented.
   */
  assert.doesNotMatch(feed, /^publisherName:/mu, 'an unsigned build cannot pass an Authenticode publisher check');
  // The file is embedded by NSIS, so its own encoding rules apply too.
  assert.equal(readFileSync(updateFeed).filter((byte) => byte > 0x7f).length, 0);
});

test('installer include: runs the deployment layer from the installed application', () => {
  const text = readFileSync(installer, 'utf8');
  assert.match(text, /^Function \.onInstSuccess$/mu);
  for (const file of [...PAYLOAD_MODULES, PAYLOAD_ENTRY, 'cordis.patch.yml']) {
    assert.ok(text.includes(`deploy\\${file}`), `the include must embed ${file}`);
  }
  /*
   * The browser half of the shipped bundle travels with the payload like any other
   * module: `provision.mjs` reads `plugin.entry` / `plugin.clientEntry` relative to its
   * own directory at install time, so a payload missing either one fails to generate the
   * bundle. Both halves are already payload modules, so rather than repeating their names
   * this compares the two lists -- measured while merging the four plugin packages, where
   * a stale `clientEntry` name made `buildDeployPayload` throw "missing source" long after
   * the file had been deleted.
   */
  for (const plugin of PROFILE_PLUGINS) {
    assert.ok(PAYLOAD_MODULES.includes(plugin.entry), `payload must carry ${plugin.entry}`);
    if (plugin.clientEntry !== undefined) {
      assert.ok(PAYLOAD_MODULES.includes(plugin.clientEntry), `payload must carry ${plugin.clientEntry}`);
    }
  }
  assert.match(text, /nsExec::ExecToLog '.*resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node\.exe.*deploy-entry\.mjs.*\$INSTDIR.*'/u);
  assert.match(text, /DetailPrint "DSH Desktop: deployment layer exited with \$0"/u);
  /*
   * The version has to travel with the invocation. An unsigned build has no update
   * feed to ask later (`publish: null` ⇒ no `app-update.yml`), so the installer —
   * which electron-builder feeds `${VERSION}` — is the only witness to what the user
   * actually installed. Without it the check-for-updates page could only ever show
   * the latest release, never whether it is newer than this machine.
   */
  assert.match(text, /deploy-entry\.mjs"\s+"\$INSTDIR"\s+"\$\{VERSION\}"/u,
    'the include must pass the installer version to the deployment entry');
});

test('installer include: ${VERSION} is an NSIS define electron-builder supplies', () => {
  // Guard the guard: if a future electron-builder renames the define, the include
  // above would compile to a literal and every install would record nothing.
  const nsisTarget = join(clientDir, 'apps', 'desktop', 'node_modules', 'app-builder-lib',
    'out', 'targets', 'nsis', 'NsisTarget.js');
  const text = readFileSync(nsisTarget, 'utf8');
  assert.match(text, /VERSION: appInfo\.version/u, 'electron-builder defines VERSION for the NSIS script');
});

test('deploy entry: the installer version is recorded for the update check', async () => {
  const home = temporaryDirectory('deploy-version-');
  /*
   * The reader and the writer live in different payload modules (`dsharness.mjs` reads
   * the record, `deploy-entry.mjs` writes it) and neither can import the other: the
   * payload directory is flat, so the file name is a literal in both. Read them here
   * and compare, so a rename cannot silently break the feature.
   */
  const { INSTALL_RECORD, readInstallRecord } = await import('./dsharness.mjs');
  try {
    // No version supplied (a hand-run `deploy-entry.mjs`, or an older installer):
    // nothing is written, so the page says "unknown" rather than inventing a value.
    assert.equal(recordInstalledVersion(home, undefined, 'C:/app'), undefined);
    assert.equal(existsSync(join(home, INSTALL_RECORD)), false);
    assert.equal(recordInstalledVersion(home, '   ', 'C:/app'), undefined);
    assert.equal(existsSync(join(home, INSTALL_RECORD)), false);

    assert.equal(recordInstalledVersion(home, '0.2.1-alpha.1.20261007.2', 'C:/app'),
      '0.2.1-alpha.1.20261007.2');
    const record = JSON.parse(readFileSync(join(home, INSTALL_RECORD), 'utf8'));
    assert.equal(record.version, '0.2.1-alpha.1.20261007.2');
    assert.equal(record.installDir, 'C:/app');
    assert.equal(typeof record.installedAt, 'string');
    assert.equal(INSTALL_RECORD, 'dsharness-install.json');
    assert.equal(readInstallRecord(home)?.version, '0.2.1-alpha.1.20261007.2');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('deploy entry: creates the profile the application would, and never rewrites one', () => {
  const home = temporaryDirectory('deploy-profile-');
  try {
    assert.equal(ensureDesktopProfile(home), true);
    const dir = join(home, 'profiles', 'desktop');
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, [...PROFILE_BUNDLES]);
    assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), PROFILE_PATCH_TEMPLATE);
    assert.equal(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'), PROFILE_PNPM_WORKSPACE);
    // A second run is the application's own first launch: everything is the user's now.
    writeFileSync(join(dir, 'package.json'), '{"mine":true}\n');
    assert.equal(ensureDesktopProfile(home), false);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{"mine":true}\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('deploy entry: the Desktop profile is provisioned first, then whatever the home already has', () => {
  const home = temporaryDirectory('deploy-profiles-');
  try {
    assert.deepEqual(profilesUnder(home), ['desktop']);
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true });
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true });
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true });
    assert.deepEqual(profilesUnder(home), ['desktop', 'web']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * The shipped layer must leave the default-model row **writable**, and the profile layer
 * must be what supplies it.
 *
 * This test is the inverse of the one it replaces. While `platform/cordis.patch.yml`
 * carried `- id: agent-default-model`, the home layer was the last word and
 * `AgentDefaultModelConfig.saveSelection()` (`packages/core/agent-default-model/src/index.ts:82-94`,
 * through the same `configEditor.edit`) threw on every composer model choice. Removing the
 * row is what makes the composer's selection persist, and the value it starts from comes
 * from the profile layer `provision.mjs` writes.
 *
 * The dangerous case the old shape guarded against is now closed by the composition
 * instead: `initializeDefaultModel()` (`packages/api/session-controller/src/index.ts:298-310`)
 * hardcodes `provider = 'deepseek-account'`, and that route is registered only by the
 * `llm-deepseek-account` row this deployment disables — so the catalog it searches has no
 * such group at all and it throws `session/provider-models-unavailable` (caught by its
 * caller) instead of writing anything.
 */
test('deploy entry: the shipped layer leaves the default-model row writable for the composer', () => {
  const home = temporaryDirectory('deploy-layer-');
  try {
    const profileDir = join(home, 'profiles', 'desktop');
    mkdirSync(profileDir, { recursive: true });
    // The profile layer, exactly as `initializeDefaultModel` used to leave it — and as
    // the composer's own selection write leaves it: a user-owned row.
    writeFileSync(join(profileDir, 'cordis.patch.yml'),
      '- id: agent-default-model\n  config:\n    provider: dsharness-relay\n    model: deepseek-v4.1-flash\n');
    const block = readFileSync(join(payloadDirectory(here), 'cordis.patch.yml'), 'utf8');
    installInto(home, block, { write: false });
    const profilePatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.match(profilePatch, /provider: dsharness-relay/, 'the profile layer owns the selection');
    // The shipped layer names no such row, which is what makes that write legal.
    assert.doesNotMatch(block, /^- id: agent-default-model$/mu);
    assert.doesNotMatch(block, /^- id: llm-pi-ai$/mu);
    // The selection is still this deployment's, because `provision.mjs` wrote it there.
    const { MODEL_CATALOG_ROWS } = payloadModules;
    const selection = MODEL_CATALOG_ROWS.find((row) => row.id === 'agent-default-model');
    assert.match(selection.body, /^ {4}provider: 'dsharness-relay'$/mu);
    assert.match(selection.body, /^ {4}model: 'deepseek-v4\.1-flash'$/mu);
    // And the account route that `initializeDefaultModel` targets cannot be mounted here.
    assert.match(block, /^- id: llm-deepseek-account\n {2}disabled: true$/mu);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('deploy entry: writes the rows and provisions every profile, with an injected runner', () => {
  const home = temporaryDirectory('deploy-rows-');
  const install = temporaryDirectory('deploy-install-');
  try {
    const calls = [];
    const report = deploy({
      home,
      installDir: install,
      run: (profileDir, args) => { calls.push({ profileDir, args }); return { status: 0, output: '' }; },
    });
    assert.equal(report.created, true);
    assert.equal(report.target, join(home, 'cordis.patch.yml'));
    assert.match(readFileSync(report.target, 'utf8'), /platformOrigin: 'https:\/\/www\.czmanong\.com'/u);
    assert.deepEqual(report.reports.map((entry) => entry.profile), ['desktop']);
    assert.deepEqual(calls.map((call) => call.profileDir), [join(home, 'profiles', 'desktop')]);
    assert.deepEqual(calls[0].args.slice(0, 1), ['add']);
    assert.ok(calls[0].args.includes('dshmarket'), 'the marketplace install is what makes the Plugins page work');
    // The generated bundle package is placed without a package manager, so it survives an offline install.
    const bundleDir = join(home, 'profiles', 'desktop', 'node_modules', 'dsharness');
    assert.ok(existsSync(join(bundleDir, 'index.mjs')));
    /*
     * The browser half travels with the payload too. `provision.mjs` reads
     * `plugin.clientEntry` relative to its own directory, so an installed payload
     * carrying only the host half would fail to generate the package -- which is why both
     * files are in PAYLOAD_MODULES and both are embedded by the NSIS include.
     */
    assert.ok(existsSync(join(bundleDir, 'client.js')), 'the browser half must be generated by an installed payload');
    const installed = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8'));
    assert.equal(installed.dsh.client.platform, 'web');
    assert.equal(installed.exports['./client'], './client.js');
    /*
     * The installed patch is what makes the card unclosable, and it is generated by the
     * payload -- so this is the last place the shield can be lost between here and an
     * end-user machine. `listBundles` reads it from the profile, not from `platform/`.
     */
    const patch = readFileSync(join(bundleDir, 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /^ {4}- id: dsharness$/mu);
    assert.match(patch, /^ {4}- name: '@deepseek-ai\/dsh-plugin-manager'\n {6}disabled: true$/mu);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(install, { recursive: true, force: true });
  }
});

test('deploy entry: an install directory is required', () => {
  const previous = process.env.DSHARNESS_INSTALL_DIR;
  delete process.env.DSHARNESS_INSTALL_DIR;
  try {
    assert.throws(() => deploy({ home: temporaryDirectory('deploy-nodir-'), run: () => ({ status: 0 }) }), /install directory is required/);
  } finally {
    if (previous !== undefined) process.env.DSHARNESS_INSTALL_DIR = previous;
  }
});

test('config hook: rewrites only the upstream configuration argument', () => {
  const argv = ['node', 'C:\\client\\apps\\desktop\\node_modules\\electron-builder\\cli.js', '--config', 'electron-builder.config.mjs', '--win'];
  assert.equal(rewriteConfigArgument(argv, 'C:\\staged\\config.mjs'), true);
  assert.equal(argv[3], 'C:\\staged\\config.mjs');
  // A run that already names another configuration is left alone: the substitution happens once.
  const other = ['node', 'cli.js', '--config', 'C:\\staged\\config.mjs'];
  assert.equal(rewriteConfigArgument(other, 'C:\\other.mjs'), false);
  assert.equal(other[3], 'C:\\staged\\config.mjs');
  // `--config.<path>=<value>` overrides carry no separate argument and must not be touched.
  const dotted = ['node', 'cli.js', '--config.nsis.unicode=false'];
  assert.equal(rewriteConfigArgument(dotted, 'C:\\staged\\config.mjs'), false);
  assert.deepEqual(dotted.slice(2), ['--config.nsis.unicode=false']);
});

test('config hook: reads its configuration path from the environment', () => {
  assert.equal(readConfigEnvironment(undefined), undefined);
  assert.equal(readConfigEnvironment(''), undefined);
  assert.equal(readConfigEnvironment('C:\\staged\\config.mjs'), 'C:\\staged\\config.mjs');
  assert.match(readConfigEnvironment(pathToFileURL('C:\\staged\\config.mjs').href), /staged/);
  assert.equal(readConfigEnvironment('config.mjs'), resolve('config.mjs'));
});

test('config hook: the environment a packaging run sets is self-consistent', () => {
  const env = hookEnvironment('C:\\staged\\config.mjs');
  assert.match(env.NODE_OPTIONS, /^--import file:\/\/\/.*nsis-config-hook\.mjs$/u);
  assert.equal(env.DSHARNESS_NSIS_CONFIG_HOOK, '1');
  assert.equal(env.DSHARNESS_NSIS_CONFIG, 'C:\\staged\\config.mjs');
  assert.ok(existsSync(fileURLToPath(env.NODE_OPTIONS.replace('--import ', ''))));
});

test('package-windows: only an unsigned Windows build may be produced', () => {
  assert.deepEqual(parseArguments(['--unsigned']),
    { passthrough: ['--unsigned'], check: false, origin: DEFAULT_PLATFORM_ORIGIN, registry: undefined });
  assert.deepEqual(parseArguments(['--unsigned', '--build-version', '0.2.1-alpha.1.20261007.1']).passthrough,
    ['--unsigned', '--build-version', '0.2.1-alpha.1.20261007.1']);
  assert.deepEqual(parseArguments(['--check']).check, true);
  assert.equal(parseArguments(['--check', '--platform-origin', 'https://example.test']).origin, 'https://example.test');
  assert.throws(() => parseArguments([]), /unsigned Windows builds only/u);
  assert.throws(() => parseArguments(['--unsigned', '--config']), /unknown option/u);
  assert.throws(() => parseArguments(['--unsigned', '--build-version']), /requires a value/u);
  assert.throws(() => parseArguments(['--unsigned', '--platform-origin']), /requires a value/u);
  assert.throws(() => parseArguments(['--unsigned', '--registry']), /requires a value/u);
});

test('package-windows: --registry reaches the prepare stage as npm_config_registry', () => {
  /*
   * Measured: a run whose registry answered `error (23)` for
   * `@deepseek-ai/libreoffice-kit-win32-x64` ended in
   * `desktop runtime: missing required LibreOffice engine win32-x64` — a message
   * that names the engine, not the download that never happened. Pointing the run
   * at a mirror fixed it immediately, so the option exists rather than the knowledge.
   */
  const parsed = parseArguments(['--unsigned', '--registry', 'https://registry.npmmirror.com']);
  assert.equal(parsed.registry, 'https://registry.npmmirror.com');
  assert.deepEqual(parsed.passthrough, ['--unsigned'], 'the registry is ours, not an upstream flag');
  assert.equal(hookEnvironment('C:/x.mjs', parsed.registry).npm_config_registry, parsed.registry);
  // Omitted: nothing is set, so the ambient registry keeps working.
  assert.equal('npm_config_registry' in hookEnvironment('C:/x.mjs'), false);
});

/**
 * The descriptor has to be inside the packaged resources, not only written by the
 * installer.
 *
 * An update install is silent and force-run, so the assisted installer relaunches
 * the application at the end of the install section
 * (`app-builder-lib/templates/nsis/installSection.nsh:105-109`) — measured with an
 * NSIS ordering probe to happen *before* `.onInstSuccess` writes `app-update.yml`.
 * The relaunched instance therefore sees `enabled() === false`
 * (`update-coordinator.ts:54`) and reports one spurious failure.
 *
 * The decision lives in `windows/update-descriptor.mjs` rather than in
 * `windows/electron-builder-config.mjs` because importing the latter requires a
 * release environment: it loads the upstream config, which throws
 * `desktop release environment: DSH_DESKTOP_APP_ID must be set` without one.
 */
test('electron-builder config: the update descriptor is staged into the packaged resources', () => {
  const upstreamResources = [
    { from: 'C:/runtime', to: 'runtime' },
    { from: 'C:/icon-windows.png', to: 'icon.png' },
  ];
  const combined = withUpdateDescriptor(upstreamResources);
  assert.deepEqual(combined.slice(0, upstreamResources.length), upstreamResources,
    'upstream resources must survive: they carry the Node runtime, the icon and the tray bitmap');
  assert.deepEqual(combined.at(-1), { to: 'app-update.yml', from: updateDescriptor });
  assert.notEqual(combined, upstreamResources, 'the input list must not be mutated in place');
  // Undefined upstream list still yields the descriptor rather than throwing.
  assert.deepEqual(withUpdateDescriptor(undefined).map((entry) => entry.to), ['app-update.yml']);
  // Composing twice must not add a second entry for the same target directory.
  assert.equal(withUpdateDescriptor(combined).filter((entry) => entry.to === 'app-update.yml').length, 1);

  assert.ok(existsSync(updateDescriptor), 'the descriptor must exist at build time');
  assertUpdateDescriptor(updateDescriptor);
  assert.throws(() => assertUpdateDescriptor(join(windowsDir, 'no-such-descriptor.yml')),
    /the packaged updater would have no feed descriptor/u);
});

test('upstream parity: the literal profile an install creates matches initProfile', () => {
  /*
   * Source-text half: this runs everywhere, and fails when upstream's recipe
   * moves. The templates are template literals in `profile.ts`, so the escapes
   * have to be undone before comparing against the written files.
   */
  const source = readFileSync(upstreamProfile, 'utf8');
  const unescape = (text) => text.replaceAll('\\`', '`').replaceAll('\\${', '${');
  const literal = (name) => {
    const match = new RegExp(`const ${name} = \`([\\s\\S]*?)\`\\n`, 'u').exec(source);
    assert.ok(match, `${name} must still be a template literal in packages/boot/app-boot/src/profile.ts`);
    return unescape(match[1]);
  };
  assert.equal(PROFILE_PATCH_TEMPLATE, literal('PROFILE_PATCH_TEMPLATE'));
  assert.equal(PROFILE_PNPM_WORKSPACE, literal('PROFILE_PNPM_WORKSPACE'));
  assert.match(source, new RegExp(`web: \\{\\s*bundles: \\[${PROFILE_BUNDLES.map((name) => `'${name.replaceAll('/', '\\/')}'`).join(', ')}\\],`, 'u'));
  assert.equal(JSON.parse(readFileSync(join(clientDir, 'packages', 'boot', 'app-boot', 'package.json'), 'utf8')).name,
    '@deepseek-ai/dsh-app-boot');

  /*
   * Behavioural half: run upstream's own function through tsx and compare byte
   * for byte. `tsx` is a development dependency of this workspace; without it
   * the source-text assertions above are the whole guard.
   */
  const tsx = join(clientDir, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
  if (!existsSync(tsx)) return;
  const directory = temporaryDirectory('initprofile-');
  try {
    const probe = join(directory, 'probe.mjs');
    writeFileSync(probe, [
      `import { initProfile, PROFILE_TEMPLATES } from ${JSON.stringify(pathToFileURL(upstreamProfile).href)}`,
      "import { readFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      'const dir = process.argv[2]',
      'initProfile(dir, PROFILE_TEMPLATES.web.bundles)',
      "const out = {}",
      "for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) out[file] = readFileSync(join(dir, file), 'utf8')",
      'process.stdout.write(JSON.stringify(out))',
      '',
    ].join('\n'));
    const target = join(directory, 'profile');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(tsx).href, probe, target], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const upstream = JSON.parse(result.stdout);
    assert.equal(PROFILE_PATCH_TEMPLATE, upstream['cordis.patch.yml']);
    assert.equal(PROFILE_PNPM_WORKSPACE, upstream['pnpm-workspace.yaml']);
    assert.deepEqual(PROFILE_BUNDLES, JSON.parse(upstream['package.json']).dsh.profile.bundles);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
