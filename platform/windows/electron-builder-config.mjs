/**
 * electron-builder configuration for this product's Desktop build.
 *
 * Upstream owns `apps/desktop/electron-builder.config.mjs`, so this file is the
 * fork's own entry point: it loads the upstream config and changes exactly two
 * fields — the NSIS custom include, and one added `extraResources` entry —
 * leaving every other decision (files, asarUnpack, signing, publish feed,
 * artifact naming) to the code upstream maintains.
 *
 * Why `nsis.include` is the seam: electron-builder resolves the custom NSIS
 * script from `packager.getResource(this.options.include, 'installer.nsh')`
 * (`app-builder-lib/out/targets/nsis/NsisTarget.js:600`). Replacing it swaps the
 * installer customization at compile time without editing
 * `apps/desktop/scripts/installer.nsh`; ours `!include`s upstream first, so
 * upstream's custom pages and lifecycle hooks are preserved and we add only the
 * one hook upstream leaves free.
 *
 * ## Why the update descriptor ALSO goes through `extraResources`
 *
 * `installer.nsh` copies `app-update.yml` into `$INSTDIR\resources` from
 * `.onInstSuccess`, but that hook runs **after** the install section — and an
 * update install is silent and force-run, so the assisted installer relaunches
 * the application at the end of the install section
 * (`app-builder-lib/templates/nsis/installSection.nsh:105-109`) before the
 * descriptor exists. Measured with an NSIS ordering probe: the file is absent at
 * relaunch time, and `.onInstSuccess` writes it immediately afterwards. The
 * relaunched instance's startup check therefore runs with `enabled() === false`
 * (`update-coordinator.ts:54`) and reports one spurious failure.
 *
 * Staging the same bytes into the package closes that window. The decision and
 * its rationale live in `./update-descriptor.mjs`, which is env-free and
 * unit-tested; this module only composes it, because importing *this* file from a
 * spec requires a full release environment (`DSH_DESKTOP_APP_ID` and friends) and
 * fails without one.
 *
 * Loading the upstream module (rather than re-implementing the config) is what
 * keeps this from drifting: a new upstream option appears here automatically.
 */

import { fileURLToPath } from 'node:url';
import upstream from '../../apps/desktop/electron-builder.config.mjs';
import { assertUpdateDescriptor, updateDescriptor, withUpdateDescriptor } from './update-descriptor.mjs';

const nsisInclude = fileURLToPath(new URL('./installer.nsh', import.meta.url));

assertUpdateDescriptor(updateDescriptor);

/** The upstream configuration with this product's installer script substituted. */
const config = {
  ...upstream,
  nsis: {
    ...(upstream.nsis ?? {}),
    include: nsisInclude,
  },
  extraResources: withUpdateDescriptor(upstream.extraResources),
};

export default config;

export { nsisInclude, updateDescriptor };
