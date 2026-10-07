/**
 * electron-builder configuration for this product's Desktop build.
 *
 * Upstream owns `apps/desktop/electron-builder.config.mjs`, so this file is the
 * fork's own entry point: it loads the upstream config and changes exactly one
 * field — the NSIS custom include — leaving every other decision (files,
 * extraResources, asarUnpack, signing, publish feed, artifact naming) to the
 * code upstream maintains.
 *
 * Why `nsis.include` is the seam: electron-builder resolves the custom NSIS
 * script from `packager.getResource(this.options.include, 'installer.nsh')`
 * (`app-builder-lib/out/targets/nsis/NsisTarget.js:600`). Replacing it swaps the
 * installer customization at compile time without editing
 * `apps/desktop/scripts/installer.nsh`; ours `!include`s upstream first, so
 * upstream's custom pages and lifecycle hooks are preserved and we add only the
 * one hook upstream leaves free.
 *
 * Loading the upstream module (rather than re-implementing the config) is what
 * keeps this from drifting: a new upstream option appears here automatically.
 */

import { fileURLToPath } from 'node:url';
import upstream from '../../apps/desktop/electron-builder.config.mjs';

const nsisInclude = fileURLToPath(new URL('./installer.nsh', import.meta.url));

/** The upstream configuration with this product's installer script substituted. */
const config = {
  ...upstream,
  nsis: {
    ...(upstream.nsis ?? {}),
    include: nsisInclude,
  },
};

export default config;

export { nsisInclude };
