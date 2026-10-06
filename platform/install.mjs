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
 * later entry for the same row id legitimately overrides an earlier one: appending
 * a managed block is semantically sufficient and needs no parser. Everything
 * outside the block is preserved byte for byte -- which matters because that same
 * file is where the Deployment/Environment conventions let an operator write
 * their own rows -- and the block is replaced in place, so running this on every
 * launch cannot grow the file.
 *
 * ## Why the plugin file is copied beside the patch
 *
 * A row's relative `name` resolves **relative to the patch file that declares it**
 * (`packages/boot/app-boot/src/index.ts#anchorInsertedPluginNames` rewrites it
 * against the patch's own directory), and the loader is handed the copy in
 * `$DSH_HOME`. So the plugin the row mounts has to exist **next to that copy**,
 * not next to this script. Copying keeps the row and its code on one path: the
 * two can never disagree about where the plugin is, and a `--patch` overlay
 * elsewhere cannot silently orphan the row.
 *
 * The copy is byte-identical to the source; the source stays the single place to
 * edit. Stale copies cannot accumulate -- the target name is fixed, so a rerun
 * overwrites it, and `remove` deletes it.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN = '# >>> dsharness platform rows (managed by platform/install.mjs)';
const END = '# <<< dsharness platform rows';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Fork-owned plugin files the managed rows mount, as `source -> installed name`.
 *
 * The installed name is what the patch row references (`name: ./<installed>`),
 * and the `dsharness-` prefix marks everything this fork owns inside `$DSH_HOME`,
 * so a human (or a later cleanup) can tell our files from the loader's own.
 */
export const PLUGIN_FILES = [
  ['host-auth.mjs', 'dsharness-host-auth.mjs'],
];

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

/**
 * Copy every fork-owned plugin to the home directory and merge the rows.
 *
 * @param home - Harness home receiving the patch file and plugin copies.
 * @param block - rendered rows.
 * @returns the installed plugin file names, in copy order.
 */
export function installInto(home, block) {
  const target = join(home, 'cordis.patch.yml');
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
  mkdirSync(home, { recursive: true });
  const installed = [];
  for (const [source, installedName] of PLUGIN_FILES) {
    const from = join(here, source);
    if (!existsSync(from)) throw new Error(`missing ${from}`);
    copyFileSync(from, join(home, installedName));
    installed.push(installedName);
  }
  writeFileSync(target, mergeManagedBlock(existing, block), 'utf8');
  return { target, installed };
}

/** Remove the managed block and the plugin copies this script owns. */
export function removeFrom(home) {
  const target = join(home, 'cordis.patch.yml');
  if (existsSync(target)) {
    const text = readFileSync(target, 'utf8');
    const start = text.indexOf(BEGIN);
    if (start >= 0) {
      const end = text.indexOf(END, start);
      const after = end < 0 ? '' : text.slice(end + END.length).replace(/^\n+/, '');
      const head = text.slice(0, start).trimEnd();
      writeFileSync(target, head === '' && after === '' ? '' : [head, after].filter(Boolean).join('\n') + '\n', 'utf8');
    }
  }
  for (const [, installedName] of PLUGIN_FILES) rmSync(join(home, installedName), { force: true });
  return target;
}

function main() {
  const source = join(here, 'cordis.patch.yml');
  if (!existsSync(source)) throw new Error(`missing ${source}`);
  const home = resolveDshHome();
  const block = readFileSync(source, 'utf8');

  if (process.argv.includes('--remove')) {
    const target = removeFrom(home);
    process.stdout.write(`[platform] removed managed rows from ${target}\n`);
    return;
  }

  const { target, installed } = installInto(home, block);

  const origin = String(process.env.DSH_PLATFORM_ORIGIN || '').trim() || 'http://127.0.0.1:13090';
  const token = String(process.env.DSH_AUTH_TOKEN || '').trim();
  process.stdout.write(
    [
      `[platform] wrote ${target}`,
      '[platform] managed rows: deepseek-account, dsharness-host-auth',
      `[platform] installed plugins: ${installed.join(', ')}`,
      `[platform] account origin: ${origin}`,
      // Never print the secret itself, only whether one is present.
      `[platform] host auth token: ${token.length >= 16 ? `configured (${token.length} chars)` : 'NOT configured (Set DSH_AUTH_TOKEN to enable)'}`,
      '',
    ].join('\n')
  );
}

// Only run when invoked directly; the exports above exist for the spec.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
