/**
 * The preload that points electron-builder at this product's configuration.
 *
 * ## Why a preload instead of a command-line option
 *
 * The upstream packaging script hardcodes the builder command line
 * (`apps/desktop/scripts/package-target.ts:269`), and its own argument parser
 * rejects options it does not declare — so the extra `--config` cannot ride on
 * the packaging script's argv. What every Node process in the packaging tree
 * does inherit is `NODE_OPTIONS`, so `--import` loads this module and the one
 * argument naming the configuration file is rewritten in place.
 *
 * Everything else about the run stays upstream's: the same script computes the
 * release environment, prepares the runtime, packages, smokes the output and
 * writes the release record. Only the configuration module changes, and only in
 * the process that is electron-builder itself.
 *
 * The configuration path arrives in an environment variable rather than as a
 * switch on `--import`: `NODE_OPTIONS` accepts only Node's own options and
 * rejects any other switch outright (`--dsharness-config is not allowed in
 * NODE_OPTIONS`), and the consumer here is this module, which is what reads the
 * variable. `platform/package-windows.mjs` sets the two sentinels; with the
 * enable sentinel absent the module does nothing at all, which is what makes it
 * safe to preload into the hundreds of unrelated Node processes a build starts.
 */

import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Environment variable that switches the hook on, so a stray preload cannot. */
export const ENABLED_ENV = 'DSHARNESS_NSIS_CONFIG_HOOK';

/** Environment variable carrying the absolute path of this product's configuration module. */
export const CONFIG_ENV = 'DSHARNESS_NSIS_CONFIG';

/** The configuration file the upstream packaging script asks for, relative to `apps/desktop`. */
const UPSTREAM_CONFIG = 'electron-builder.config.mjs';

/** The argument spellings that name a configuration file. */
const CONFIG_FLAGS = new Set(['--config', '-c']);

/**
 * Resolve the configuration path from the environment.
 * @param value - the raw value, `file:` URL or path.
 * @returns the absolute path, or undefined when unset.
 */
export function readConfigEnvironment(value) {
  if (value === undefined || value === '') return undefined;
  const path = value.startsWith('file:') ? fileURLToPath(value) : value;
  return isAbsolute(path) ? path : resolve(path);
}

/**
 * Whether one preloaded process is electron-builder's own CLI.
 * @param argv - the preloaded process's `process.argv`.
 * @returns true for `node .../electron-builder/cli.js`.
 */
function isElectronBuilderCli(argv) {
  const entry = argv[1];
  if (entry === undefined) return false;
  const parts = resolve(entry).split(sep);
  return parts[parts.length - 1] === 'cli.js' && parts[parts.length - 2] === 'electron-builder';
}

/**
 * Replace the configuration path in one argument vector.
 *
 * Only the exact upstream name is replaced: a run that already names another
 * configuration keeps it, so the substitution is applied once and cannot fight a
 * later stage.
 *
 * @param argv - the argument vector to rewrite in place.
 * @param config - absolute path of this product's configuration module.
 * @returns whether an argument was replaced.
 */
export function rewriteConfigArgument(argv, config) {
  for (let index = 0; index < argv.length; index += 1) {
    if (!CONFIG_FLAGS.has(argv[index])) continue;
    const value = argv[index + 1];
    if (value === undefined || value !== UPSTREAM_CONFIG) return false;
    argv[index + 1] = config;
    return true;
  }
  return false;
}

if (process.env[ENABLED_ENV] === '1' && isElectronBuilderCli(process.argv)) {
  const config = readConfigEnvironment(process.env[CONFIG_ENV]);
  if (config === undefined) {
    // Loud on purpose: building with upstream's configuration would produce an
    // installer without the deployment layer, which looks like a success.
    process.stderr.write(`[dsharness] electron-builder was started without ${CONFIG_ENV}; the installer would carry no deployment layer\n`);
    process.exitCode = 1;
  } else if (rewriteConfigArgument(process.argv, config)) {
    process.stderr.write(`[dsharness] electron-builder configuration: ${config}\n`);
  } else {
    process.stderr.write(
      `[dsharness] electron-builder does not name ${UPSTREAM_CONFIG}; argv was ${JSON.stringify(process.argv.slice(2))}\n`,
    );
    process.exitCode = 1;
  }
}
