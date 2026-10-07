/**
 * Where the Harness home is.
 *
 * Split out so `install.mjs` (the deployment rows) and `provision.mjs` (the
 * plugin packages) resolve it the same way without importing each other.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The same resolution the loader uses: explicit dir, then `DSH_HOME`, then `~/.dsh`.
 *
 * A whitespace-only value counts as unset, which is the rule the rest of the
 * harness applies to environment variables.
 *
 * @param environment - environment to read; defaults to the process one.
 * @returns the absolute Harness home.
 */
export function resolveDshHome(environment = process.env) {
  const explicit = String(environment.DSH_HOME || '').trim();
  return explicit ? resolve(explicit) : join(homedir(), '.dsh');
}
