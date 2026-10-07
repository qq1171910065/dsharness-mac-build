#!/usr/bin/env node
/**
 * The deployment layer as the Windows installer runs it.
 *
 * `platform/windows/installer.nsh` copies this directory into the application's
 * own `resources\installer-ui\dsharness` and executes this file with the Node
 * runtime the application ships, passing the install directory as the only
 * argument. It therefore has to run on a machine that has never seen this
 * repository, no npm, and no `pnpm` on `PATH`.
 *
 * ## What it does
 *
 * 1. **Creates the Desktop profile when it is absent.** The application creates
 *    `$DSH_HOME/profiles/desktop` on its first launch
 *    (`apps/desktop/src/project-manager.ts:88`), and `initProfile` never
 *    overwrites an existing file -- so writing the same three files here means
 *    the application's own initialization becomes a no-op instead of a rewrite,
 *    and the plugin packages have a profile to be installed into. Without this
 *    step `provisionProfile` would find no manifest and skip, which is why the
 *    creation is first and not optional.
 * 2. **Applies the same layer a development machine gets** from
 *    `node platform/install.mjs`: the deployment rows in
 *    `<harness home>/cordis.patch.yml`, plus the plugin packages of every
 *    profile under the home. The payload carries `install.mjs` verbatim, so the
 *    two paths cannot drift -- the only thing this file adds is where pnpm comes
 *    from.
 *
 * ## Why the three profile files are written literally
 *
 * The payload runs under plain `node.exe`, not under Electron, so it cannot
 * import `@deepseek-ai/dsh-app-boot` out of `app.asar` (only Electron's patched
 * `fs` reads an asar). {@link PROFILE_BUNDLES}, {@link PROFILE_PATCH_TEMPLATE}
 * and {@link PROFILE_PNPM_WORKSPACE} below are literal copies of what
 * `initProfile` (`packages/boot/app-boot/src/profile.ts:254`) writes, and
 * `platform/deploy-payload.test.mjs` runs the upstream function to prove they
 * still match byte for byte.
 *
 * ## Failure policy
 *
 * Every step is reported, and the exit code is non-zero only when the **rows**
 * could not be written -- that is the part login depends on. A missing registry,
 * an unreachable network, or a plugin package that could not be fetched leaves
 * the application fully installable and usable; the installer prints the exit
 * code into its log.
 *
 * Usage (as the installer runs it):
 *   node.exe deploy-entry.mjs "C:\path\to\install"
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from './home.mjs';
import { installInto } from './install.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The reserved profile the Desktop shell runs; the one this layer must exist for. */
const DESKTOP_PROFILE = 'desktop';

/**
 * The bundles the Desktop shell opens a profile with.
 *
 * Mirrors `PROFILE_TEMPLATES.web` (`packages/boot/app-boot/src/profile.ts:183`),
 * which is what `WEB_PROFILE` in `apps/desktop/src/project-manager.ts:32`
 * resolves to. There is no `desktop` template upstream, so this list is also why
 * the application leaves an existing profile alone.
 */
export const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/** The profile's `cordis.patch.yml`, verbatim from `PROFILE_PATCH_TEMPLATE`. */
export const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;

/** The profile's `pnpm-workspace.yaml`, verbatim from `PROFILE_PNPM_WORKSPACE`. */
export const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

/** Where the application keeps its bundled package manager, relative to the install directory. */
const RUNTIME_PNPM = join('resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs');

/** Where the application keeps the Node runtime, relative to the install directory. */
const RUNTIME_NODE = join('resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');

/**
 * Create the Desktop profile when it is absent, and never touch it otherwise.
 *
 * The three files are exactly what `initProfile` creates, so the application's
 * own initialization on the first launch is a no-op rather than a rewrite of
 * state this layer just wrote.
 *
 * @param home - the Harness home.
 * @returns whether this call created the profile.
 */
export function ensureDesktopProfile(home) {
  const dir = join(home, 'profiles', DESKTOP_PROFILE);
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, 'package.json');
  if (existsSync(manifest)) return false;
  writeFileSync(manifest, `${JSON.stringify({
    name: `dsh-profile-${DESKTOP_PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...PROFILE_BUNDLES] } },
  }, undefined, 2)}\n`);
  writeFileSync(join(dir, 'cordis.patch.yml'), PROFILE_PATCH_TEMPLATE);
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE);
  return true;
}

/**
 * The profiles this layer provisions: the Desktop one, plus whatever else the
 * home already holds.
 *
 * The rows and the plugin packages serve every profile of the home, so an
 * ordinary `dsh web` profile on the same machine is provisioned too -- exactly
 * as `platform/install.mjs` does when a developer runs it.
 *
 * @param home - the Harness home.
 * @returns the profile names, the Desktop one first.
 */
export function profilesUnder(home) {
  const dir = join(home, 'profiles');
  const found = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => entry.name)
    : [];
  return [DESKTOP_PROFILE, ...found.filter((name) => name !== DESKTOP_PROFILE)];
}

/**
 * A pnpm runner built from the application's own Node and package manager.
 *
 * `provision.mjs` looks for pnpm in the repository's `node_modules`, which does
 * not exist on an installed machine, and then on `PATH`, which a fresh Windows
 * account does not have either. Both the interpreter and the entry point ship
 * inside the installation, so this is the runner that always resolves.
 *
 * @param installDir - the application's install directory.
 * @returns a `run(profileDir, args)` for `provisionAll`, or a runner that
 *   reports the missing runtime instead of throwing.
 */
export function runtimePnpm(installDir) {
  const node = existsSync(join(installDir, RUNTIME_NODE)) ? join(installDir, RUNTIME_NODE) : process.execPath;
  const pnpm = join(installDir, RUNTIME_PNPM);
  if (!existsSync(pnpm)) {
    const reason = `missing ${pnpm}`;
    return () => ({ status: 1, output: '', error: reason });
  }
  return (profileDir, args) => {
    const environment = { ...process.env };
    // Inherited from an Electron parent; it would make this Node behave as Electron.
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(node, [pnpm, ...args], { cwd: profileDir, env: environment, encoding: 'utf8' });
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
      error: result.error === undefined ? undefined : String(result.error),
    };
  };
}

/**
 * Apply the whole layer.
 *
 * @param options - `home`, `installDir` and `profiles` override the resolved
 *   ones; `run` injects a fake pnpm runner; `marketplace: false` leaves the
 *   marketplace alone (offline installs, and the specs).
 * @returns a report: the rows file, whether the profile was created, and one
 *   provisioning report per profile.
 */
export function deploy(options = {}) {
  const home = options.home ?? resolveDshHome();
  const installDir = options.installDir ?? process.env.DSHARNESS_INSTALL_DIR;
  if (installDir === undefined || installDir === '') {
    throw new Error('deploy-entry: the install directory is required (pass it as the first argument)');
  }
  const created = ensureDesktopProfile(home);
  const block = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  const run = options.run ?? runtimePnpm(installDir);
  const { target, reports } = installInto(home, block, {
    run,
    profiles: options.profiles ?? profilesUnder(home),
    withMarketplace: options.marketplace !== false,
  });
  return { home, created, target, reports };
}

/** The `platformOrigin` the embedded rows carry, for the diagnostic line. */
function rowsOrigin(block) {
  const match = /platformOrigin:\s*'([^']+)'/u.exec(block);
  return match === null ? 'unknown' : match[1];
}

function main() {
  const installDir = process.argv[2];
  const say = (line) => process.stdout.write(`${line}\n`);
  let result;
  try {
    result = deploy({ installDir });
  } catch (error) {
    say(`[dsharness] deployment layer failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const block = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  say(`[dsharness] harness home: ${result.home}`);
  say(`[dsharness] desktop profile: ${result.created ? 'created' : 'already present, left untouched'}`);
  say(`[dsharness] deployment rows: ${result.target}`);
  say(`[dsharness] account origin: ${rowsOrigin(block)}`);
  for (const report of result.reports) {
    if (report.status === 'skipped') {
      say(`[dsharness] ${report.profile}: ${report.reason}`);
      continue;
    }
    say(`[dsharness] ${report.profile}: ${report.status}`
      + `; installed ${(report.installed ?? []).join(', ') || 'nothing'}`
      + `; selected ${(report.selected ?? []).join(', ') || 'nothing'}`);
    for (const failure of report.failures ?? []) {
      // Not fatal: the plugin card is simply absent, and the message says what to do by hand.
      say(`[dsharness]   NOT installed: ${failure.what} (${failure.reason})`);
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) main();
