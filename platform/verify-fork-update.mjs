#!/usr/bin/env node
/**
 * Prove this fork can still take upstream updates.
 *
 * The fork's whole value is that following upstream stays a plain
 * `git fetch upstream && git merge upstream/master`, and that the merge can never
 * conflict because every owned change lives in `platform/`, a directory upstream
 * does not have. That property is worth checking mechanically rather than
 * trusting it: an accidental edit to an upstream file would not break anything
 * today, only the *next* upstream release.
 *
 * Checks, in order:
 *
 * 1. `upstream` exists and points at the official repository;
 * 2. the working tree is clean (a merge on top of uncommitted work is not the
 *    thing being verified);
 * 3. **no owned change touches a file upstream tracks** -- the exact property
 *    that keeps the merge conflict-free;
 * 4. a real merge of `upstream/master` into the current HEAD succeeds. When
 *    upstream has no new commits this is a no-op; when it does, this is the
 *    actual update.
 *
 * Refuses to run with a dirty worktree, and restores the original HEAD on every
 * exit path, so it is safe to run at any time.
 *
 * Usage:
 *   node platform/verify-fork-update.mjs            # fetch if needed, then check
 *   node platform/verify-fork-update.mjs --no-fetch # offline: use the local ref
 *   node platform/verify-fork-update.mjs --strict   # also require upstream to be current
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const OFFICIAL = 'https://github.com/deepseek-ai/deepseek-harness.git';

const argv = process.argv.slice(2);
const fetchFirst = !argv.includes('--no-fetch');
const strict = argv.includes('--strict');

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}
function tryGit(...args) {
  try { return { ok: true, out: git(...args) }; } catch (error) {
    return { ok: false, out: String(error.stderr ?? error.message) };
  }
}

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}`);
};

/* 1. the remote */
const upstreamUrl = tryGit('remote', 'get-url', 'upstream');
check('upstream remote exists', upstreamUrl.ok);
if (!upstreamUrl.ok) {
  console.log('\nFix: git remote add upstream ' + OFFICIAL);
  process.exit(1);
}
check('upstream points at the official repository', upstreamUrl.out === OFFICIAL, upstreamUrl.out);

/* 2. clean worktree */
const dirty = git('status', '--porcelain');
const modifiedTracked = dirty === ''
  ? []
  : dirty.split('\n').filter((line) => !line.startsWith('?? '));
const untracked = dirty === ''
  ? []
  : dirty.split('\n').filter((line) => line.startsWith('?? '));
check('no uncommitted edits to tracked files', modifiedTracked.length === 0,
  modifiedTracked.length === 0 ? '' : modifiedTracked.join(', '));
if (modifiedTracked.length > 0) {
  console.log('       (a merge on top of uncommitted work is not what this verifies)');
  process.exit(1);
}
if (untracked.length > 0) console.log(`       note: ${untracked.length} untracked path(s), ignored`);

const originalHead = git('rev-parse', 'HEAD');
const originalBranch = git('rev-parse', '--abbrev-ref', 'HEAD');

/* 3. fetch upstream */
if (fetchFirst) {
  /*
   * GitHub from this network intermittently drops the TLS handshake
   * (`SSL_ERROR_SYSCALL`), which is a flake rather than a broken remote: the same
   * command succeeds seconds later, and `git ls-remote` against the same URL
   * answers in ~2s. Retry before reporting it, so a flaky network does not read
   * as "this fork cannot be updated".
   */
  let fetched = { ok: false, out: '' };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    fetched = tryGit('fetch', 'upstream', 'master');
    if (fetched.ok) break;
    if (attempt < 3) execFileSync(process.execPath, ['-e', 'setTimeout(()=>{}, 2000)']);
  }
  check('git fetch upstream master succeeds', fetched.ok,
    fetched.ok ? '' : fetched.out.split('\n')[0]);
  if (!fetched.ok) {
    console.log('       (network failure after 3 attempts -- rerun with --no-fetch to check against the local ref)');
  }
}

const mergeBase = git('merge-base', 'HEAD', 'upstream/master');
const counts = git('rev-list', '--left-right', '--count', 'upstream/master...HEAD').split(/\s+/);
const behind = Number(counts[0]);
const ahead = Number(counts[1]);
console.log(`       upstream/master is ${behind} commit(s) ahead, this fork is ${ahead} commit(s) ahead`);
console.log(`       merge base: ${mergeBase.slice(0, 12)}`);

/* 4. owned changes must not touch upstream files */
const owned = git('diff', '--name-only', `${mergeBase}..HEAD`);
const ownedList = owned === '' ? [] : owned.split('\n');
const trackedByUpstream = new Set(
  git('ls-tree', '-r', '--name-only', 'upstream/master').split('\n').filter(Boolean),
);
const collisions = ownedList.filter((path) => trackedByUpstream.has(path));
check('every owned change is in a path upstream does not track', collisions.length === 0,
  collisions.length === 0 ? `${ownedList.length} file(s), all under platform/`
    : `conflicting: ${collisions.join(', ')}`);
check('owned changes live under platform/', ownedList.every((path) => path.startsWith('platform/')),
  ownedList.join(', '));
check('platform/ exists only in this fork', !trackedByUpstream.has('platform/README.md'));

if (behind === 0) {
  console.log('       upstream has no new commits; the merge below is the no-op case');
  if (strict) check('upstream is current', false, 'run without --strict to accept a lagging upstream');
}

/* 5. the actual merge, on a throwaway branch, restoring HEAD afterwards */
let mergeOk = true;
let mergeDetail = '';
try {
  git('checkout', '-q', '-B', 'fork-update-check', 'HEAD');
  try {
    git('merge', '--no-edit', 'upstream/master');
    mergeDetail = behind === 0 ? 'up to date (no-op)' : `merged ${behind} commit(s)`;
  } catch (error) {
    mergeOk = false;
    const conflicts = tryGit('diff', '--name-only', '--diff-filter=U');
    mergeDetail = conflicts.ok && conflicts.out !== ''
      ? `conflicts: ${conflicts.out.split('\n').join(', ')}`
      : String(error.stdout ?? error.message).split('\n').slice(0, 2).join(' ');
    tryGit('merge', '--abort');
  }
} finally {
  git('checkout', '-q', originalHead);
  if (originalBranch !== 'HEAD') git('checkout', '-q', originalBranch);
  tryGit('branch', '-D', 'fork-update-check');
}
check('git merge upstream/master applies cleanly', mergeOk, mergeDetail);
check('HEAD restored after the check', git('rev-parse', 'HEAD') === originalHead);
check('still on the original branch', git('rev-parse', '--abbrev-ref', 'HEAD') === originalBranch,
  `${originalBranch} -> ${git('rev-parse', '--abbrev-ref', 'HEAD')}`);
check('no uncommitted edits introduced', git('status', '--porcelain')
  .split('\n').filter((line) => line !== '' && !line.startsWith('?? ')).length === 0);

console.log(`\n${failures === 0 ? 'fork can take upstream updates' : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
