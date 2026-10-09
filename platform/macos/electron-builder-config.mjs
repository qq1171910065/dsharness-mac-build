/**
 * electron-builder configuration for this product's macOS build.
 *
 * Upstream owns `apps/desktop/electron-builder.config.mjs`, so this file is the
 * fork's own entry point: it loads the upstream config and turns off code
 * signing and notarization, leaving every other decision (files, asarUnpack,
 * runtime staging, artifact naming) to the code upstream maintains.
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
 * ## Why not `--config.mac.notarize=false` on the command line
 *
 * Upstream already passes that switch for its own intermediate stages
 * (`package-target.ts:277,479,490`), but it is not sufficient on its own: the
 * release environment is resolved *before* electron-builder starts, in this
 * repo's own process, and `resolveMacOSSigningEnvironment` throws when
 * `DSH_DESKTOP_MACOS_SIGNING_IDENTITY` is unset
 * (`desktop-release-environment.mjs:77`). Two independent things have to be
 * satisfied — the environment check, and the builder options — and only the
 * second is reachable from the command line.
 *
 * So the packaging entry point (`package-macos.mjs`) supplies placeholder
 * environment values to get past validation, and this module overrides the two
 * builder options that would otherwise try to use them. The placeholders are
 * never used for signing because `forceCodeSigning` is false and `identity` is
 * null; if that ever stops being true the build fails loudly instead of
 * producing a bundle signed with a meaningless identity.
 */

import upstream from '../../apps/desktop/electron-builder.config.mjs';

/**
 * Platform-specific settings for a build with no Apple credentials.
 *
 * `identity: null` disables the certificate lookup entirely; `notarize: false`
 * stops the notary submission. `hardenedRuntime` and `entitlements` are left as
 * upstream sets them — they describe the runtime the application expects, and
 * an unsigned build simply does not get the signature that would enforce them.
 */
const mac = {
  ...(upstream.mac ?? {}),
  identity: null,
  forceCodeSigning: false,
  notarize: false,
};

/** The upstream configuration with signing and notarization disabled. */
const config = {
  ...upstream,
  mac,
};

export default config;

export { mac };
