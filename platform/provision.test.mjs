import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MARKETPLACE_PACKAGE,
  PROFILE_PLUGINS,
  REPLACED_PLUGINS,
  planProvisioning,
  pluginInstallSpec,
  provisionAll,
  provisionProfile,
  unprovisionProfile,
  writePluginPackage,
} from './provision.mjs';

/**
 * The plugin provisioning contract.
 *
 * Three product asks these tests guard:
 *
 * > 我希望把这个插件作为一个自定义插件，默认不启用。
 * > 还有插件市场这个插件，默认启用
 * > 可以把 dshdesktop 网关、模型 key、检查更新、应用内检查更新这些插件合并成
 * > 码农 DSH 插件，其中包了多个组件。该插件虽然是已安装的自定义插件，但是是不可以关闭的
 *
 * The first two are decided by *packaging*: the Plugins page groups cards by
 * `installed` (a manifest dependency) and `enabled` (a `dsh.profile.bundles`
 * selection). The third is decided by the bundle's own patch, which carries the shield
 * row that makes the card read-only. All three are easy to get subtly wrong in ways that
 * only show up as "the page has no card", "the switch does nothing" or "the switch works
 * when it must not", so the assertions below are about exactly those facts.
 *
 * Everything runs against a temporary harness home: the real profile is never
 * touched, and no pnpm runs (the runner is injected).
 */

/** The one plugin this product generates locally. */
const OWN = PROFILE_PLUGINS.find((plugin) => plugin.name === 'dsharness');

/** Every plugin this product generates locally, in shipped order. */
const OWN_PLUGINS = [OWN];

/** The plugins that start switched on. */
const SELECTED_PLUGINS = [OWN];

/** A host-only plugin, to prove the generator still handles a bundle with no browser half. */
const HOST_ONLY = {
  name: 'plain-plugin',
  entry: 'install.mjs',
  rowId: 'plain-plugin',
  title: 'plain',
  description: 'plain',
};

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');

/** A minimal initialized profile. */
function makeProfile(root, name) {
  const dir = join(root, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'package.json'), {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  });
  writeFileSync(join(dir, 'cordis.patch.yml'), '# profile patch\n[]\n', 'utf8');
  return dir;
}

/** A fake pnpm that records the dependency it "installed" into the manifest. */
function fakeRunner(profileDir, calls) {
  return (_cwd, args) => {
    calls.push(args);
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    for (const spec of args.slice(1, -1)) {
      manifest.dependencies[spec] = '^1.0.0';
    }
    writeJson(join(profileDir, 'package.json'), manifest);
    return { status: 0, output: '' };
  };
}

test('PROFILE_PLUGINS: this product ships exactly one bundle, and it is on by default', () => {
  assert.deepEqual(PROFILE_PLUGINS.map((plugin) => plugin.name), ['dsharness']);
  assert.equal(OWN.defaultEnabled, true);
  // The card's title is the product's own name, not the package name.
  assert.equal(OWN.zhTitle, '码农 DSH');
  // Host half and browser half are two files of ONE package: a classic script cannot be
  // the Loader entry, and an ESM plugin cannot be a browser script.
  assert.notEqual(OWN.entry, OWN.clientEntry);
  assert.equal(OWN.rowId, OWN.name, 'the row id is the package name, which is also the client bundle id');
});

test('REPLACED_PLUGINS: the four bundles this round merged away are named', () => {
  // A profile provisioned by an earlier build still lists these. Without the list they
  // would keep running beside their replacement: a second gateway, a second key delivery
  // loop and a second update surface.
  assert.deepEqual([...REPLACED_PLUGINS].sort(), [
    'dsharness-host-auth', 'dsharness-model-key', 'dsharness-update', 'dsharness-update-ui',
  ]);
  for (const name of REPLACED_PLUGINS) {
    assert.ok(!PROFILE_PLUGINS.some((plugin) => plugin.name === name), `${name} must not still be shipped`);
  }
});

test('planProvisioning: only the bundle and the marketplace are obtained, and both are selected', () => {
  const plan = planProvisioning({ dependencies: {}, dsh: { profile: { bundles: [] } } });
  assert.deepEqual(
    plan.install.map((entry) => entry.name),
    [...OWN_PLUGINS.map((plugin) => plugin.name), MARKETPLACE_PACKAGE],
  );
  // The bundle must start selected: a model route whose credential is never delivered
  // fails every request, and a status panel nobody switched on is invisible in the UI.
  assert.deepEqual(plan.select, [...SELECTED_PLUGINS.map((plugin) => plugin.name), MARKETPLACE_PACKAGE]);
  assert.deepEqual(plan.retired, []);
});

test('planProvisioning: our own plugin needs no package manager, the marketplace does', () => {
  const plan = planProvisioning({ dependencies: {}, dsh: { profile: { bundles: [] } } });
  // Split matters: our package is generated locally, so a machine that has never reached
  // npm still gets a working gateway, a working credential and a working update entry.
  assert.deepEqual(plan.link.map((entry) => entry.name), OWN_PLUGINS.map((plugin) => plugin.name));
  assert.deepEqual(plan.add.map((entry) => entry.name), [MARKETPLACE_PACKAGE]);
  // A file: spec inside the profile — see pluginInstallSpec for why not link:.
  assert.equal(plan.link[0].spec, pluginInstallSpec(OWN.name));
  // A registry package installs by name; only ours carry a path spec.
  assert.equal(plan.add[0].spec, MARKETPLACE_PACKAGE);
});

test('planProvisioning: a profile from an earlier build lists the four old bundles as retired', () => {
  const plan = planProvisioning({
    dependencies: Object.fromEntries(REPLACED_PLUGINS.map((name) => [name, `file:./node_modules/${name}`])),
    dsh: { profile: { bundles: [...REPLACED_PLUGINS, 'dshmarket'] } },
  });
  assert.deepEqual(plan.retired, REPLACED_PLUGINS);
  // Retiring is not "uninstalling and reinstalling": the replacement is still new here,
  // and the marketplace this manifest never had is still obtained.
  assert.deepEqual(plan.install.map((entry) => entry.name), ['dsharness', MARKETPLACE_PACKAGE]);
  assert.deepEqual(plan.select, ['dsharness']);
});

test('pluginInstallSpec: a file spec inside the profile, never link: or an absolute path', () => {
  const spec = pluginInstallSpec('dsharness');
  assert.equal(spec, 'file:./node_modules/dsharness');
  // Relative to the profile, and pointing at the profile's own tree: a link: to a
  // directory outside the profile is what pnpm prunes on the next install.
  assert.ok(!spec.startsWith('link:'));
  assert.ok(!spec.includes(':C') && !spec.includes(':\\\\'));
});

test('planProvisioning: selection is only ever added, never removed', () => {
  // A selection the person made in the page must survive every rerun; a bundle they
  // switched off must stay off.
  const plan = planProvisioning({
    dependencies: {
      ...Object.fromEntries(OWN_PLUGINS.map((plugin) => [plugin.name, 'link:../../x'])),
      [MARKETPLACE_PACKAGE]: '^1',
    },
    dsh: { profile: { bundles: ['some-bundle-the-person-switched-on'] } },
  });
  assert.deepEqual(plan.install, [], 'everything is already installed');
  assert.deepEqual(plan.select, [
    ...SELECTED_PLUGINS.map((plugin) => plugin.name),
    MARKETPLACE_PACKAGE,
  ], 'only the not-yet-selected ones are added');
  assert.deepEqual(plan.retired, [], 'nothing this round shipped is ever retired');
});

test('planProvisioning: already selected means nothing to install and nothing to select', () => {
  const plan = planProvisioning({
    dependencies: {
      ...Object.fromEntries(OWN_PLUGINS.map((plugin) => [plugin.name, 'link:../../x'])),
      [MARKETPLACE_PACKAGE]: '^1',
    },
    dsh: { profile: { bundles: [...SELECTED_PLUGINS.map((plugin) => plugin.name), MARKETPLACE_PACKAGE] } },
  });
  assert.deepEqual(plan.install, []);
  assert.deepEqual(plan.select, []);
});

test('planProvisioning: --no-marketplace leaves the marketplace entirely alone', () => {
  const plan = planProvisioning(
    { dependencies: {}, dsh: { profile: { bundles: [] } } },
    { withMarketplace: false },
  );
  assert.deepEqual(plan.install.map((entry) => entry.name), OWN_PLUGINS.map((plugin) => plugin.name));
  assert.deepEqual(plan.select, SELECTED_PLUGINS.map((plugin) => plugin.name));
});

test('writePluginPackage: the package declares a bundle patch, a relative row and the shield', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = writePluginPackage(join(root, 'pkg'), OWN);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, OWN.name);
    // `listBundles` reads `dsh.bundle.patch`; without it the package is not a bundle.
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
    // The row name resolves relative to THIS file (`anchorInsertedPluginNames`),
    // which is what lets the package move between profiles.
    assert.match(patch, /^ {4}- id: dsharness$/m);
    assert.match(patch, /^ {6}name: \.\/index\.mjs$/m);
    /*
     * The product row itself states no default state: the default belongs to the
     * selection (`dsh.profile.bundles`). The only `disabled:` in the file is the shield,
     * which is the mechanism that makes this bundle unclosable — see the next test.
     * (Counted as a YAML key, so the explanatory comment above it does not match.)
     */
    assert.equal((patch.match(/^\s+disabled:/gmu) ?? []).length, 1);
    // The entry is a copy, so the package is self-contained.
    assert.ok(existsSync(join(dir, 'index.mjs')));
    assert.equal(readFileSync(join(dir, 'index.mjs'), 'utf8'), readFileSync(join(import.meta.dirname, OWN.entry), 'utf8'));
    // Card text comes from `locale/<lang>.json`; without it the card is the package name.
    const en = JSON.parse(readFileSync(join(dir, 'locale', 'en.json'), 'utf8'));
    const zh = JSON.parse(readFileSync(join(dir, 'locale', 'zh.json'), 'utf8'));
    assert.equal(typeof en.meta.title, 'string');
    assert.equal(zh.meta.title, '码农 DSH');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writePluginPackage: the shield row is id-less and disabled, so it cannot show or load', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = writePluginPackage(join(root, 'pkg'), OWN);
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
    /*
     * The shield is the whole "cannot be switched off" mechanism: `protectsManager`
     * (`packages/boot/plugin-manager/src/index.ts:763-773`) is true when any inserted row
     * names a `protectedModules` entry, and `@deepseek-ai/dsh-plugin-manager` is one.
     *
     * Two properties matter and both are asserted as literal text, because either one
     * silently breaking turns the shield into a visible phantom row (`declaredRows` lists
     * any inserted row with a string id) or into a real module dependency (a row that is
     * not disabled gets imported, and this name would then have to resolve).
     */
    assert.match(patch, /^ {4}- name: '@deepseek-ai\/dsh-plugin-manager'$/m, 'the shield names a protected module');
    assert.match(patch, /^ {4}- name: '@deepseek-ai\/dsh-plugin-manager'\n {6}disabled: true$/m, 'and is disabled');
    // Exactly one id per bundle: the product row. An id on the shield would surface it.
    assert.equal((patch.match(/^ {4}- id: /gmu) ?? []).length, 1);
    assert.equal((patch.match(/- id: /gu) ?? []).length, 1);
    // One `insert:` list, so both rows land in the same layer and the same reload pass.
    assert.equal((patch.match(/^- insert:$/gmu) ?? []).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writePluginPackage: the product row carries per-component config, keyed by component', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = writePluginPackage(join(root, 'pkg'), OWN);
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
    // One row, three config sections: the merged host half reads `{gateway, modelKey, update}`.
    assert.match(patch, /^ {6}config:$/m);
    assert.match(patch, /^ {8}gateway:$/m);
    assert.match(patch, /^ {8}modelKey: \{\}$/m);
    assert.match(patch, /^ {8}update: \{\}$/m);
    // The secret comes from the environment and is never written into the repo.
    assert.match(patch, /^ {10}token: !!js process\.env\.DSH_AUTH_TOKEN \?\? ''$/m);
    assert.ok(!/token:\s*['"]?[A-Za-z0-9_-]{16,}/.test(patch), 'no literal secret may appear in the generated patch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writePluginPackage: a browser half is declared with the two fields the roster reads', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = writePluginPackage(join(root, 'pkg'), OWN);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    // `platform: 'web'` is the activation-scan filter; a misspelled subkey is not a
    // warning anywhere (`parseDshClient` only ever reads `platform`), so the bundle
    // would just never be served.
    assert.equal(manifest.dsh.client.platform, 'web');
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'a browser half still needs a host half to be a bundle');
    const clientRel = manifest.exports['./client'];
    assert.equal(clientRel, './client.js');
    // The export must point at a file that really landed there.
    const clientPath = join(dir, clientRel);
    assert.ok(existsSync(clientPath), './client must point at the packaged bundle');
    assert.equal(
      readFileSync(clientPath, 'utf8'),
      readFileSync(join(import.meta.dirname, OWN.clientEntry), 'utf8'),
    );
    // The module loader reconciles the registration `id` against the package name
    // and drops the bundle when they disagree, so the literal is compared here.
    const bundle = readFileSync(clientPath, 'utf8');
    const id = /id:\s*'([^']+)'/.exec(bundle)?.[1];
    assert.equal(id, OWN.name);
    // The classic-script bundle must not be the Loader entry: Node imports
    // `index.mjs`, and a browser script cannot also be an ESM plugin.
    assert.equal(manifest.main, './index.mjs');
    assert.ok(!readFileSync(join(dir, 'index.mjs'), 'utf8').includes('__ModuleLoader__'));
    // The generated manifest travels inside the NSIS payload and is read back on machines
    // with a non-UTF-8 console; ASCII keeps a mojibake'd card title from going unnoticed.
    const written = readFileSync(join(dir, 'package.json'), 'utf8');
    assert.ok(!written.includes('\\u'), 'JSON.stringify must not leave escape sequences behind');
    assert.equal(Buffer.from(written, 'utf8').filter((byte) => byte > 0x7f).length, 0);
    // The English locale text is the manifest description, so it is ASCII for the same reason.
    assert.equal(Buffer.from(readFileSync(join(dir, 'locale', 'en.json'), 'utf8'), 'utf8')
      .filter((byte) => byte > 0x7f).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writePluginPackage: a host-only plugin gains no client fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    // The generator must stay general: a bundle with no browser half gets no `dsh.client`,
    // no `./client` export and no `client.js`, and its patch carries no config block.
    const dir = writePluginPackage(join(root, 'plain'), HOST_ONLY);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal('client' in manifest.dsh, false);
    assert.equal('./client' in manifest.exports, false);
    assert.equal(existsSync(join(dir, 'client.js')), false);
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
    assert.ok(!/^ {6}config:$/m.test(patch), 'a plugin with no config must not emit an empty config key');
    // The shield is unconditional: every generated bundle is unclosable, not just this one.
    assert.match(patch, /^ {4}- name: '@deepseek-ai\/dsh-plugin-manager'$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionProfile: dry run writes no plugin package and runs no package manager', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    makeProfile(root, 'desktop');
    let ran = 0;
    const report = provisionProfile(root, 'desktop', { write: false, run: () => { ran += 1; return { status: 0, output: '' }; } });
    assert.equal(report.status, 'planned');
    assert.equal(ran, 0, 'a dry run must not shell out');
    assert.equal(existsSync(join(root, 'profiles', 'desktop', 'node_modules')), false, 'a dry run must not write packages');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionProfile: installs the bundle, selects it and the marketplace', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = makeProfile(root, 'desktop');
    const calls = [];
    const report = provisionProfile(root, 'desktop', { run: fakeRunner(dir, calls) });
    assert.equal(report.status, 'ok');
    // One package-manager run, for the marketplace only: our package is generated.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(1, -1), [MARKETPLACE_PACKAGE]);
    assert.deepEqual(
      report.installed.sort(),
      [...OWN_PLUGINS.map((plugin) => plugin.name), MARKETPLACE_PACKAGE].sort(),
    );
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    // `installed` is what makes the Plugins page show a card at all.
    for (const plugin of OWN_PLUGINS) assert.ok(Object.hasOwn(manifest.dependencies, plugin.name));
    assert.ok(Object.hasOwn(manifest.dependencies, MARKETPLACE_PACKAGE));
    // Our dependency points at the package inside the profile, as a file: spec.
    for (const plugin of OWN_PLUGINS) {
      assert.equal(manifest.dependencies[plugin.name], pluginInstallSpec(plugin.name));
    }
    // `enabled` follows `defaultEnabled`.
    assert.deepEqual(manifest.dsh.profile.bundles.filter((name) => name === MARKETPLACE_PACKAGE), [MARKETPLACE_PACKAGE]);
    for (const plugin of SELECTED_PLUGINS) {
      assert.deepEqual(manifest.dsh.profile.bundles.filter((name) => name === plugin.name), [plugin.name]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionProfile: a profile from an earlier build loses the four merged-away bundles', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = makeProfile(root, 'desktop');
    // Exactly what an older build left behind: four generated packages, both flags set.
    const stale = { ...JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) };
    stale.dependencies = Object.fromEntries(REPLACED_PLUGINS.map((name) => [name, `file:./node_modules/${name}`]));
    stale.dsh.profile.bundles = ['@deepseek-ai/dsh-base', ...REPLACED_PLUGINS, 'dshmarket'];
    writeJson(join(dir, 'package.json'), stale);
    for (const name of REPLACED_PLUGINS) {
      mkdirSync(join(dir, 'node_modules', name), { recursive: true });
      writeJson(join(dir, 'node_modules', name, 'package.json'), { name });
    }
    const report = provisionProfile(root, 'desktop', { run: fakeRunner(dir, []) });
    assert.deepEqual(report.retired, REPLACED_PLUGINS);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const name of REPLACED_PLUGINS) {
      // Both flags, because either one alone is broken: a dependency without a selection
      // is fine but the four directories would sit there as cards, and a selection without
      // a dependency is a skipped bundle the Loader reports on every boot.
      assert.ok(!Object.hasOwn(manifest.dependencies, name), `${name} must lose its dependency`);
      assert.ok(!manifest.dsh.profile.bundles.includes(name), `${name} must lose its selection`);
      assert.equal(existsSync(join(dir, 'node_modules', name)), false, `${name} must lose its directory`);
    }
    // The replacement arrived in the same run, so the profile never boots without it.
    assert.ok(Object.hasOwn(manifest.dependencies, OWN.name));
    assert.ok(manifest.dsh.profile.bundles.includes(OWN.name));
    // A package the person installed themselves is not touched.
    assert.ok(manifest.dsh.profile.bundles.includes('dshmarket'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionProfile: retiring is idempotent across reruns', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = makeProfile(root, 'desktop');
    provisionProfile(root, 'desktop', { withMarketplace: false, run: () => ({ status: 0, output: '' }) });
    const first = readFileSync(join(dir, 'package.json'), 'utf8');
    const second = provisionProfile(root, 'desktop', { withMarketplace: false, run: () => ({ status: 0, output: '' }) });
    assert.deepEqual(second.retired, [], 'nothing left to retire');
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), first, 'a rerun must change nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionProfile: the marketplace failure does not stop our plugin being installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = makeProfile(root, 'desktop');
    // Offline: pnpm fails, but the bundle must still land — the model key and the gateway
    // are what make the product usable at all, and neither needs the network to install.
    const report = provisionProfile(root, 'desktop', { run: () => ({ status: 1, output: 'ERR_PNPM no network' }) });
    assert.equal(report.status, 'partial');
    assert.deepEqual(report.installed, OWN_PLUGINS.map((plugin) => plugin.name));
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const plugin of OWN_PLUGINS) assert.ok(Object.hasOwn(manifest.dependencies, plugin.name));
    assert.ok(!Object.hasOwn(manifest.dependencies, MARKETPLACE_PACKAGE), 'a failed install must not be recorded');
    assert.deepEqual(manifest.dsh.profile.bundles.filter((name) => name === MARKETPLACE_PACKAGE), [],
      'selecting a bundle that is not installed would be a skipped bundle at every boot');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionProfile: a failed install is reported and never throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    makeProfile(root, 'desktop');
    const report = provisionProfile(root, 'desktop', { run: () => ({ status: 1, output: 'ERR_PNPM no network' }) });
    assert.equal(report.status, 'partial');
    assert.equal(report.failures.length, 1);
    // A missing marketplace must never stop the app from starting, so this is
    // reported with the reason rather than raised.
    assert.match(report.failures[0].reason, /no network/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionProfile: rerunning twice installs nothing new and reselects nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = makeProfile(root, 'desktop');
    provisionProfile(root, 'desktop', { run: fakeRunner(dir, []) });
    const afterFirst = readFileSync(join(dir, 'package.json'), 'utf8');
    const second = provisionProfile(root, 'desktop', { run: () => { throw new Error('pnpm must not run again'); } });
    assert.equal(second.status, 'ok');
    assert.deepEqual(second.installed, []);
    assert.deepEqual(second.selected, []);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), afterFirst, 'a rerun must change nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionProfile: an already-installed plugin is refreshed, not left stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = makeProfile(root, 'desktop');
    const packageDir = join(dir, 'node_modules', OWN.name);
    provisionProfile(root, 'desktop', { withMarketplace: false, run: () => ({ status: 0, output: '' }) });
    // Simulate an installed copy that drifted from the source (an edited plugin).
    writeFileSync(join(packageDir, 'index.mjs'), '// stale copy\n', 'utf8');
    const report = provisionProfile(root, 'desktop', { withMarketplace: false, run: () => ({ status: 0, output: '' }) });
    /*
     * The installed entry is a COPY, so it must be rewritten on every run: the first
     * version refreshed only when the dependency was missing, and a plugin edit was then
     * silently ignored on any machine already provisioned.
     */
    assert.deepEqual(report.refreshed, OWN_PLUGINS.map((plugin) => plugin.name));
    assert.equal(
      readFileSync(join(packageDir, 'index.mjs'), 'utf8'),
      readFileSync(join(import.meta.dirname, OWN.entry), 'utf8'),
    );
    // A refresh is not a new install: nothing to report as "installed".
    assert.deepEqual(report.installed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionProfile: a profile that was never initialized is skipped, not created', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const report = provisionProfile(root, 'desktop');
    assert.equal(report.status, 'skipped');
    assert.equal(existsSync(join(root, 'profiles', 'desktop')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unprovisionProfile: takes back this round and everything it replaced', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = makeProfile(root, 'desktop');
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    manifest.dependencies = {
      [OWN.name]: pluginInstallSpec(OWN.name),
      ...Object.fromEntries(REPLACED_PLUGINS.map((name) => [name, `file:./node_modules/${name}`])),
      // Not ours: a package the person installed themselves stays.
      keepme: '^1',
    };
    manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', OWN.name, ...REPLACED_PLUGINS, 'dshmarket'];
    writeJson(join(dir, 'package.json'), manifest);
    for (const name of [OWN.name, ...REPLACED_PLUGINS]) {
      mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    }
    const report = unprovisionProfile(root, 'desktop');
    assert.deepEqual([...report.removed].sort(), [OWN.name, ...REPLACED_PLUGINS].sort());
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(Object.hasOwn(after.dependencies, 'keepme'), true, 'a package we do not own stays');
    for (const name of [OWN.name, ...REPLACED_PLUGINS]) {
      assert.ok(!Object.hasOwn(after.dependencies, name));
      assert.ok(!after.dsh.profile.bundles.includes(name));
      assert.equal(existsSync(join(dir, 'node_modules', name)), false);
    }
    // The marketplace loses its selection (documented) but never its installation.
    assert.equal(Object.hasOwn(after.dependencies, 'dshmarket'), false, 'the test never installed it as a dependency');
    assert.ok(!after.dsh.profile.bundles.includes('dshmarket'), 'its selection is taken back');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionAll: skips the shared node_modules directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    makeProfile(root, 'desktop');
    mkdirSync(join(root, 'profiles', 'node_modules'), { recursive: true });
    const reports = provisionAll(root, { write: false });
    assert.deepEqual(reports.map((report) => report.profile), ['desktop']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionAll: writes the generated package into the profile it belongs to', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = makeProfile(root, 'desktop');
    provisionAll(root, { write: true, run: fakeRunner(dir, []) });
    /*
     * Inside the profile's own node_modules, deliberately: it is a real dependency
     * of that profile, which is what makes `listBundles` report it as installed.
     * A directory outside the profile (or a link to one) is what pnpm prunes.
     */
    for (const plugin of OWN_PLUGINS) {
      assert.ok(existsSync(join(dir, 'node_modules', plugin.name, 'package.json')));
      // The browser half lands beside it, which is what the client roster serves.
      assert.ok(existsSync(join(dir, 'node_modules', plugin.name, 'client.js')));
    }
    // No second copy elsewhere in the harness home.
    assert.deepEqual(readdirSync(root).filter((name) => name !== 'profiles'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
