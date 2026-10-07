#!/usr/bin/env node
/**
 * Build this product's Windows installer without editing a single upstream file.
 *
 * `apps/desktop/scripts/package-target.ts` is upstream code, and so is the
 * electron-builder configuration it loads. Both are off limits: the fork's rule
 * is that every owned change lives in `platform/`, so that
 * `git merge upstream/master` can never conflict. This script adds the product's
 * layer to that upstream build from the outside, through documented mechanisms
 * only.
 *
 * ## What it adds, and where it is injected
 *
 * The installer has to carry the deployment layer (`platform/windows/deploy/`,
 * assembled by `platform/build-deploy-payload.mjs`) and run it at install time.
 *
 * - **Configuration.** The upstream packaging script hardcodes
 *   `['exec', 'electron-builder', '--config', 'electron-builder.config.mjs', …]`
 *   (`package-target.ts:269`) and its own parser rejects unknown options, so the
 *   extra `--config` cannot be appended to the packaging command. What every Node
 *   process in the tree does inherit is `NODE_OPTIONS`; `--import` preloads
 *   `windows/nsis-config-hook.mjs`, which rewrites that one argument in the
 *   electron-builder process only.
 * - **The include itself.** `platform/windows/electron-builder-config.mjs` loads
 *   the upstream configuration and replaces exactly one field,
 *   `nsis.include`, with `platform/windows/installer.nsh`. That file `!include`s
 *   the upstream script first — keeping upstream's custom pages, staged extract
 *   and lifecycle hooks — and then adds `.onInstSuccess`, the one stock NSIS
 *   callback upstream defines nowhere.
 *
 * The configuration module is written by electron-builder during the run, so the
 * script stages it in the ignored build directory and removes it again: the
 * repository keeps exactly one copy, under `platform/`.
 *
 * ## Why the flags are guarded
 *
 * This is deliberately not a general-purpose packager: it refuses to build
 * unless it is told `--unsigned`, because that is the only Windows build this
 * product publishes and the only one it can verify locally.
 *
 * ## Why `--registry` exists
 *
 * The prepare stage resolves its own dependency closure, and two of those
 * packages are large optionals. Measured: on a run where `registry.npmjs.org`
 * answered `error (23)` for `@deepseek-ai/libreoffice-kit-win32-x64`, pnpm gave
 * up and `prepare-dsh` failed with `desktop runtime: missing required
 * LibreOffice engine win32-x64` — a message that names the wrong thing, since
 * the engine was simply never downloaded. Pointing the run at a mirror fixed it
 * on the first try, so the mirror is reachable as an option instead of being
 * tribal knowledge.
 *
 * Usage:
 *   node platform/package-windows.mjs --unsigned [--build-version <version>]
 *   node platform/package-windows.mjs --unsigned --registry https://registry.npmmirror.com
 *   node platform/package-windows.mjs --check          # inspect without building
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDeployPayload, DEFAULT_PLATFORM_ORIGIN } from './build-deploy-payload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');
const desktopDir = join(clientDir, 'apps', 'desktop');
const installerScript = join(here, 'windows', 'installer.nsh');
const configSource = join(here, 'windows', 'electron-builder-config.mjs');
const hookModule = join(here, 'windows', 'nsis-config-hook.mjs');

/**
 * Where the substituted configuration is written.
 *
 * It has to live inside the repository (electron-builder resolves the relative
 * `../../apps/desktop/electron-builder.config.mjs` import against its own
 * location, and Node resolves bare imports against the nearest `node_modules`),
 * and inside `apps/desktop` because that is both this target's build root and a
 * path `.gitignore` already covers.
 */
const stagedConfig = join(desktopDir, '.desktop-build', 'nsis-config.mjs');

/**
 * Split this script's own command line into the upstream script's arguments and
 * this script's options.
 * @param argv - arguments after the script entry point.
 * @returns the passthrough arguments, whether to check, the origin to bake, and
 *   the registry to resolve the prepare stage through.
 */
export function parseArguments(argv) {
  const passthrough = [];
  let check = false;
  let origin = DEFAULT_PLATFORM_ORIGIN;
  let registry;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') { check = true; continue; }
    if (argument === '--platform-origin') {
      origin = argv[index + 1];
      if (origin === undefined) throw new Error('package-windows: --platform-origin requires a value');
      index += 1;
      continue;
    }
    if (argument === '--registry') {
      registry = argv[index + 1];
      if (registry === undefined) throw new Error('package-windows: --registry requires a value');
      index += 1;
      continue;
    }
    if (argument === '--unsigned' || argument === '--dir') { passthrough.push(argument); continue; }
    if (argument === '--build-version') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('package-windows: --build-version requires a value');
      passthrough.push(argument, value);
      index += 1;
      continue;
    }
    throw new Error(`package-windows: unknown option ${argument}; expected --unsigned, --dir, --build-version, --platform-origin, --registry or --check`);
  }
  if (!check && !passthrough.includes('--unsigned')) {
    throw new Error('package-windows: this product publishes unsigned Windows builds only; pass --unsigned');
  }
  return { passthrough, check, origin, registry };
}

/**
 * Stage the configuration module next to the build it configures.
 *
 * The staged file re-exports the source by **absolute file URL**. A relative
 * specifier would depend on where the staging directory happens to sit, and the
 * failure mode is a silent one — Node reports the misresolved path, but only
 * after a full prepare run has already happened.
 *
 * @returns the staged path.
 */
export function stageConfig() {
  mkdirSync(dirname(stagedConfig), { recursive: true });
  const source = pathToFileURL(configSource).href;
  writeFileSync(stagedConfig, [
    '// Generated by platform/package-windows.mjs for one build; removed when it finishes.',
    `export * from ${JSON.stringify(source)};`,
    `export { default } from ${JSON.stringify(source)};`,
    '',
  ].join('\n'), 'utf8');
  return stagedConfig;
}

/**
 * The preload every child Node process receives, with the sentinels the hook reads.
 *
 * @param config - absolute path of the staged electron-builder configuration.
 * @param registry - optional npm registry for the prepare stage's own resolution.
 * @returns the environment additions for the packaging child.
 */
export function hookEnvironment(config, registry) {
  return {
    NODE_OPTIONS: `--import ${pathToFileURL(hookModule).href}`,
    DSHARNESS_NSIS_CONFIG_HOOK: '1',
    DSHARNESS_NSIS_CONFIG: config,
    ...registry === undefined ? {} : { npm_config_registry: registry },
  };
}

async function main() {
  const { passthrough, check, origin, registry } = parseArguments(process.argv.slice(2));
  const deploy = buildDeployPayload({ origin, check });
  if (!existsSync(installerScript)) throw new Error(`missing ${installerScript}`);
  if (!existsSync(configSource)) throw new Error(`missing ${configSource}`);
  if (!existsSync(join(deploy, 'deploy-entry.mjs'))) throw new Error(`missing ${join(deploy, 'deploy-entry.mjs')}`);
  const plan = {
    upstream: 'apps/desktop/scripts/package-target.ts (unmodified)',
    configuration: `${configSource} (substituted through NODE_OPTIONS --import)`,
    nsisInclude: installerScript,
    deployEmbedded: deploy,
    platformOrigin: origin,
    registry: registry ?? '(inherited)',
    arguments: passthrough,
  };
  if (check) {
    process.stdout.write(`${JSON.stringify(plan, undefined, 2)}\n`);
    return;
  }
  const config = stageConfig();
  process.stdout.write(`[platform] configuration: ${configSource} (staged at ${config})\n`);
  process.stdout.write(`[platform] NSIS include: ${installerScript}\n`);
  process.stdout.write(`[platform] embedded deploy layer: ${deploy}\n`);
  if (registry !== undefined) process.stdout.write(`[platform] npm registry: ${registry}\n`);

  // The script name already carries win-x64 and --unsigned, so neither is repeated.
  const forwarded = passthrough.filter((argument) => argument !== '--unsigned');
  const args = [
    '--filter', '@deepseek-ai/dsh-desktop', 'run', 'package:win:x64:unsigned',
    ...(forwarded.length === 0 ? [] : ['--', ...forwarded]),
  ];
  let code;
  try {
    const env = { ...process.env, ...hookEnvironment(config, registry) };
    const child = spawn('pnpm', args, { cwd: clientDir, env, stdio: 'inherit', shell: process.platform === 'win32' });
    code = await new Promise((resolvePromise) => child.once('close', resolvePromise));
  } finally {
    rmSync(config, { force: true });
  }
  if (code !== 0) process.exitCode = typeof code === 'number' ? code : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
