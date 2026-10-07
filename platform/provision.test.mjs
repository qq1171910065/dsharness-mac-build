import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MARKETPLACE_PACKAGE,
  PROFILE_PLUGINS,
  planProvisioning,
  pluginInstallSpec,
  provisionAll,
  provisionProfile,
  writePluginPackage,
} from './provision.mjs';

/**
 * The plugin provisioning contract.
 *
 * Two product asks these tests guard:
 *
 * > 我希望把这个插件作为一个自定义插件，默认不启用。
 * > 还有插件市场这个插件，默认启用
 *
 * …plus the delivery plugin, which is the opposite default on purpose: without
 * its key written into the credential store the product's model route has no
 * credential at all, so it must start switched on.
 *
 * Both halves are decided by *packaging*, and both are easy to get subtly wrong
 * in ways that only show up as "the page has no card" or "the switch does
 * nothing". So the assertions here are about the two flags the Plugins page
 * derives its groups from -- `installed` (a manifest dependency) and `enabled`
 * (a `dsh.profile.bundles` selection) -- plus the file and row shape the Loader
 * needs.
 *
 * Everything runs against a temporary harness home: the real profile is never
 * touched, and no pnpm runs (the runner is injected).
 */

/** The model-key delivery plugin: installed AND selected. */
const MODEL_KEY = PROFILE_PLUGINS.find((plugin) => plugin.name === 'dsharness-model-key');

/** The gateway plugin: installed but NOT selected. */
const GATEWAY = PROFILE_PLUGINS.find((plugin) => plugin.name === 'dsharness-host-auth');

/** Every plugin this product generates locally, in shipped order. */
const OWN_PLUGINS = [MODEL_KEY, GATEWAY];

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

test('planProvisioning: only the marketplace and the key plugin are selected (默认不启用)', () => {
  const plan = planProvisioning({ dependencies: {}, dsh: { profile: { bundles: [] } } });
  assert.deepEqual(
    plan.install.map((entry) => entry.name),
    [...OWN_PLUGINS.map((plugin) => plugin.name), MARKETPLACE_PACKAGE],
  );
  // The gateway plugin is installed but NOT selected; the model-key plugin must be
  // selected, because a model route whose credential is never delivered fails every
  // request with MISSING_CREDENTIAL.
  assert.deepEqual(plan.select, [MODEL_KEY.name, MARKETPLACE_PACKAGE]);
});

test('planProvisioning: our own plugins need no package manager, the marketplace does', () => {
  const plan = planProvisioning({ dependencies: {}, dsh: { profile: { bundles: [] } } });
  // Split matters: our packages are generated locally, so a machine that has never
  // reached npm still gets a working gateway plugin and a working model credential.
  assert.deepEqual(plan.link.map((entry) => entry.name), OWN_PLUGINS.map((plugin) => plugin.name));
  assert.deepEqual(plan.add.map((entry) => entry.name), [MARKETPLACE_PACKAGE]);
  // A file: spec inside the profile — see pluginInstallSpec for why not link:.
  assert.equal(plan.link[0].spec, pluginInstallSpec(MODEL_KEY.name));
  // A registry package installs by name; only ours carry a path spec.
  assert.equal(plan.add[0].spec, MARKETPLACE_PACKAGE);
});

test('pluginInstallSpec: a file spec inside the profile, never link: or an absolute path', () => {
  const spec = pluginInstallSpec('dsharness-host-auth');
  assert.equal(spec, 'file:./node_modules/dsharness-host-auth');
  // Relative to the profile, and pointing at the profile's own tree: a link: to a
  // directory outside the profile is what pnpm prunes on the next install.
  assert.ok(!spec.startsWith('link:'));
  assert.ok(!spec.includes(':C') && !spec.includes(':\\\\'));
});

test('planProvisioning: selection is only ever added, never removed', () => {
  // A selection the person made in the page must survive every rerun.
  const plan = planProvisioning({
    dependencies: { [MODEL_KEY.name]: 'link:../../x', [GATEWAY.name]: 'link:../../y', [MARKETPLACE_PACKAGE]: '^1' },
    dsh: { profile: { bundles: [GATEWAY.name] } },
  });
  assert.deepEqual(plan.install, [], 'everything is already installed');
  assert.deepEqual(plan.select, [MODEL_KEY.name, MARKETPLACE_PACKAGE], 'only the not-yet-selected ones are added');
});

test('planProvisioning: already selected means nothing to install and nothing to select', () => {
  const plan = planProvisioning({
    dependencies: { [MODEL_KEY.name]: 'link:../../x', [GATEWAY.name]: 'link:../../y', [MARKETPLACE_PACKAGE]: '^1' },
    dsh: { profile: { bundles: [MODEL_KEY.name, MARKETPLACE_PACKAGE] } },
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
  assert.deepEqual(plan.select, [MODEL_KEY.name]);
});

test('writePluginPackage: the package declares a bundle patch and a relative row name', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = writePluginPackage(join(root, 'pkg'), GATEWAY);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, GATEWAY.name);
    // `listBundles` reads `dsh.bundle.patch`; without it the package is not a bundle.
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
    // The row name resolves relative to THIS file (`anchorInsertedPluginNames`),
    // which is what lets the package move between profiles.
    assert.match(patch, /^ {4}- id: dsharness-host-auth$/m);
    assert.match(patch, /^ {6}name: \.\/index\.mjs$/m);
    /*
     * No `disabled` in the package's own row. A default written into a bundle
     * layer would be applied before the profile layer, so the page's switch could
     * override it — but it would also be wrong the other way round: the default
     * belongs to the selection (`dsh.profile.bundles`), not to the row.
     */
    assert.ok(!/disabled:/u.test(patch), 'the bundle row must not state a default state');
    // The entry is a copy, so the package is self-contained.
    assert.ok(existsSync(join(dir, 'index.mjs')));
    assert.equal(readFileSync(join(dir, 'index.mjs'), 'utf8'), readFileSync(join(import.meta.dirname, GATEWAY.entry), 'utf8'));
    // Card text comes from `locale/<lang>.json`; without it the card is the package name.
    const en = JSON.parse(readFileSync(join(dir, 'locale', 'en.json'), 'utf8'));
    const zh = JSON.parse(readFileSync(join(dir, 'locale', 'zh.json'), 'utf8'));
    assert.equal(typeof en.meta.title, 'string');
    assert.equal(typeof zh.meta.title, 'string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writePluginPackage: a plugin with no config block gets a row without one', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    // The key plugin needs no config: every value it uses comes from the account
    // session, so emitting an empty `config:` would be noise the Loader still accepts.
    const dir = writePluginPackage(join(root, 'pkg'), MODEL_KEY);
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /^ {4}- id: dsharness-model-key$/m);
    assert.ok(!/^ {6}config:$/m.test(patch), 'a plugin with no config must not emit an empty config key');
    // The gateway plugin still carries its own.
    const gateway = writePluginPackage(join(root, 'gateway'), GATEWAY);
    assert.match(readFileSync(join(gateway, 'cordis.patch.yml'), 'utf8'), /^ {6}config:$/m);
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

test('provisionProfile: installs all three, selects the marketplace and the key plugin', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = makeProfile(root, 'desktop');
    const calls = [];
    const report = provisionProfile(root, 'desktop', { run: fakeRunner(dir, calls) });
    assert.equal(report.status, 'ok');
    // One package-manager run, for the marketplace only: our packages are generated.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(1, -1), [MARKETPLACE_PACKAGE]);
    assert.deepEqual(
      report.installed.sort(),
      [...OWN_PLUGINS.map((plugin) => plugin.name), MARKETPLACE_PACKAGE].sort(),
    );
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    // `installed` for all three: this is what makes the Plugins page show cards at all.
    for (const plugin of OWN_PLUGINS) assert.ok(Object.hasOwn(manifest.dependencies, plugin.name));
    assert.ok(Object.hasOwn(manifest.dependencies, MARKETPLACE_PACKAGE));
    // Our dependencies point at the package inside the profile, as file: specs.
    for (const plugin of OWN_PLUGINS) {
      assert.equal(manifest.dependencies[plugin.name], pluginInstallSpec(plugin.name));
    }
    // `enabled` for the marketplace and the key plugin, never for the gateway one.
    assert.deepEqual(manifest.dsh.profile.bundles.filter((name) => name === MARKETPLACE_PACKAGE), [MARKETPLACE_PACKAGE]);
    assert.deepEqual(manifest.dsh.profile.bundles.filter((name) => name === MODEL_KEY.name), [MODEL_KEY.name]);
    assert.ok(!manifest.dsh.profile.bundles.includes(GATEWAY.name));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionProfile: the marketplace failure does not stop our plugins being installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsharness-provision-'));
  try {
    const dir = makeProfile(root, 'desktop');
    // Offline: pnpm fails, but the gateway plugin must still land — it is what the
    // mini-program talks to, and it does not need the network at all.
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
    const packageDir = join(dir, 'node_modules', GATEWAY.name);
    provisionProfile(root, 'desktop', { withMarketplace: false, run: () => ({ status: 0, output: '' }) });
    // Simulate an installed copy that drifted from the source (an edited plugin).
    writeFileSync(join(packageDir, 'index.mjs'), '// stale copy\n', 'utf8');
    const report = provisionProfile(root, 'desktop', { withMarketplace: false, run: () => ({ status: 0, output: '' }) });
    /*
     * The installed entry is a COPY, so it must be rewritten on every run: the
     * first version refreshed only when the dependency was missing, and a plugin
     * edit was then silently ignored on any machine already provisioned.
     */
    assert.deepEqual(report.refreshed, OWN_PLUGINS.map((plugin) => plugin.name));
    assert.equal(
      readFileSync(join(packageDir, 'index.mjs'), 'utf8'),
      readFileSync(join(import.meta.dirname, GATEWAY.entry), 'utf8'),
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
    }
    // No second copy elsewhere in the harness home.
    assert.deepEqual(readdirSync(root).filter((name) => name !== 'profiles'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
