#!/usr/bin/env node
/**
 * Publish the macOS packaging workflow to a GitHub repository that can run it.
 *
 * `platform/macos/workflow.yml` is the source of truth, but GitHub Actions reads
 * workflows only from `<repo>/.github/workflows/`. Committing the file there would
 * break the fork's core invariant, checked by `platform/verify-fork-update.mjs`
 * (`owned changes live under platform/`): an owned file outside `platform/` risks
 * colliding with upstream, and `upstream/.github/workflows/` is a busy directory.
 *
 * So the workflow is stored under `platform/` and mirrored into
 * `.github/workflows/macos-build.yml` only in the publication repository, which
 * holds this fork's `client/` tree and nothing from upstream.
 *
 * The commit is built with a temporary index (`GIT_INDEX_FILE`), so the working
 * tree and the current branch are never modified.
 *
 * `--check` compares the mirror against the source and exits non-zero when they
 * differ, so drift is caught before a build runs a stale workflow.
 *
 * Usage:
 *   node platform/publish-macos-workflow.mjs                 # mirror, then push
 *   node platform/publish-macos-workflow.mjs --check         # report drift only
 *   node platform/publish-macos-workflow.mjs --remote ghbuild
 *   node platform/publish-macos-workflow.mjs --dry-run       # build the commit, do not push
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const source = join(here, 'macos', 'workflow.yml');
/** Published location inside the build repository. */
const MIRROR = '.github/workflows/macos-build.yml';

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const dryRun = argv.includes('--dry-run');
const remoteIndex = argv.indexOf('--remote');
const remote = remoteIndex === -1 ? 'ghbuild' : argv[remoteIndex + 1];

/**
 * Run git in the fork and return trimmed stdout.
 * @param {...string} args Git arguments.
 * @returns {string} Standard output without the trailing newline.
 */
function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

const normalize = (text) => text.replace(/\r\n/gu, '\n');
const workflow = normalize(readFileSync(source, 'utf8'));

/**
 * Read a file out of the remote branch without `git show`.
 *
 * `git show` output is a blob followed by no delimiter, so any `.trim()` applied
 * to make it comparable also strips the file's own trailing newline -- which made
 * this comparison report drift for byte-identical files. Hashing the blob avoids
 * the question entirely: `hash-object` on the normalized bytes gives the blob id
 * that the published file must have.
 * @param {string} spec Git revision and path, such as `ghbuild/main:path/to/file`.
 * @returns {string} The normalized file content, or an empty string when absent.
 */
function readRemote(spec) {
  const raw = execFileSync('git', ['show', spec], { cwd: repo, encoding: 'utf8' });
  return normalize(raw);
}

/** The blob id git would store for the workflow, newline included. */
function blobId(text) {
  // `--stdin` hashes exactly these bytes, so the trailing newline is significant
  // and no trimming happens anywhere in the comparison.
  return execFileSync('git', ['hash-object', '-t', 'blob', '--stdin'], {
    cwd: repo,
    encoding: 'utf8',
    input: text,
  }).trim();
}

const wanted = blobId(workflow);
let found = '';
try {
  found = blobId(readRemote(`${remote}/main:${MIRROR}`));
}
catch {
  // Absent in the remote: the first publication, not an error.
  found = '';
}

if (found === wanted) {
  process.stdout.write(`[publish-macos-workflow] ${remote}/main already matches platform/macos/workflow.yml (blob ${wanted.slice(0, 10)})\n`);
  process.exit(0);
}
if (checkOnly) {
  process.stderr.write(`[publish-macos-workflow] ${remote}/main:${MIRROR} differs from platform/macos/workflow.yml; re-run without --check\n`);
  process.exit(1);
}

// Build the commit through a temporary index. The workflow is written to the real
// path only because git needs a worktree file to hash; the file is removed again
// before this script returns, and no branch or stash is touched.
const mirrorPath = join(repo, MIRROR);
mkdirSync(dirname(mirrorPath), { recursive: true });
const previous = (() => {
  try {
    return readFileSync(mirrorPath, 'utf8');
  }
  catch {
    // Absent locally: nothing to restore.
    return null;
  }
})();
writeFileSync(mirrorPath, workflow, 'utf8');

const indexPath = join(mkdtempSync(join(tmpdir(), 'dsh-publish-')), 'index');
const gitWithIndex = (...args) => execFileSync('git', args, {
  cwd: repo,
  encoding: 'utf8',
  env: { ...process.env, GIT_INDEX_FILE: indexPath },
}).trim();

let pushed = false;
try {
  const base = git('rev-parse', `${remote}/main`);
  gitWithIndex('read-tree', base);
  gitWithIndex('add', '--force', MIRROR);
  const tree = gitWithIndex('write-tree');
  const commit = execFileSync('git', [
    'commit-tree', tree, '-p', base,
    '-m', 'ci: publish the macOS build workflow',
  ], { cwd: repo, encoding: 'utf8' }).trim();
  process.stdout.write(`[publish-macos-workflow] prepared ${commit.slice(0, 10)} (mirrors platform/macos/workflow.yml)\n`);
  if (!dryRun) {
    execFileSync('git', ['push', remote, `${commit}:main`, '--no-progress'], { cwd: repo, stdio: 'inherit' });
    pushed = true;
    process.stdout.write(`[publish-macos-workflow] pushed to ${remote}/main\n`);
  }
}
finally {
  rmSync(indexPath, { force: true });
  if (previous === null) rmSync(mirrorPath, { force: true });
  else writeFileSync(mirrorPath, previous, 'utf8');
}

if (dryRun && !pushed) {
  process.stdout.write('[publish-macos-workflow] --dry-run: nothing pushed\n');
}
