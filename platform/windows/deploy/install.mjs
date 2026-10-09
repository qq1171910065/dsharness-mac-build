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
 * ## What belongs in the managed block, and what does not
 *
 * Only **rows upstream already declares**, and only ones the settings page does not
 * write: the account row's `platformOrigin`, and the two routes this deployment must
 * switch off — `llm-deepseek` (the built-in DeepSeek card; the official models stay
 * reachable through `llm-pi-ai`'s catalog) and `llm-deepseek-account` (whose 401
 * handling deletes the stored account grant). `config:` values appear here only for
 * `deepseek-account`; the two disabled rows carry no `config` at all. No new plugin is
 * inserted here: fork-owned plugins are **provisioned as real bundle packages** by
 * {@link provisionAll}, so the official Plugins page can show and switch them. A row
 * inserted from this file would belong to no package, so the page would never list it —
 * and an enablement flag written here for one of *our* rows would be applied **after**
 * the profile layer, so the page's own switch could never override it.
 * `platform/cordis.patch.yml` carries the measurement, the reasoning, and why an
 * upstream row is the exception.
 *
 * ## The row set this file must never carry: a page-writable config
 *
 * This layer is applied **after** the profile's own patch
 * (`packages/boot/app-boot/src/profile-context.ts:63-73`), and
 * `ConfigEditor.edit()` refuses any write whose namespace this layer overrides
 * (`packages/boot/config-editor/src/index.ts:136-141`: it recomposes with the home layer
 * and throws `Configuration for "<id>" is overridden by a home patch or command-line
 * overlay`). So a `config:` block here for a row the settings page writes is not a
 * default — it is a lock: every write to that namespace fails, which is what
 * 「home 层占了 llm-pi-ai 这个 id，导致无法添加自定义模型 api 了」 was. `llm-pi-ai` and
 * `agent-default-model` were removed for exactly that reason, and `install.test.mjs`
 * asserts no writable row comes back.
 *
 * ## Where the model catalog lives instead
 *
 * The runtime reads this file, but 设置 › 模型 does not:
 * `ConfigEditor.configuration()` (`packages/boot/config-editor/src/index.ts:49-70`)
 * composes *bundle layers + the profile's patch* and keeps the **first** row per id,
 * so `@deepseek-ai/dsh-base`'s own `- id: llm-pi-ai`
 * (`packages/bundle/base/cordis.patch.yml:127`) is what the page inherits — an empty
 * catalog, hence 「正在使用适配器默认模型」. A second row in any later bundle layer
 * cannot displace it, because first-row-wins is by row id, not by layer. The catalog
 * that page must show is therefore written by `provision.mjs` into each **profile's**
 * own patch layer ({@link MODEL_CATALOG_ROWS}), guarded so a row the person already
 * has is never touched. That is also the layer the page can write back to.
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
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from './home.mjs';
import { describeReports, provisionAll, unprovisionProfile } from './provision.mjs';

const BEGIN = '# >>> dsharness platform rows (managed by platform/install.mjs)';
const END = '# <<< dsharness platform rows';

const here = dirname(fileURLToPath(import.meta.url));

export { resolveDshHome };

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
 * Write the managed rows, then provision the profile plugins.
 *
 * @param home - Harness home receiving the patch file.
 * @param block - rendered rows.
 * @param options - passed through to {@link provisionAll} (`write: false` for a
 *   dry run; `run` injects a fake pnpm runner for specs).
 * @returns the patch file path and the provisioning reports.
 */
export function installInto(home, block, options = {}) {
  const target = join(home, 'cordis.patch.yml');
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
  writeFileSync(target, mergeManagedBlock(existing, block), 'utf8');
  return { target, reports: provisionAll(home, options) };
}

/**
 * Remove the managed block, and the plugin packages this script owns.
 *
 * @param home - Harness home.
 * @param options - `profiles` overrides the discovered list; otherwise every
 *   profile under the home is unprovisioned.
 * @returns the patch file path and the unprovisioning reports.
 */
export function removeFrom(home, options = {}) {
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
  const profiles = options.profiles ?? discoveredProfiles(home);
  return { target, reports: profiles.map((profile) => unprovisionProfile(home, profile, options)) };
}

/** Profile directories under a Harness home, excluding the shared dependency tree. */
function discoveredProfiles(home) {
  const dir = join(home, 'profiles');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => entry.name);
}

function main() {
  const source = join(here, 'cordis.patch.yml');
  if (!existsSync(source)) throw new Error(`missing ${source}`);
  const home = resolveDshHome();
  const block = readFileSync(source, 'utf8');

  if (process.argv.includes('--remove')) {
    const { target, reports } = removeFrom(home);
    process.stdout.write(`[platform] removed managed rows from ${target}\n`);
    for (const report of reports) {
      process.stdout.write(
        report.status === 'skipped'
          ? `[platform] ${report.profile}: nothing to remove (${report.reason})\n`
          : `[platform] ${report.profile}: removed ${report.removed.join(', ') || 'nothing'}`
            + `${report.catalog ? '; removed the model catalog block' : ''}\n`,
      );
    }
    return;
  }

  const dryRun = process.argv.includes('--check');
  const withMarketplace = !process.argv.includes('--no-marketplace');
  const { target, reports } = installInto(home, block, { write: !dryRun, withMarketplace });

  const origin = String(process.env.DSH_PLATFORM_ORIGIN || '').trim() || 'http://127.0.0.1:13090';
  const token = String(process.env.DSH_AUTH_TOKEN || '').trim();
  /*
   * The managed rows are written even under `--check`: the merge is idempotent, so
   * an unchanged file stays byte-identical. The word still has to be honest, since
   * that write is the one thing a dry run does do.
   */
  process.stdout.write(`[platform] ${dryRun ? 'would write' : 'wrote'} ${target}\n`);
  process.stdout.write('[platform] managed rows: deepseek-account (origin), webserver (fixed port / optional LAN bind), llm-deepseek (disabled: no built-in DeepSeek card), llm-deepseek-account (disabled: its 401 signs the user out)\n');
  for (const line of describeReports(reports, dryRun)) process.stdout.write(`${line}\n`);
  process.stdout.write(`[platform] account origin: ${origin}\n`);
  process.stdout.write(
    '[platform] this layer carries no `llm-pi-ai` / `agent-default-model`: applied after the profile'
    + ' layer, a config here would make 设置 › 模型 refuse every write (config-editor throws'
    + ' "overridden by a home patch or command-line overlay")\n',
  );
  process.stdout.write(
    '[platform] model route: written per profile into profiles/<name>/cordis.patch.yml'
    + ' (dsharness-relay -> https://ai.czmanong.com/v1, 码农AI, default deepseek-v4.1-flash);'
    + ' official models stay addable through 添加模型提供商 › 第三方模型提供商 (deepseek)\n',
  );
  // Never print the secret itself, only whether one is present.
  process.stdout.write(
    `[platform] host auth token: ${token.length >= 16
      ? `configured (${token.length} chars)`
      : 'not set; the gateway plugin generates and stores one on first run and shows it at /dsharness/gateway'}\n`,
  );
  /*
   * The external-integration address, and the one line that has to be loud.
   *
   * The Desktop Host always launches with `--port 0`, so without these two the
   * port changes on every restart and a caller that stored one address reports
   * "service unreachable" (measured: sixai's dsh_instance rows still held :3080
   * and :43127 from the previous shell). Printing the resolved values is what
   * lets an operator copy the right address instead of guessing.
   */
  const gatewayHost = String(process.env.DSH_GATEWAY_HOST || '').trim();
  const gatewayPort = String(process.env.DSH_GATEWAY_PORT || '').trim();
  process.stdout.write(
    `[platform] external access: host ${gatewayHost === '' ? '127.0.0.1 (loopback only)' : gatewayHost}`
    + `, port ${gatewayPort === '' ? 'OS-assigned each launch (set DSH_GATEWAY_PORT to pin it)' : gatewayPort}\n`,
  );
  if (gatewayHost === '0.0.0.0') {
    process.stdout.write(
      '[platform] ⚠️ DSH_GATEWAY_HOST=0.0.0.0 binds all interfaces: everyone who can reach this machine'
      + ' can call the full Harness API, including shell execution. Keep the shared secret strong and'
      + ' treat the network as trusted. Leave it unset to stay loopback-only.\n',
    );
  }
}

// Only run when invoked directly; the exports above exist for the spec.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
