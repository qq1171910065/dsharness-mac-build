#!/usr/bin/env node
/**
 * Assemble the payload the Windows installer embeds and runs at install time.
 *
 * The payload is the product's deployment layer itself -- the same
 * `platform/*.mjs` files a developer machine runs through
 * `node platform/install.mjs` -- copied into `platform/windows/deploy/` so NSIS
 * can embed the directory with `File /r` and extract it at install time.
 *
 * Two properties this file exists to hold:
 *
 * - **One source of truth.** The installed copy is generated, never hand-edited.
 *   `platform/windows/deploy/*.mjs` are byte-identical copies of their
 *   `platform/` originals, and `--check` (used by `deploy-payload.test.mjs`)
 *   fails when a copy has drifted.
 * - **The product origin is baked in.** An installed machine has no
 *   `DSH_PLATFORM_ORIGIN`, and the loader refuses to let any `.env` supply a
 *   `DSH_`-prefixed name (`packages/boot/app-boot/src/index.ts:157`), so the
 *   origin cannot be configured after the fact: it has to be a build input.
 *   `--platform-origin` therefore rewrites the one line of
 *   `platform/cordis.patch.yml` that names it.
 *
 * `deploy-entry.mjs` is deliberately NOT generated: it is the payload's own
 * entry point, it is written against the app's shipped layout, and it needs the
 * comments that explain that layout more than it needs to be a copy.
 *
 * Usage:
 *   node platform/build-deploy-payload.mjs                       # write, default origin
 *   node platform/build-deploy-payload.mjs --platform-origin https://example.test
 *   node platform/build-deploy-payload.mjs --check               # fail when stale
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where this product's own login service is reachable in production.
 *
 * It has to be a **bare origin**, not a path: the official provider validates
 * `platformOrigin` with `platformOrigin(value, allowLoopbackHttp)`
 * (`packages/credentials/deepseek-account-platform/src/protocol.ts:22`), which
 * rejects any URL whose `pathname` is not `/`. A reverse-proxy prefix such as
 * `https://www.czmanong.com/dsharness` is therefore unusable as `platformOrigin`
 * even though it is where the container is reachable today, so the gateway
 * carries this product's paths at the bare origin instead.
 */
export const DEFAULT_PLATFORM_ORIGIN = 'https://www.czmanong.com';

/** Payload modules copied verbatim from `platform/`. */
export const PAYLOAD_MODULES = ['home.mjs', 'provision.mjs', 'install.mjs', 'host-auth.mjs'];

/** The row file whose `platformOrigin` line the build rewrites. */
const PATCH_SOURCE = 'cordis.patch.yml';

/** The payload's own entry point; hand-written, so never regenerated. */
export const PAYLOAD_ENTRY = 'deploy-entry.mjs';

/** `platform/windows/deploy`, the directory NSIS embeds. */
export function payloadDirectory(root = here) {
  return join(root, 'windows', 'deploy');
}

/**
 * Point the deployment rows at one origin.
 *
 * Only the `platformOrigin:` line is touched, and only when it appears exactly
 * once: the row restates every key of the targeted entry, so a second match
 * would mean the file changed shape and the substitution would be guessing.
 *
 * @param patch - contents of `platform/cordis.patch.yml`.
 * @param origin - the bare origin to write.
 * @returns the contents to ship.
 */
export function renderDeployPatch(patch, origin) {
  const url = new URL(origin);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`deploy payload: platform origin must be a bare origin, got ${origin}`);
  }
  const line = /^([ \t]*)platformOrigin:.*$/gmu;
  const matches = [...patch.matchAll(line)];
  if (matches.length !== 1) {
    throw new Error(`deploy payload: expected exactly one platformOrigin line, found ${matches.length}`);
  }
  const indent = matches[0][1];
  return patch.replace(/^[ \t]*platformOrigin:.*$/mu, `${indent}platformOrigin: '${url.origin}'`);
}

/**
 * Write (or verify) the payload directory.
 *
 * @param options - `root` overrides the `platform/` directory; `origin` the
 *   baked origin; `check` compares instead of writing.
 * @returns the absolute payload directory.
 */
export function buildDeployPayload(options = {}) {
  const root = options.root ?? here;
  const origin = options.origin ?? DEFAULT_PLATFORM_ORIGIN;
  const target = payloadDirectory(root);
  mkdirSync(target, { recursive: true });
  const stale = [];
  const write = (name, contents) => {
    const destination = join(target, name);
    const current = existsSync(destination) ? readFileSync(destination, 'utf8') : undefined;
    if (current === contents) return;
    if (options.check === true) {
      stale.push(name);
      return;
    }
    writeFileSync(destination, contents, 'utf8');
  };
  for (const name of PAYLOAD_MODULES) {
    const source = join(root, name);
    if (!existsSync(source)) throw new Error(`deploy payload: missing ${source}`);
    write(name, readFileSync(source, 'utf8'));
  }
  const patch = readFileSync(join(root, PATCH_SOURCE), 'utf8');
  write(PATCH_SOURCE, renderDeployPatch(patch, origin));
  if (!existsSync(join(target, PAYLOAD_ENTRY))) {
    throw new Error(`deploy payload: missing ${join(target, PAYLOAD_ENTRY)}; it is hand-written and must be committed`);
  }
  if (stale.length > 0) {
    throw new Error(`deploy payload: ${stale.join(', ')} in ${target} is stale; run node platform/build-deploy-payload.mjs`);
  }
  return target;
}

/** Rewrite a payload module copy in place; used only by the spec. */
export function writePayloadCopy(root, name, contents) {
  writeFileSync(join(payloadDirectory(root), name), contents, 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  const originIndex = args.indexOf('--platform-origin');
  const origin = originIndex < 0 ? DEFAULT_PLATFORM_ORIGIN : args[originIndex + 1];
  if (originIndex >= 0 && origin === undefined) throw new Error('deploy payload: --platform-origin requires a value');
  const check = args.includes('--check');
  const target = buildDeployPayload({ origin, check });
  process.stdout.write(`[platform] deploy payload ${check ? 'verified' : 'written'}: ${target}\n`);
  process.stdout.write(`[platform] entry: ${join(target, PAYLOAD_ENTRY)}\n`);
  process.stdout.write(`[platform] modules: ${PAYLOAD_MODULES.join(', ')}, ${PATCH_SOURCE} (platformOrigin ${origin})\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
