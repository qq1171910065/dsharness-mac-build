; Product NSIS customization for this fork -- the only installer change, and it
; lives outside every upstream file.
;
; electron-builder reads the custom include from `nsis.include`
; (`app-builder-lib/out/targets/nsis/NsisTarget.js:600`, default
; `buildResources/installer.nsh`). `platform/windows/electron-builder-config.mjs`
; loads the upstream configuration and replaces that one field, so this file
; substitutes for `apps/desktop/scripts/installer.nsh` at compile time without
; editing it.
;
; Because this file REPLACES the upstream include, it has to pull the upstream
; one in first -- otherwise the product's custom pages, staged-extract reporting
; and lifecycle hooks would silently disappear. The path is derived from
; `${__FILEDIR__}` (the directory of the file being preprocessed) rather than
; from wherever the file is copied to, so it keeps working from any staging
; directory.
;
; This file must stay pure ASCII: makensis reports "Bad text encoding" for a
; non-ASCII byte in a script without a BOM, and upstream's .nsh files are ASCII
; too.
!include "${__FILEDIR__}\..\..\apps\desktop\scripts\installer.nsh"

; ---------------------------------------------------------------------------
; Deployment layer, applied at install time.
;
; Why a fresh hook instead of upstream's `customInstall`: upstream defines
; `customInstall` as `!macro` in the file included above, and NSIS forbids
; redefining a macro -- a second definition is a compile error. `.onInstSuccess`
; is a stock NSIS callback and is defined by NOTHING upstream (the templates
; define `.onInit` and `.onGUIInit` only), so it is the free, documented place to
; run work after the application files are in place -- which is exactly the
; precondition the deployment needs.
;
; Why the payload is copied into the installation first: the deployment layer has
; to run on a machine that has never seen this repository and has no npm, so it
; runs under the Node runtime the application itself ships
; (`resources\runtime\primary-runtime\dependencies\node\bin\node.exe`, verified
; to be an ordinary Node). Keeping the payload next to the installed application
; also makes it re-runnable by hand, which is what the log line says when the
; layer fails.
;
; The payload is the product's own zero-dependency `platform/*.mjs`, assembled by
; `platform/build-deploy-payload.mjs` so that what runs here and what a
; development machine runs from `node platform/install.mjs` are the same code.
; ---------------------------------------------------------------------------
Function .onInstSuccess
  ; Per-user install: the Harness home is the installing user's.
  SetShellVarContext current

  DetailPrint "DSH Desktop: applying deployment layer"
  CreateDirectory "$INSTDIR\resources\installer-ui\dsharness"
  SetOutPath "$INSTDIR\resources\installer-ui\dsharness"
  File "${__FILEDIR__}\deploy\deploy-entry.mjs"
  File "${__FILEDIR__}\deploy\home.mjs"
  File "${__FILEDIR__}\deploy\provision.mjs"
  File "${__FILEDIR__}\deploy\install.mjs"
  File "${__FILEDIR__}\deploy\host-auth.mjs"
  File "${__FILEDIR__}\deploy\cordis.patch.yml"

  ; The application ships its own Node runtime, so no system Node is required.
  nsExec::ExecToLog '"$INSTDIR\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" "$INSTDIR\resources\installer-ui\dsharness\deploy-entry.mjs" "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    ; A failed deployment is reported but does not fail the install: the
    ; application still runs, it just talks to the upstream account service
    ; until the layer is reapplied. Silently succeeding would be worse, so the
    ; result code reaches the install log and the detail view.
    DetailPrint "DSH Desktop: deployment layer exited with $0"
  ${Else}
    DetailPrint "DSH Desktop: deployment layer applied"
  ${EndIf}
FunctionEnd
