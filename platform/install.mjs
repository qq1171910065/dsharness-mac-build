#!/usr/bin/env node
/**
 * Merge this fork's deployment rows into the machine-level profile patch layer.
 *
 * ## Which file, and why not the profile's own one
 *
 * Two files can carry deployment rows, and the loader reads both for every
 * profile (`packages/boot/app-boot/src/profile-context.ts#readProfilePatches`):
 * the profile's own `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then
 * `--patch` overlays, then the telemetry patch. The Desktop application boots
 * with `patchFiles: []` (`apps/desktop-host/src/index.ts`), so overlays are not
 * available to a deployment.
 *
 * This writes to the **home-level** file because the profile-level one belongs to
 * the user and to the official plugin manager: `settings` namespaces persist
 * through it (`packages/boot/config-editor`, whose `documentPath` is
 * `profileContext.patchPath`) and the plugin manager appends its enabled/disabled
 * rows there (`packages/boot/plugin-manager`, `writePluginEnabled`). The
 * home-level file is read by every profile -- web, desktop, headless, tui -- and
 * written by nothing in the shipped composition, so a managed block there cannot
 * race the plugin manager or the Settings UI.
 *
 * ## Why the managed block, and why no YAML library
 *
 * The file is a top-level YAML array and the loader applies it **in order, last
 * write wins per row id** (`vendor/include/src/index.ts#applyEntryPatches`), so a
 * later entry for the same id legitimately overrides an earlier one: appending a
 * managed block is semantically sufficient and needs no parser. Everything
 * outside the block is preserved byte for byte -- which matters because that same
 * file is where the Deployment/Environment conventions let an operator write
 * their own rows -- and the block is replaced in place, so running this on every
 * launch cannot grow the file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN = '# >>> dsharness platform rows (managed by platform/install.mjs)';
const END = '# <<< dsharness platform rows';

const here = dirname(fileURLToPath(import.meta.url));

/** The same resolution the loader uses: explicit dir, then DSH_HOME, then ~/.dsh. */
export function resolveDshHome(environment = process.env) {
  const explicit = String(environment.DSH_HOME || '').trim();
  return explicit ? resolve(explicit) : join(homedir(), '.dsh');
}

/**
 * Replace the managed block, or append one when absent.
 *
 * Idempotent: running twice leaves exactly one block. When the begin marker is
 * present but the end marker is missing (a hand-edited or truncated file), the
 * block is treated as running to the end and rewritten -- never duplicated.
 *
 * @param existing - current file contents (empty string when the file is absent).
 * @param block - rows to manage, already rendered as YAML text.
 * @returns the merged file contents, ending with exactly one newline.
 */
export function mergeManagedBlock(existing, block) {
  const text = String(existing ?? '');
  const body = String(block ?? '').trimEnd();
  const managed = [BEGIN, body, END, ''].join('\n');
  const start = text.indexOf(BEGIN);
  if (start < 0) {
    if (text.trim() === '') return managed;
    // Keep the operator's rows intact; our later rows win per row id anyway.
    return [text.trimEnd(), '', managed].join('\n');
  }
  const end = text.indexOf(END, start);
  const after = end < 0 ? '' : text.slice(end + END.length).replace(/^\n+/, '');
  return after === '' ? [text.slice(0, start), managed].join('') : [text.slice(0, start), managed, after].join('\n');
}

function main() {
  const source = join(here, 'cordis.patch.yml');
  if (!existsSync(source)) throw new Error(`missing ${source}`);
  const target = join(resolveDshHome(), 'cordis.patch.yml');

  const block = readFileSync(source, 'utf8');
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const merged = mergeManagedBlock(existing, block);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, merged, 'utf8');

  const origin = String(process.env.DSH_PLATFORM_ORIGIN || '').trim() || 'http://127.0.0.1:13090';
  process.stdout.write(
    [
      `[platform] wrote ${target}`,
      '[platform] managed rows: deepseek-account',
      `[platform] account origin: ${origin}`,
      '',
    ].join('\n')
  );
}

// Only run when invoked directly; the exports above exist for the spec.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
