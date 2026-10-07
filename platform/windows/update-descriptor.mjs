/**
 * The unsigned update descriptor, as an `extraResources` contribution.
 *
 * ## Why this is its own module
 *
 * `electron-builder-config.mjs` cannot be imported by a unit test: it loads the
 * upstream configuration, which reads `DSH_DESKTOP_APP_ID` and friends through
 * `resolveDesktopAppId()` (`apps/desktop/scripts/desktop-release-environment.mjs:64`)
 * and throws without a release environment. Measured: importing it from a spec
 * fails with `desktop release environment: DSH_DESKTOP_APP_ID must be set to a
 * non-empty value`.
 *
 * So the one decision that *is* testable — which resource to add, and that
 * upstream's entries survive — lives here, env-free, and the configuration module
 * is a thin composition on top.
 *
 * ## Why the descriptor is staged into the packaged resources at all
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
 * Staging the same bytes into the package closes that window — the file is
 * present before the installer runs, and `File` in the include merely overwrites
 * it with an identical copy. Both mechanisms are deliberate: `extraResources`
 * covers the relaunch, and the include keeps the file correct for any installer
 * run whose resources did not come from this configuration.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Absolute path of the descriptor embedded by this product's builds. */
export const updateDescriptor = fileURLToPath(new URL('./app-update.yml', import.meta.url));

/**
 * Append the update descriptor to an electron-builder `extraResources` list.
 *
 * Appended, never replacing: upstream's entries carry the bundled Node runtime,
 * the application icon and the Windows tray bitmap, and dropping one of them
 * breaks the packaged application in a way that only shows up after install.
 *
 * @param extraResources - upstream's `extraResources`, or undefined when it declares none.
 * @returns a new list; the input is not modified.
 */
export function withUpdateDescriptor(extraResources) {
  if (Array.isArray(extraResources) && extraResources.some((entry) => entry !== null
    && typeof entry === 'object' && entry.to === 'app-update.yml')) {
    // Already contributed (a double composition, or upstream shipping its own
    // descriptor for a signed build): do not add a second entry for one target.
    return [...extraResources];
  }
  return [...(extraResources ?? []), { from: updateDescriptor, to: 'app-update.yml' }];
}

/**
 * Fail loudly when the descriptor is missing.
 *
 * A build that staged nothing would produce an installer whose app-update.yml
 * comes only from `.onInstSuccess` — that is, one that cannot update itself
 * immediately after restarting into the new version. Silent is the wrong default
 * for a fact this cheap to check.
 *
 * @param path - the descriptor path to verify.
 */
export function assertUpdateDescriptor(path = updateDescriptor) {
  if (!existsSync(path)) {
    throw new Error(`desktop build: missing ${path}; the packaged updater would have no feed descriptor`);
  }
}
