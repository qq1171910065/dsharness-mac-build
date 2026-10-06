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
 * ## What this writes, where
 *
 * 1. `<profile>/node_modules/<name>/` — the bundle package, generated from the
 *    plugin's single source in `platform/`. Inside the profile on purpose: it is a
 *    real dependency of that profile, which is what `listBundles` reports as
 *    `installed`.
 * 2. `<profile>/package.json` — the `dependencies` entry for it, plus the
 *    `dsh.profile.bundles` selection of anything that should start switched on.
 *    A selection is only ever **added**, never removed: what the person switched in
 *    the page is theirs.
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
 * @property rowId - the Loader row the package's patch inserts.
 * @property title - card title (`locale/en.json`), so the card is not the bare name.
 * @property description - card one-liner.
 * @property defaultEnabled - whether to select the bundle on first provisioning.
 */
export const PROFILE_PLUGINS = [
  {
    name: 'dsharness-host-auth',
    entry: 'host-auth.mjs',
    rowId: 'dsharness-host-auth',
    title: 'DSH Desktop gateway',
    zhTitle: 'DSH Desktop 网关',
    description: 'Shared-secret access to the Harness API for this product: mini-program, scripts, other services.',
    zhDescription: '让本产品的服务端与脚本（小程序、巡检、外部系统）用共享密钥访问 Harness API。',
    defaultEnabled: false,
  },
];

/**
 * The community plugin marketplace, installed from npm and selected by default.
 *
 * `dshmarket` (`github.com/dsh-market/dsh-market`) is the **插件市场** page: browse,
 * search, and one-click install of community plugins. It is a third-party package,
 * so it is installed through pnpm rather than vendored, and it is default-enabled
 * per the product decision.
 */
export const MARKETPLACE_PACKAGE = 'dshmarket';

/** The bundle patch a generated package declares. */
function pluginPatch(plugin) {
  return [
    '# dsharness bundle patch: one row, mounted only while this bundle is selected.',
    '# The row carries no `disabled`: selection is the switch the Plugins page writes.',
    '- insert:',
    `    - id: ${plugin.rowId}`,
    '      name: ./index.mjs',
    '      config:',
    '        # Empty means unconfigured; the plugin then does nothing and logs one warning.',
    "        token: !!js process.env.DSH_AUTH_TOKEN ?? ''",
    '        cookieName: dsharness_auth',
    '        loginPage: true',
    '',
  ].join('\n');
}

/** `package.json` for a generated plugin package. */
function pluginManifest(plugin) {
  return `${JSON.stringify({
    name: plugin.name,
    version: '1.0.0',
    private: true,
    description: plugin.description,
    type: 'module',
    main: './index.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    exports: {
      '.': './index.mjs',
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
 *   own packages (defaults to {@link pluginInstallSpec}).
 * @returns what to obtain and what to select.
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
  return { link, add, install: [...link, ...add], select };
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
  if (options.write === false) return { profile, status: 'planned', ...plan };

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
  return {
    profile,
    status: failures.length === 0 ? 'ok' : 'partial',
    installed: [...installed, ...added.map((entry) => entry.name)],
    refreshed,
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
  const names = new Set([...plugins.map((plugin) => plugin.name), MARKETPLACE_PACKAGE]);
  const removed = [];
  const dependencies = { ...manifest.dependencies };
  for (const plugin of plugins) {
    rmSync(join(profileDir, 'node_modules', plugin.name), { recursive: true, force: true });
    if (Object.hasOwn(dependencies, plugin.name)) {
      delete dependencies[plugin.name];
      removed.push(plugin.name);
    }
  }
  const bundles = (manifest.dsh?.profile?.bundles ?? []).filter((name) => !names.has(name));
  manifest.dependencies = dependencies;
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } };
  writeManifest(profileDir, manifest);
  return { profile, status: 'ok', removed };
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
  for (const report of provisionAll(home, { profiles, withMarketplace, write: !dryRun })) {
    if (report.status === 'skipped') {
      process.stdout.write(`[platform] ${report.profile}: ${report.reason}\n`);
      continue;
    }
    const state = PROFILE_PLUGINS.map(
      (plugin) => `${plugin.name} (${plugin.defaultEnabled === true ? 'on' : 'off'} by default)`,
    ).join(', ');
    if (dryRun) {
      const what = report.install.map((entry) => entry.name).join(', ') || 'nothing';
      process.stdout.write(`[platform] ${report.profile}: ${state}; would install ${what}\n`);
      continue;
    }
    process.stdout.write(
      `[platform] ${report.profile}: ${state}${installedNote(report.installed)}${failNote(report.failures, report.profile)}\n`,
    );
  }
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
