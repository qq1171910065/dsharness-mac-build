#!/usr/bin/env node
/**
 * Re-wrap an already prepared `win-unpacked` directory into an NSIS installer
 * with this product's configuration, without repeating the preparation stages.
 *
 * This is the cheap end-to-end check of the installer seam: electron-builder's
 * `--prepackaged` short-circuits the packaging stages
 * (`app-builder-lib/out/platformPackager.js:146`), so only `NsisTarget` runs —
 * and that is exactly the piece this product replaces.
 *
 * Usage:
 *   node platform/windows/verify-installer.mjs [--output <directory>]
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..', '..');
const desktopDir = join(clientDir, 'apps', 'desktop');
const prepared = join(desktopDir, '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts', 'win-unpacked');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex < 0
  ? join(desktopDir, '.desktop-build', 'installer-seam-probe')
  : resolve(process.argv[outputIndex + 1]);

if (!existsSync(prepared)) throw new Error(`missing prepared application: ${prepared}`);
if (!existsSync(join(prepared, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))) {
  throw new Error(`${prepared} is not a complete unpacked application`);
}
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

// The release settings the packaging script owns; read from the target's own file.
const environmentModule = pathToFileURL(join(desktopDir, 'scripts', 'desktop-package-environment.mjs')).href;
const { loadDesktopPackageEnvironment } = await import(environmentModule);
const settings = loadDesktopPackageEnvironment('win32');
const env = {
  ...settings,
  DSH_DESKTOP_TARGET_PLATFORM: 'win32',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
  ELECTRON_BUILDER_7Z_FILTER: 'BCJ',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};
for (const name of Object.keys(env)) {
  if (/^DSH_DESKTOP_WINDOWS_/.test(name) || /^(?:WIN_)?CSC_/.test(name)) delete env[name];
}
const args = [
  join(desktopDir, 'node_modules', 'electron-builder', 'cli.js'),
  '--config', join(here, 'electron-builder-config.mjs'),
  '--win', '--x64', '--publish', 'never',
  '--prepackaged', prepared,
  '--config.directories.output', output,
];
process.stdout.write(`[verify] output: ${output}\n`);
const result = spawnSync(process.execPath, args, { cwd: desktopDir, env, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
