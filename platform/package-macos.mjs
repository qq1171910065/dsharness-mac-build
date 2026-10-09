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
 * paid Apple Developer account.
 *
 * ## Known blocker: `prepare:dsh` signs the runtime on every macOS build
 *
 * Preparation still terminates at Apple, so this script does not complete on a
 * runner without an Apple-issued certificate.
 * `apps/desktop/scripts/prepare-dsh.ts:156` guards its two signing stages with
 * `process.platform === 'darwin'` alone — not with any signing switch — so every
 * macOS build signs the whole materialized runtime and then verifies it:
 *
 * - `signMacOSRuntime` (`macos-runtime.ts:31`) reaches `signMacOSRuntimeCode`
 *   (`verify-macos-signature.mjs:117`), which requires `CSC_KEYCHAIN` (`:119`)
 *   and signs with `--sign <identity> --timestamp` (`:122-125`).
 * - Verification then runs on every file (`macos-runtime.ts:57`), and
 *   `assertMacOSRuntimeSignatureDetails` requires all of
 *   `Authority=Developer ID Application: <name>` (`:16`),
 *   `TeamIdentifier=<id>` (`:17`) and `Timestamp=<secure timestamp>` (`:33`).
 *
 * Upstream has no unsigned macOS route: `signPrimaryRuntime`
 * (`package-target.ts:421`) is `platform === 'win32'`, so the
 * `sign:primary-runtime` step that would create the keychain never runs for a
 * mac target. `prepare-dsh.ts` is an upstream file this fork does not modify.
 *
 * A self-signed certificate was tried and is **not** a workaround. It can
 * satisfy the first field by setting the CN to
 * `Developer ID Application: <name>`, but the other two are properties of an
 * Apple-issued certificate that nothing local can forge:
 *
 * - `TeamIdentifier` comes from Apple's team assignment, not from a certificate
 *   field a self-signed issuer controls.
 * - `Timestamp` is a secure timestamp from Apple's timestamp authority, which
 *   only countersigns genuine Developer ID signatures. `--timestamp=none` makes
 *   `codesign` succeed but leaves the field absent, so verification fails
 *   immediately afterwards.
 *
 * So the only path to a macOS artifact is a real `Developer ID Application`
 * certificate in `CSC_LINK` with `CSC_KEY_PASSWORD` — which also makes the
 * result properly signed. `platform/macos/self-signed-identity.sh` is kept
 * because it is still the shortest way to produce the keychain-shaped
 * environment for local experiments, but it does not unblock the build.
 *
 * @example
 *   node platform/package-macos.mjs --arm64
 *   node platform/package-macos.mjs --arm64 --check   # print the plan, build nothing
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { desktopTargetBuildPaths } from '../apps/desktop/scripts/desktop-build-paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');
const desktopDir = join(clientDir, 'apps', 'desktop');

/**
 * The desktop package, relative to the workspace root.
 *
 * Used as a `pnpm --dir` argument rather than an absolute path so the command
 * lines printed in the plan stay readable and portable.
 */
const desktopPackageDir = 'apps/desktop';

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
 * Preparation, in upstream's exact order (`package-target.ts:450-474`).
 *
 * Every step here produces something the application needs, and the order is not
 * interchangeable: the workspace has to be built before it can be packed, the
 * packs have to exist before the runtime can install them, and the runtime has
 * to be staged before electron-builder copies it into the bundle.
 *
 * Two upstream steps are intentionally absent:
 *
 * - `sign:primary-runtime` (twice, `:471`/`:474`) signs the primary runtime for
 *   a signed release. This build signs nothing, so those are skipped; the
 *   corresponding `--defer-primary-runtime-smoke` / `--defer-runtime-smoke`
 *   flags exist to defer a smoke check until after signing, and are therefore
 *   not passed either.
 * - `preflight:windows-signing` (`:445`) is inside a `signPrimaryRuntime` guard.
 *
 * `prepare:primary-runtime` is *not* listed: it is a sub-step of
 * `prepare:runtime` (`apps/desktop/scripts/prepare-runtime.ts:63`), and invoking
 * it directly fails because it requires `--target` and `--output`
 * (`scripts/primary-runtime/prepare.ts:197`).
 *
 * The last three steps are the desktop package's own scripts, not the
 * workspace's, so each is prefixed with `--dir apps/desktop`. Upstream reaches
 * them the same way — `execute()` runs with `cwd` set to `apps/desktop`
 * (`package-target.ts:42`) — and running them from the workspace root fails with
 * `ERR_PNPM_NO_SCRIPT: Missing script: prepare:runtime`, which is what CI
 * reported. `build:official` and `release:pack` really are root scripts, so they
 * stay unprefixed.
 *
 * @param buildPaths - this target's build directories.
 * @returns the preparation commands, in order.
 */
function preparationSteps(buildPaths) {
  const pack = (family, out) => ['run', 'release:pack', '--family', family, '--out', out];
  const packWorkspace = (dir, destination) => ['--dir', dir, 'pack', '--pack-destination', destination];
  const desktop = (...args) => ['--dir', desktopPackageDir, ...args];
  return [
    ['run', 'build:official'],
    pack('dsh', buildPaths.packedDsh),
    packWorkspace('apps/desktop-host', buildPaths.packedDsh),
    pack('vendor', buildPaths.packedVendor),
    ['--dir', 'native/system', 'run', 'build:ts'],
    packWorkspace('native/system/packages/entry', buildPaths.packedLandlock),
    desktop('run', 'prepare:runtime'),
    desktop('run', 'prepare:packages'),
    desktop('run', 'prepare:dsh'),
  ];
}

/**
 * Read `apps/desktop/.env.macos` through upstream's own loader.
 *
 * The configuration module is evaluated by electron-builder in its own process,
 * where it calls `createElectronBuilderConfig()` with no arguments
 * (`apps/desktop/electron-builder.config.mjs`), so it reads `process.env` and
 * never consults the dotenv file itself. Something has to put those settings
 * into the environment first, and `loadDesktopPackageEnvironment` is the
 * supported way: it also enforces the file's allowlist, so an unsupported
 * setting fails here rather than mid-build.
 *
 * @returns the release environment, with ambient release settings filtered out.
 */
async function loadReleaseEnvironment() {
  const module = await import(pathToFileURL(join(desktopDir, 'scripts', 'desktop-package-environment.mjs')).href);
  try {
    return module.loadDesktopPackageEnvironment('darwin', process.env, desktopDir);
  } catch (error) {
    throw new Error(`package-macos: ${error.message}`);
  }
}

/**
 * Resolve this product's configuration after the release environment is in place.
 *
 * The configuration module must be **imported dynamically and only after**
 * `loadReleaseEnvironment` has run. It publishes a default export, so importing
 * it evaluates `createUnsignedMacOSConfig()` — and therefore the whole upstream
 * release environment — at module load. A static import at the top of this file
 * would run before `main()` can do anything, and fail with
 * `DSH_DESKTOP_APP_ID must be set to a non-empty value`. That is exactly how the
 * configuration check failed in CI, so the ordering is pinned by a test.
 *
 * The placeholders are applied here rather than by the caller so both the
 * validation path and the build path get the same environment.
 *
 * @param targetArch - architecture being packaged.
 * @param releaseEnvironment - file-owned release settings.
 * @returns upstream's configuration, with signing and notarization disabled.
 */
async function resolveConfiguration(targetArch, releaseEnvironment) {
  Object.assign(process.env, releaseEnvironment, {
    // The configuration selects its platform from this pair
    // (`electron-builder-config.mjs:55-57`), and the arch it must package is not
    // necessarily this host's.
    DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
    DSH_DESKTOP_TARGET_ARCH: targetArch,
  });
  const module = await import(pathToFileURL(configSource).href);
  Object.assign(process.env, module.PLACEHOLDER_SIGNING);
  return module;
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
 * Assert a configuration cannot sign or notarize.
 *
 * Exported so the standalone preflight (`check-macos-config.mjs`) enforces the
 * same fields through the same code, rather than restating them.
 *
 * `dmg.sign` is checked alongside the `mac` fields because it is a separate
 * switch upstream: leaving it true fails the disk-image step after the
 * application has already been built correctly.
 *
 * @param config - a resolved electron-builder configuration.
 * @returns void; throws when the configuration would contact Apple.
 */
export function assertUnsigned(config) {
  if (config.mac?.identity !== null) throw new Error('package-macos: mac.identity must be null');
  if (config.mac?.forceCodeSigning !== false) throw new Error('package-macos: mac.forceCodeSigning must be false');
  if (config.mac?.notarize !== false) throw new Error('package-macos: mac.notarize must be false');
  if (config.dmg?.sign !== false) throw new Error('package-macos: dmg.sign must be false');
}

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
  const buildPaths = desktopTargetBuildPaths(`mac-${arch}`);
  const preparation = preparationSteps(buildPaths);
  const plan = {
    upstream: 'apps/desktop/scripts/package-target.ts (NOT used: every mac path there signs or notarizes)',
    preparation: preparation.map((args) => args.join(' ')),
    builder: `electron-builder --config ${stagedConfig} --mac --${arch}`,
    configuration: `${configSource} (substituted through NODE_OPTIONS --import)`,
    applicationSigning: 'disabled (identity: null, forceCodeSigning: false, notarize: false, dmg.sign: false)',
    runtimeSigning: 'required by prepare:dsh on darwin; uses CSC_LINK/CSC_KEY_PASSWORD through upstream withMacOSSigningKeychain',
    output: buildPaths.unsignedArtifacts,
  };
  // Resolved before the plan is printed and before `--check` returns: the
  // configuration evaluates its whole release environment when it is imported,
  // so a `--check` that returned first would report a plan it never validated.
  const releaseEnvironment = await loadReleaseEnvironment();
  const configuration = await resolveConfiguration(arch, releaseEnvironment);
  if (check) {
    // Importing the configuration is the check: it throws on any missing or
    // malformed release setting, which is the failure this step exists to catch.
    assertUnsigned(configuration.createUnsignedMacOSConfig());
    process.stdout.write(`${JSON.stringify({ ...plan, validated: 'configuration resolves with signing disabled' }, undefined, 2)}\n`);
    return;
  }
  for (const [line, value] of Object.entries(plan)) process.stdout.write(`[platform] ${line}: ${value}\n`);

  const config = stageConfig();
  const baseEnv = { ...process.env, ...hookEnvironment(config) };
  // Preparation signs the materialized runtime on every macOS build whether or
  // not the application will be signed (`prepare-dsh.ts:156`), and that needs
  // `CSC_KEYCHAIN` plus a `DSH_DESKTOP_MACOS_SIGNING_PROBE` signed by the same
  // certificate. Upstream's own helper builds both from `CSC_LINK` /
  // `CSC_KEY_PASSWORD` (`macos-signing-keychain.mjs:48`), so it is reused here
  // rather than reimplemented; `package-target.ts:369` wraps its mac work in it
  // for the same reason. It deletes `CSC_LINK`/`CSC_KEY_PASSWORD` from the child
  // environment, leaving only the keychain path.
  const signing = releaseEnvironment.CSC_LINK === undefined || releaseEnvironment.CSC_KEY_PASSWORD === undefined
    ? undefined
    : await import(pathToFileURL(join(desktopDir, 'scripts', 'macos-signing-keychain.mjs')).href);
  const withSigningKeychain = async (action) => {
    if (signing === undefined) {
      throw new Error('package-macos: CSC_LINK and CSC_KEY_PASSWORD are required; preparation signs the macOS runtime even though this configuration disables signing');
    }
    // A real certificate is required here, not merely a syntactically valid
    // one: the verification below demands an Apple-issued team and timestamp
    // (see the header). A self-signed p12 gets past `codesign` and then fails
    // verification, which is the difference between this failing in seconds and
    // failing after preparation has already built everything.
    return signing.withMacOSSigningKeychain(releaseEnvironment, async (signingEnvironment) => action({ ...baseEnv, ...signingEnvironment }));
  };
  let code = 0;
  try {
    // Upstream resets the landlock output before packing it
    // (`package-target.ts:460-461`); `git pack --pack-destination` does not
    // create its destination itself.
    rmSync(buildPaths.packedLandlock, { recursive: true, force: true });
    mkdirSync(buildPaths.packedLandlock, { recursive: true });
    await withSigningKeychain(async (env) => {
      for (const args of preparation) {
        code = await run('pnpm', args, env);
        if (code !== 0) throw new Error(`package-macos: ${args.join(' ')} failed with ${code}`);
      }
    });
    // electron-builder runs outside the helper: this configuration signs nothing
    // (`identity: null`, `forceCodeSigning: false`, `notarize: false`,
    // `dmg.sign: false`), so it must not inherit a keychain to sign with.
    code = await run('pnpm', [
      'exec', 'electron-builder',
      '--config', config,
      '--mac', `--${arch}`,
      '--publish', 'never',
      '--config.directories.output', buildPaths.unsignedArtifacts,
    ], baseEnv);
  } finally {
    rmSync(config, { force: true });
  }
  if (code !== 0) {
    process.exitCode = typeof code === 'number' ? code : 1;
    return;
  }
  process.stdout.write(`[platform] application: ${buildPaths.unsignedArtifacts}\n`);
  process.stdout.write('[platform] WARNING: unsigned and not notarized; Gatekeeper will refuse this build on another machine\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
