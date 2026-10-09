/**
 * Build this product's macOS application without Apple credentials.
 *
 * ## Why this does not go through `apps/desktop/scripts/package-target.ts`
 *
 * That script is upstream's only macOS entry point, and every path through it
 * ends at Apple. It resolves notary credentials before electron-builder starts
 * (`desktop-package-environment.mjs:105-108` requires a readable `CSC_LINK`
 * p12), and afterwards both mac routes notarize unconditionally:
 * `packageMacOSArtifacts` for a release build, and `notarizeMacOS`
 * (`package-target.ts:488,494`) for the unpacked one. The one early return that
 * would avoid both, `--prepare-only` (`:475`), happens *before* electron-builder
 * runs, so it produces no application at all.
 *
 * There is no `--unsigned` for macOS either: `parseDesktopPackageInvocation`
 * rejects it for any target but `win-x64` (`:237`), and the configuration
 * asserts the same rule independently (`electron-builder-config.mjs:62`).
 *
 * ## What this script does instead
 *
 * It runs the same preparation stages upstream's mac route runs — in the same
 * order, from the same scripts — and then invokes electron-builder directly
 * with this product's configuration (`./electron-builder-config.mjs`), which
 * disables signing and notarization. electron-builder itself is never asked to
 * sign, so nothing reaches Apple.
 *
 * This is the same substitution the Windows entry point performs
 * (`../package-windows.mjs`): upstream owns preparation, and only the
 * configuration module changes.
 *
 * ## This is a development build
 *
 * The output is unsigned and un-notarized. It runs on the machine that built it
 * once Gatekeeper is satisfied (right-click → Open, or `xattr -dr
 * com.apple.quarantine`). A downloaded copy on another machine is refused by
 * Gatekeeper, and there is no supported way to hand it to a user: that needs a
 * paid Apple Developer account. `.env.macos` is still required, and so are
 * placeholder signing settings, because the preparation stages validate the
 * release environment whether or not the result will be signed.
 *
 * @example
 *   node platform/package-macos.mjs --arm64
 *   node platform/package-macos.mjs --arm64 --check   # print the plan, build nothing
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');
const desktopDir = join(clientDir, 'apps', 'desktop');

/** The fork's electron-builder configuration, with signing and notarization off. */
const configSource = join(here, 'macos', 'electron-builder-config.mjs');

/** The generic configuration-substitution preload, shared with the Windows entry point. */
const hookModule = join(here, 'windows', 'nsis-config-hook.mjs');

/**
 * Where the staged configuration is written.
 *
 * It goes under the build directory because electron-builder resolves `--config`
 * against its own working directory, and the staged module re-exports the source
 * by absolute file URL.
 */
const stagedConfig = join(desktopDir, '.desktop-build', 'macos-config.mjs');

/**
 * Preparation stages, in upstream's order (`package-target.ts:468-474`).
 *
 * The two `sign:primary-runtime` steps upstream interleaves are omitted: they
 * exist to sign the primary runtime for a signed release, and this build signs
 * nothing. Everything that produces the runtime and the packaged `dsh` is kept,
 * because the application is not runnable without it.
 */
const PREPARATION = [
  ['run', 'prepare:primary-runtime'],
  ['run', 'prepare:runtime'],
  ['run', 'prepare:packages'],
  ['run', 'prepare:dsh'],
];

/**
 * Placeholder values for the signing settings the release environment insists on.
 *
 * These are deliberately not real credentials. They satisfy the presence and
 * format checks in `desktop-release-environment.mjs` so the preparation stages
 * run; they are never used to sign anything because the configuration this
 * script passes sets `identity: null`, `forceCodeSigning: false` and
 * `notarize: false`. If that stops being true the build fails at the first
 * signing attempt rather than silently producing a bundle with a false identity.
 */
const PLACEHOLDER_SIGNING = {
  DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'DSH Desktop development build',
  DSH_DESKTOP_MACOS_TEAM_ID: '0000000000',
};

/**
 * Parse this script's own arguments.
 * @param argv - arguments after the script name.
 * @returns the selected architecture and whether to only print the plan.
 */
export function parseArguments(argv) {
  const arm64 = argv.includes('--arm64');
  const x64 = argv.includes('--x64');
  if (arm64 && x64) throw new Error('package-macos: --arm64 and --x64 are mutually exclusive');
  if (!arm64 && !x64) throw new Error('package-macos: pass --arm64 or --x64');
  return { arch: arm64 ? 'arm64' : 'x64', check: argv.includes('--check') };
}

/**
 * Stage the configuration module next to the build it configures.
 *
 * The staged file re-exports the source by **absolute file URL**; a relative
 * specifier would depend on where the staging directory sits, and the failure
 * mode is silent.
 *
 * @returns the staged path.
 */
export function stageConfig() {
  mkdirSync(dirname(stagedConfig), { recursive: true });
  const source = pathToFileURL(configSource).href;
  writeFileSync(stagedConfig, [
    '// Generated by platform/package-macos.mjs for one build; removed when it finishes.',
    `export * from ${JSON.stringify(source)};`,
    `export { default } from ${JSON.stringify(source)};`,
    '',
  ].join('\n'), 'utf8');
  return stagedConfig;
}

/**
 * The preload every child Node process receives, with the sentinels the hook reads.
 * @param config - absolute path of the staged electron-builder configuration.
 * @returns the environment additions for the packaging child.
 */
export function hookEnvironment(config) {
  return {
    NODE_OPTIONS: `--import ${pathToFileURL(hookModule).href}`,
    DSHARNESS_NSIS_CONFIG_HOOK: '1',
    DSHARNESS_NSIS_CONFIG: config,
  };
}

/**
 * Run one command in the client workspace, inheriting stdio.
 * @param command - executable to spawn.
 * @param args - its arguments.
 * @param env - environment for the child.
 * @returns the exit code.
 */
function run(command, args, env) {
  const child = spawn(command, args, { cwd: clientDir, env, stdio: 'inherit', shell: process.platform === 'win32' });
  return new Promise((resolvePromise) => child.once('close', resolvePromise));
}

async function main() {
  const { arch, check } = parseArguments(process.argv.slice(2));
  if (process.platform !== 'darwin') {
    throw new Error(`package-macos: macOS packaging requires a macOS build host (this is ${process.platform})`);
  }
  if (!existsSync(configSource)) throw new Error(`missing ${configSource}`);
  const envFile = join(desktopDir, '.env.macos');
  if (!existsSync(envFile)) {
    throw new Error(`package-macos: missing ${envFile}; copy .env.macos.example and fill in the local settings`);
  }
  const outputRoot = join(desktopDir, '.desktop-build', 'targets', `mac-${arch}`, 'unsigned-artifacts');
  const plan = {
    upstream: 'apps/desktop/scripts/package-target.ts (NOT used: every mac path there signs or notarizes)',
    preparation: PREPARATION.map((args) => args.join(' ')),
    builder: `electron-builder --config ${stagedConfig} --mac --${arch}`,
    configuration: `${configSource} (substituted through NODE_OPTIONS --import)`,
    signing: 'disabled (identity: null, forceCodeSigning: false, notarize: false)',
    output: outputRoot,
  };
  if (check) {
    process.stdout.write(`${JSON.stringify(plan, undefined, 2)}\n`);
    return;
  }
  for (const [line, value] of Object.entries(plan)) process.stdout.write(`[platform] ${line}: ${value}\n`);

  const config = stageConfig();
  const env = { ...process.env, ...PLACEHOLDER_SIGNING, ...hookEnvironment(config) };
  let code = 0;
  try {
    for (const args of PREPARATION) {
      code = await run('pnpm', args, env);
      if (code !== 0) throw new Error(`package-macos: ${args.join(' ')} failed with ${code}`);
    }
    code = await run('pnpm', [
      'exec', 'electron-builder',
      '--config', config,
      '--mac', `--${arch}`,
      '--publish', 'never',
      '--config.directories.output', outputRoot,
    ], env);
  } finally {
    rmSync(config, { force: true });
  }
  if (code !== 0) {
    process.exitCode = typeof code === 'number' ? code : 1;
    return;
  }
  process.stdout.write(`[platform] application: ${outputRoot}\n`);
  process.stdout.write('[platform] WARNING: unsigned and not notarized; Gatekeeper will refuse this build on another machine\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
