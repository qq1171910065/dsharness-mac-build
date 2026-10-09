/**
 * electron-builder configuration for this product's macOS build.
 *
 * Upstream owns `apps/desktop/scripts/electron-builder-config.mjs`, so this file
 * is the fork's own entry point: it builds the upstream configuration and turns
 * off code signing and notarization, leaving every other decision (files,
 * asarUnpack, runtime staging, artifact naming) to the code upstream maintains.
 *
 * ## Why signing is off, and what that costs
 *
 * Signing a macOS release needs a paid Apple Developer account: a "Developer ID
 * Application" certificate to sign with, plus notary credentials so Gatekeeper
 * accepts the result. This build has neither, so upstream's defaults cannot run
 * at all — `mac.forceCodeSigning: true` and `mac.notarize: true`
 * (`apps/desktop/scripts/electron-builder-config.mjs:156,163`) both demand
 * credentials that do not exist here.
 *
 * The result is a **development build**: it runs on the machine that built it
 * after the user clears the quarantine attribute or opens it via
 * right-click → Open, and it must never be handed to a user as a release.
 * Gatekeeper reports "cannot be opened because the developer cannot be
 * verified" for a downloaded copy, and an unsigned bundle is not notarized, so
 * there is no way around that short of obtaining the account.
 *
 * ## Why the factory rather than upstream's default export
 *
 * `apps/desktop/electron-builder.config.mjs` evaluates
 * `createElectronBuilderConfig()` at import time, and that function resolves
 * every release setting immediately — including
 * `resolveMacOSNotarizationEnvironment`, which throws whenever no Apple strategy
 * is configured (`electron-builder-config.mjs:67`,
 * `desktop-release-environment.mjs:120`). Importing it therefore fails before
 * this file can override anything.
 *
 * The factory is exported separately, so it is called here with an environment
 * carrying placeholder notary credentials purely to satisfy that lookup.
 * Nothing downstream uses them: the `mac` block below replaces `identity`,
 * `forceCodeSigning` and `notarize`, so electron-builder never asks for a
 * certificate and never contacts Apple. Only those three fields decide that, and
 * `platform/package-macos.test.mjs` asserts they cannot change silently.
 */

import { createElectronBuilderConfig } from '../../apps/desktop/scripts/electron-builder-config.mjs';

/**
 * Placeholder signing settings the release environment insists on.
 *
 * Two independent validations stand between an unsigned build and this file, and
 * both must be satisfied or the build never starts:
 *
 * - `resolveMacOSSigningEnvironment` requires a certificate qualifier and a
 *   10-character team id (`desktop-release-environment.mjs:76-86`).
 * - `resolveMacOSNotarizationEnvironment` requires one complete Apple strategy,
 *   and the App Store Connect key is used because it is a plain path string that
 *   is never stat'ed (`:93-120`).
 *
 * None of these values is used. They exist so resolution completes, and the
 * `mac` override below is what stops electron-builder from acting on them.
 */
export const PLACEHOLDER_SIGNING = {
  DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'DSH Desktop development build',
  DSH_DESKTOP_MACOS_TEAM_ID: '0000000000',
};

/** Placeholder notary credentials; see `PLACEHOLDER_SIGNING`. */
export const PLACEHOLDER_NOTARY = {
  APPLE_API_KEY: '/nonexistent/placeholder-notary-key.p8',
  APPLE_API_KEY_ID: 'PLACEHOLDER',
  APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
};

/**
 * Build the configuration for a build with no Apple credentials.
 * @param env - Release environment, normally `process.env`.
 * @param hostPlatform - Build-host platform, forwarded to upstream.
 * @param hostArch - Build-host architecture, forwarded to upstream.
 * @returns Upstream's configuration with signing and notarization disabled.
 */
export function createUnsignedMacOSConfig(env = process.env, hostPlatform = process.platform, hostArch = process.arch) {
  const upstream = createElectronBuilderConfig(
    { ...PLACEHOLDER_NOTARY, ...PLACEHOLDER_SIGNING, ...env },
    hostPlatform,
    hostArch,
  );
  return {
    ...upstream,
    mac: {
      ...(upstream.mac ?? {}),
      identity: null,
      forceCodeSigning: false,
      notarize: false,
    },
  };
}

/** The configuration for this process's environment. */
const config = createUnsignedMacOSConfig();

export default config;
