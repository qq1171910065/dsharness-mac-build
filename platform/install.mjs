#!/usr/bin/env node
/**
 * Merge this fork's deployment rows into the machine-level profile patch layer.
 *
 * The home-level cordis.patch.yml is read for EVERY profile -- web, desktop,
 * headless, sdk, acp -- and it ranks ABOVE the per-profile layer
 * (packages/boot/app-boot/src/profile-context.ts#readProfilePatches: bundle
 * layers, then the profile's own patch, then this one, then argv overlays). That
 * is why it is the right home for a deployment-wide override: the Desktop
 * application owns $DSH_HOME/profiles/desktop and rewrites parts of it, but it
 * never touches the home-level file.
 *
 * ## Why this does not use a YAML library
 *
 * The file is a top-level YAML array and the loader applies it **in order, last
 * write wins per row id** (vendor/include/src/index.ts#applyEntryPatches). So a
 * later entry for the same id legitimately overrides an earlier one -- appending
 * is semantically sufficient, and it lets this script avoid depending on a
 * parser that only exists after pnpm install.
 *
 * Everything outside the managed block is preserved **byte for byte**, which
 * matters because the official plugin manager also writes user toggles
 * (- id: <row> / disabled: true) into this same file.
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
    // Keep the user's document intact; our later rows win per row id anyway.
    return [text.trimEnd(), '', managed].join('\n');
  }
  const end = text.indexOf(END, start);
  const after = end < 0 ? '' : text.slice(end + END.length).replace(/^\n+/, '');
  const before = text.slice(0, start);
  return after === '' ? [before, managed].join('') : [before, managed, after].join('\n');
}

function main() {
  const home = resolveDshHome();
  const target = join(home, 'cordis.patch.yml');
  const source = join(here, 'cordis.patch.yml');
  if (!existsSync(source)) throw new Error(`missing ${source}`);

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
