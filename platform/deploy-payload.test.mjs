import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildDeployPayload, DEFAULT_PLATFORM_ORIGIN, PAYLOAD_ENTRY, PAYLOAD_MODULES, payloadDirectory, renderDeployPatch,
} from './build-deploy-payload.mjs';
import { parseArguments, hookEnvironment } from './package-windows.mjs';
import { readConfigEnvironment, rewriteConfigArgument } from './windows/nsis-config-hook.mjs';
import { installInto } from './install.mjs';
import {
  deploy, ensureDesktopProfile, PROFILE_BUNDLES, PROFILE_PATCH_TEMPLATE, PROFILE_PNPM_WORKSPACE, profilesUnder,
  recordInstalledVersion,
} from './windows/deploy/deploy-entry.mjs';

/**
 * The installer seam's contract.
 *
 * Three things have to stay true for "the installer already carries the
 * deployment layer" to mean anything, and each is asserted below:
 *
 * 1. the payload really is the product's own deployment code, not a copy that
 *    drifted from it;
 * 2. the NSIS include really references the payload, opens with the **upstream**
 *    include, and stays compilable (pure ASCII, no macro redefinition);
 * 3. the profile the payload creates is indistinguishable from the one the
 *    application's own `initProfile` creates, because the application treats an
 *    existing profile as the user's and never rewrites it.
 *
 * The behavioural half of (3) runs upstream's function through `tsx` when the
 * repository has it; the source-text half always runs, so the check still fails
 * loudly on a machine without `tsx`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');
const upstreamProfile = join(clientDir, 'packages', 'boot', 'app-boot', 'src', 'profile.ts');
const windowsDir = join(here, 'windows');
const installer = join(windowsDir, 'installer.nsh');

function temporaryDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('deploy payload: the committed copies are byte-identical to their platform/ sources', () => {
  const target = payloadDirectory(here);
  for (const name of PAYLOAD_MODULES) {
    assert.equal(
      readFileSync(join(target, name), 'utf8'),
      readFileSync(join(here, name), 'utf8'),
      `${name} must be a verbatim copy of platform/${name}`,
    );
  }
  assert.ok(existsSync(join(target, PAYLOAD_ENTRY)), 'the hand-written entry point must be committed');
});

test('deploy payload: --check reports drift instead of rewriting it', () => {
  const root = temporaryDirectory('deploy-payload-');
  try {
    for (const name of PAYLOAD_MODULES) {
      writeFileSync(join(root, name), `original ${name}\n`);
    }
    mkdirSync(payloadDirectory(root), { recursive: true });
    writeFileSync(join(payloadDirectory(root), PAYLOAD_ENTRY), 'hand written entry\n');
    writeFileSync(join(root, 'cordis.patch.yml'), "- id: deepseek-account\n  config:\n    platformOrigin: !!js process.env.DSH_PLATFORM_ORIGIN ?? 'http://127.0.0.1:13090'\n");
    buildDeployPayload({ root });
    buildDeployPayload({ root, check: true });
    writeFileSync(join(payloadDirectory(root), 'install.mjs'), 'drifted\n');
    assert.throws(() => buildDeployPayload({ root, check: true }), /install\.mjs in .* is stale/);
    // A check that finds drift must not have repaired it either.
    assert.equal(readFileSync(join(payloadDirectory(root), 'install.mjs'), 'utf8'), 'drifted\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deploy payload: the platform origin is baked in and must be a bare origin', () => {
  const row = "- id: deepseek-account\n  config:\n    platformOrigin: !!js process.env.DSH_PLATFORM_ORIGIN ?? 'http://127.0.0.1:13090'\n";
  assert.equal(renderDeployPatch(row, 'https://www.czmanong.com'), "- id: deepseek-account\n  config:\n    platformOrigin: 'https://www.czmanong.com'\n");
  // The official provider rejects any origin whose pathname is not `/`, so a prefixed URL is a build error, not a runtime surprise.
  assert.throws(() => renderDeployPatch(row, 'https://www.czmanong.com/dsharness'), /bare origin/);
  assert.throws(() => renderDeployPatch(row, 'https://user:pass@example.test'), /bare origin/);
  // A file whose origin line moved or multiplied means the file changed shape.
  assert.throws(() => renderDeployPatch('[]\n', 'https://example.test'), /exactly one platformOrigin line/);
  assert.throws(() => renderDeployPatch(`${row}${row}`, 'https://example.test'), /exactly one platformOrigin line/);
});

test('deploy payload: the committed patch carries the production origin', () => {
  const text = readFileSync(join(payloadDirectory(here), 'cordis.patch.yml'), 'utf8');
  assert.match(text, new RegExp(`platformOrigin: '${DEFAULT_PLATFORM_ORIGIN.replaceAll('.', '\\.')}'`));
  assert.doesNotMatch(text, /DSH_PLATFORM_ORIGIN/, 'the installed copy must not depend on an environment variable');
});

test('deploy payload: the installed rows select this product\u2019s model route', () => {
  const text = readFileSync(join(payloadDirectory(here), 'cordis.patch.yml'), 'utf8');
  /*
   * Four rows decide where a conversation actually goes, and every one of them is
   * asserted here because a wrong value is invisible until a user's first message
   * fails (or, worse, until their stored grant is deleted):
   *
   * - `llm-pi-ai.providers.dsharness-relay` is the route: this product's gateway,
   *   the OpenAI-compatible protocol it serves, and the per-user key reference.
   * - `agent-default-model` names that route and `deepseek-v4.1-flash`.
   * - `llm-deepseek-account` is DISABLED: it sends the account grant as
   *   `x-dsh-auth-token`, which this gateway does not read, and a 401 through it
   *   calls `rejectToken` and deletes the stored grant — signing the user out.
   */
  assert.match(text, /^ {6}dsharness-relay:$/mu);
  assert.match(text, /^ {8}displayName: '码农AI'$/mu);
  assert.match(text, /^ {8}api: 'openai-completions'$/mu);
  assert.match(text, /^ {8}baseURL: 'https:\/\/ai\.czmanong\.com\/v1'$/mu);
  assert.match(text, /^ {8}apiKeyEnv: 'DSHARNESS_MODEL_KEY'$/mu);
  // Top-level rows: this file is a YAML sequence, so only the rows nested under an
  // `insert:` are indented.
  assert.match(text, /^- id: agent-default-model$/mu);
  assert.match(text, /^ {4}provider: 'dsharness-relay'$/mu);
  assert.match(text, /^ {4}model: 'deepseek-v4\.1-flash'$/mu);
  assert.match(text, /^- id: llm-pi-ai$/mu);
  const account = /^- id: llm-deepseek-account\n(?:.*\n)*?(?=\n- id: |\n#|$)/mu.exec(text);
  assert.ok(account !== null, 'the account-backed LLM row must still be addressed');
  assert.match(account[0], /^ {2}disabled: true$/mu);
});

test('deploy payload: the shipped key reference matches the plugin that writes it', async () => {
  // Two files name the credential: the route's `apiKeyEnv` and the plugin that
  // stores it. A mismatch is a silent `MISSING_CREDENTIAL` on every request, so the
  // pair is compared rather than each being checked against a literal.
  const { DEFAULT_REF } = await import('./model-key.mjs');
  const { PROFILE_PLUGINS } = await import('./provision.mjs');
  const text = readFileSync(join(payloadDirectory(here), 'cordis.patch.yml'), 'utf8');
  assert.match(text, new RegExp(`apiKeyEnv: '${DEFAULT_REF}'`, 'u'));
  // The row is inserted by the provisioned package's own patch, so it is NOT in this
  // file; what must hold here is that the plugin writing {@link DEFAULT_REF} is one
  // of the packages provisioning ships.
  const writer = PROFILE_PLUGINS.find((plugin) => plugin.entry === 'model-key.mjs');
  assert.ok(writer !== undefined, 'provisioning must ship the plugin that writes the key');
  assert.equal(writer.defaultEnabled, true, 'a model route with no credential fails every request');
});

test('installer include: opens with the upstream include and stays pure ASCII', () => {
  const bytes = readFileSync(installer);
  assert.equal(bytes.filter((byte) => byte > 0x7f).length, 0, 'makensis rejects a non-ASCII byte in an include without a BOM');
  const text = bytes.toString('utf8');
  const first = text.split('\n').find((line) => line.startsWith('!include '));
  assert.equal(first, '!include "${__FILEDIR__}\\..\\..\\apps\\desktop\\scripts\\installer.nsh"');
  assert.doesNotMatch(text, /!macro\s+(?:customHeader|customInit|customInstall|customCheckAppRunning)\b/u,
    'NSIS forbids redefining an upstream macro');
});

test('installer include: runs the deployment layer from the installed application', () => {
  const text = readFileSync(installer, 'utf8');
  assert.match(text, /^Function \.onInstSuccess$/mu);
  for (const file of [...PAYLOAD_MODULES, PAYLOAD_ENTRY, 'cordis.patch.yml']) {
    assert.ok(text.includes(`deploy\\${file}`), `the include must embed ${file}`);
  }
  assert.match(text, /nsExec::ExecToLog '.*resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node\.exe.*deploy-entry\.mjs.*\$INSTDIR.*'/u);
  assert.match(text, /DetailPrint "DSH Desktop: deployment layer exited with \$0"/u);
  /*
   * The version has to travel with the invocation. An unsigned build has no update
   * feed to ask later (`publish: null` ⇒ no `app-update.yml`), so the installer —
   * which electron-builder feeds `${VERSION}` — is the only witness to what the user
   * actually installed. Without it the check-for-updates page could only ever show
   * the latest release, never whether it is newer than this machine.
   */
  assert.match(text, /deploy-entry\.mjs"\s+"\$INSTDIR"\s+"\$\{VERSION\}"/u,
    'the include must pass the installer version to the deployment entry');
});

test('installer include: ${VERSION} is an NSIS define electron-builder supplies', () => {
  // Guard the guard: if a future electron-builder renames the define, the include
  // above would compile to a literal and every install would record nothing.
  const nsisTarget = join(clientDir, 'apps', 'desktop', 'node_modules', 'app-builder-lib',
    'out', 'targets', 'nsis', 'NsisTarget.js');
  const text = readFileSync(nsisTarget, 'utf8');
  assert.match(text, /VERSION: appInfo\.version/u, 'electron-builder defines VERSION for the NSIS script');
});

test('deploy entry: the installer version is recorded for the update check', async () => {
  const home = temporaryDirectory('deploy-version-');
  /*
   * The reader and the writer live in different payload modules (`update.mjs` reads
   * the record, `deploy-entry.mjs` writes it) and neither can import the other: the
   * payload directory is flat, so the file name is a literal in both. Read them here
   * and compare, so a rename cannot silently break the feature.
   */
  const { INSTALL_RECORD, readInstallRecord } = await import('./update.mjs');
  try {
    // No version supplied (a hand-run `deploy-entry.mjs`, or an older installer):
    // nothing is written, so the page says "unknown" rather than inventing a value.
    assert.equal(recordInstalledVersion(home, undefined, 'C:/app'), undefined);
    assert.equal(existsSync(join(home, INSTALL_RECORD)), false);
    assert.equal(recordInstalledVersion(home, '   ', 'C:/app'), undefined);
    assert.equal(existsSync(join(home, INSTALL_RECORD)), false);

    assert.equal(recordInstalledVersion(home, '0.2.1-alpha.1.20261007.2', 'C:/app'),
      '0.2.1-alpha.1.20261007.2');
    const record = JSON.parse(readFileSync(join(home, INSTALL_RECORD), 'utf8'));
    assert.equal(record.version, '0.2.1-alpha.1.20261007.2');
    assert.equal(record.installDir, 'C:/app');
    assert.equal(typeof record.installedAt, 'string');
    assert.equal(INSTALL_RECORD, 'dsharness-install.json');
    assert.equal(readInstallRecord(home)?.version, '0.2.1-alpha.1.20261007.2');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('deploy entry: creates the profile the application would, and never rewrites one', () => {
  const home = temporaryDirectory('deploy-profile-');
  try {
    assert.equal(ensureDesktopProfile(home), true);
    const dir = join(home, 'profiles', 'desktop');
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, [...PROFILE_BUNDLES]);
    assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), PROFILE_PATCH_TEMPLATE);
    assert.equal(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'), PROFILE_PNPM_WORKSPACE);
    // A second run is the application's own first launch: everything is the user's now.
    writeFileSync(join(dir, 'package.json'), '{"mine":true}\n');
    assert.equal(ensureDesktopProfile(home), false);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{"mine":true}\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('deploy entry: the Desktop profile is provisioned first, then whatever the home already has', () => {
  const home = temporaryDirectory('deploy-profiles-');
  try {
    assert.deepEqual(profilesUnder(home), ['desktop']);
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true });
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true });
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true });
    assert.deepEqual(profilesUnder(home), ['desktop', 'web']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * The managed home block has to beat the profile's own patch file.
 *
 * This is the whole reason the model route can be pinned from a deployment: the
 * official account surface calls `session.initializeDefaultModel()` on the sign-in
 * edge (`packages/client/ui-settings-account/src/client/index.ts:117-132`), which
 * hardcodes `provider = 'deepseek-account'` and persists that choice into the
 * **profile** layer (`packages/api/session-controller/src/index.ts:298-310`). The
 * guard meant to prevent that (`hasProviderApiKey`,
 * `packages/api/session-controller/src/catalog.ts:105`) skips `deepseek-account`
 * itself, so it never fires for the provider being installed.
 *
 * If the profile layer won, every sign-in would silently point the default model at
 * the account route — which in this deployment answers 401 and whose 401 handler
 * deletes the stored grant, i.e. "sign in, start a new session, get thrown back to
 * the login page". The measurement below is the one that decides it, so it is
 * asserted rather than argued.
 */
test('deploy entry: the managed home block overrides what a sign-in writes to the profile layer', () => {
  const home = temporaryDirectory('deploy-layer-');
  try {
    const profileDir = join(home, 'profiles', 'desktop');
    mkdirSync(profileDir, { recursive: true });
    // The profile layer, exactly as `initializeDefaultModel` would leave it.
    writeFileSync(join(profileDir, 'cordis.patch.yml'),
      '- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-v4.1-flash\n');
    const block = readFileSync(join(payloadDirectory(here), 'cordis.patch.yml'), 'utf8');
    installInto(home, block, { write: false });
    const profilePatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.match(profilePatch, /provider: deepseek-account/, 'the profile layer really does name the account route');
    // `readProfilePatches` composes home AFTER profile, so ours is the last word.
    const layers = [profilePatch, block];
    const resolved = layers
      .flatMap((text) => [...text.matchAll(/^- id: agent-default-model\n((?: {2}.*\n)+)/gmu)])
      .at(-1)[1];
    assert.match(resolved, /provider: 'dsharness-relay'/, 'the home block must be applied last and win');
    assert.match(resolved, /model: 'deepseek-v4\.1-flash'/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('deploy entry: writes the rows and provisions every profile, with an injected runner', () => {
  const home = temporaryDirectory('deploy-rows-');
  const install = temporaryDirectory('deploy-install-');
  try {
    const calls = [];
    const report = deploy({
      home,
      installDir: install,
      run: (profileDir, args) => { calls.push({ profileDir, args }); return { status: 0, output: '' }; },
    });
    assert.equal(report.created, true);
    assert.equal(report.target, join(home, 'cordis.patch.yml'));
    assert.match(readFileSync(report.target, 'utf8'), /platformOrigin: 'https:\/\/www\.czmanong\.com'/u);
    assert.deepEqual(report.reports.map((entry) => entry.profile), ['desktop']);
    assert.deepEqual(calls.map((call) => call.profileDir), [join(home, 'profiles', 'desktop')]);
    assert.deepEqual(calls[0].args.slice(0, 1), ['add']);
    assert.ok(calls[0].args.includes('dshmarket'), 'the marketplace install is what makes the Plugins page work');
    // The generated bundle package is placed without a package manager, so it survives an offline install.
    assert.ok(existsSync(join(home, 'profiles', 'desktop', 'node_modules', 'dsharness-host-auth', 'index.mjs')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(install, { recursive: true, force: true });
  }
});

test('deploy entry: an install directory is required', () => {
  const previous = process.env.DSHARNESS_INSTALL_DIR;
  delete process.env.DSHARNESS_INSTALL_DIR;
  try {
    assert.throws(() => deploy({ home: temporaryDirectory('deploy-nodir-'), run: () => ({ status: 0 }) }), /install directory is required/);
  } finally {
    if (previous !== undefined) process.env.DSHARNESS_INSTALL_DIR = previous;
  }
});

test('config hook: rewrites only the upstream configuration argument', () => {
  const argv = ['node', 'C:\\client\\apps\\desktop\\node_modules\\electron-builder\\cli.js', '--config', 'electron-builder.config.mjs', '--win'];
  assert.equal(rewriteConfigArgument(argv, 'C:\\staged\\config.mjs'), true);
  assert.equal(argv[3], 'C:\\staged\\config.mjs');
  // A run that already names another configuration is left alone: the substitution happens once.
  const other = ['node', 'cli.js', '--config', 'C:\\staged\\config.mjs'];
  assert.equal(rewriteConfigArgument(other, 'C:\\other.mjs'), false);
  assert.equal(other[3], 'C:\\staged\\config.mjs');
  // `--config.<path>=<value>` overrides carry no separate argument and must not be touched.
  const dotted = ['node', 'cli.js', '--config.nsis.unicode=false'];
  assert.equal(rewriteConfigArgument(dotted, 'C:\\staged\\config.mjs'), false);
  assert.deepEqual(dotted.slice(2), ['--config.nsis.unicode=false']);
});

test('config hook: reads its configuration path from the environment', () => {
  assert.equal(readConfigEnvironment(undefined), undefined);
  assert.equal(readConfigEnvironment(''), undefined);
  assert.equal(readConfigEnvironment('C:\\staged\\config.mjs'), 'C:\\staged\\config.mjs');
  assert.match(readConfigEnvironment(pathToFileURL('C:\\staged\\config.mjs').href), /staged/);
  assert.equal(readConfigEnvironment('config.mjs'), resolve('config.mjs'));
});

test('config hook: the environment a packaging run sets is self-consistent', () => {
  const env = hookEnvironment('C:\\staged\\config.mjs');
  assert.match(env.NODE_OPTIONS, /^--import file:\/\/\/.*nsis-config-hook\.mjs$/u);
  assert.equal(env.DSHARNESS_NSIS_CONFIG_HOOK, '1');
  assert.equal(env.DSHARNESS_NSIS_CONFIG, 'C:\\staged\\config.mjs');
  assert.ok(existsSync(fileURLToPath(env.NODE_OPTIONS.replace('--import ', ''))));
});

test('package-windows: only an unsigned Windows build may be produced', () => {
  assert.deepEqual(parseArguments(['--unsigned']), { passthrough: ['--unsigned'], check: false, origin: DEFAULT_PLATFORM_ORIGIN });
  assert.deepEqual(parseArguments(['--unsigned', '--build-version', '0.2.1-alpha.1.20261007.1']).passthrough,
    ['--unsigned', '--build-version', '0.2.1-alpha.1.20261007.1']);
  assert.deepEqual(parseArguments(['--check']).check, true);
  assert.equal(parseArguments(['--check', '--platform-origin', 'https://example.test']).origin, 'https://example.test');
  assert.throws(() => parseArguments([]), /unsigned Windows builds only/u);
  assert.throws(() => parseArguments(['--unsigned', '--config']), /unknown option/u);
  assert.throws(() => parseArguments(['--unsigned', '--build-version']), /requires a value/u);
  assert.throws(() => parseArguments(['--unsigned', '--platform-origin']), /requires a value/u);
});

test('upstream parity: the literal profile an install creates matches initProfile', () => {
  /*
   * Source-text half: this runs everywhere, and fails when upstream's recipe
   * moves. The templates are template literals in `profile.ts`, so the escapes
   * have to be undone before comparing against the written files.
   */
  const source = readFileSync(upstreamProfile, 'utf8');
  const unescape = (text) => text.replaceAll('\\`', '`').replaceAll('\\${', '${');
  const literal = (name) => {
    const match = new RegExp(`const ${name} = \`([\\s\\S]*?)\`\\n`, 'u').exec(source);
    assert.ok(match, `${name} must still be a template literal in packages/boot/app-boot/src/profile.ts`);
    return unescape(match[1]);
  };
  assert.equal(PROFILE_PATCH_TEMPLATE, literal('PROFILE_PATCH_TEMPLATE'));
  assert.equal(PROFILE_PNPM_WORKSPACE, literal('PROFILE_PNPM_WORKSPACE'));
  assert.match(source, new RegExp(`web: \\{\\s*bundles: \\[${PROFILE_BUNDLES.map((name) => `'${name.replaceAll('/', '\\/')}'`).join(', ')}\\],`, 'u'));
  assert.equal(JSON.parse(readFileSync(join(clientDir, 'packages', 'boot', 'app-boot', 'package.json'), 'utf8')).name,
    '@deepseek-ai/dsh-app-boot');

  /*
   * Behavioural half: run upstream's own function through tsx and compare byte
   * for byte. `tsx` is a development dependency of this workspace; without it
   * the source-text assertions above are the whole guard.
   */
  const tsx = join(clientDir, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
  if (!existsSync(tsx)) return;
  const directory = temporaryDirectory('initprofile-');
  try {
    const probe = join(directory, 'probe.mjs');
    writeFileSync(probe, [
      `import { initProfile, PROFILE_TEMPLATES } from ${JSON.stringify(pathToFileURL(upstreamProfile).href)}`,
      "import { readFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      'const dir = process.argv[2]',
      'initProfile(dir, PROFILE_TEMPLATES.web.bundles)',
      "const out = {}",
      "for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) out[file] = readFileSync(join(dir, file), 'utf8')",
      'process.stdout.write(JSON.stringify(out))',
      '',
    ].join('\n'));
    const target = join(directory, 'profile');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(tsx).href, probe, target], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const upstream = JSON.parse(result.stdout);
    assert.equal(PROFILE_PATCH_TEMPLATE, upstream['cordis.patch.yml']);
    assert.equal(PROFILE_PNPM_WORKSPACE, upstream['pnpm-workspace.yaml']);
    assert.deepEqual(PROFILE_BUNDLES, JSON.parse(upstream['package.json']).dsh.profile.bundles);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
