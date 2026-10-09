#!/bin/bash
# Create a throwaway self-signed code-signing identity.
#
# ## This does NOT unblock macOS packaging
#
# It was written to get past the unconditional signing in
# `apps/desktop/scripts/prepare-dsh.ts:156`, and it does not, because the build
# verifies what it signed (`macos-runtime.ts:57`) against three fields
# (`verify-macos-signature.mjs:16,17,33`):
#
#   Authority=Developer ID Application: <name>   satisfiable by setting the CN
#   TeamIdentifier=<id>                          needs an Apple-issued certificate
#   Timestamp=<secure timestamp>                 needs Apple's timestamp authority
#
# The last two cannot be produced locally: a self-signed issuer cannot assign a
# team, and Apple's TSA only countersigns genuine Developer ID signatures.
# A real `Developer ID Application` certificate is the only way through.
#
# What it is still good for: producing the keychain-shaped environment
# (`CSC_LINK` p12 + password) that upstream's `withMacOSSigningKeychain`
# consumes, for inspecting how far preparation gets before verification rejects
# the signature.
#
# Environment:
#   DSH_MACOS_SIGNING_NAME  common name to generate (default: DSH Local Signing)
#   DSH_MACOS_CSC_LINK      output path for the p12 that becomes CSC_LINK
#   DSH_MACOS_CSC_PASSWORD  password for that p12
#
# Writes `csc_link`, `csc_password`, `identity` to $GITHUB_OUTPUT.

set -euo pipefail

name="${DSH_MACOS_SIGNING_NAME:-DSH Local Signing}"
link="${DSH_MACOS_CSC_LINK:?DSH_MACOS_CSC_LINK must name the output p12 path}"
password="${DSH_MACOS_CSC_PASSWORD:?DSH_MACOS_CSC_PASSWORD must be set}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# `codesign` matches the full `Developer ID Application: <name>` string, and that
# prefix is what macOS reads as the identity name. Note the split: the certificate
# carries the prefix, while `DSH_DESKTOP_MACOS_SIGNING_IDENTITY` must NOT
# (`desktop-release-environment.mjs:78-80` rejects the prefixed form).
common_name="Developer ID Application: ${name}"

# Apple marks a certificate as usable for code signing with its own extension
# OID. `extendedKeyUsage=codeSigning` is the standard X.509 counterpart and is
# NOT sufficient: without Apple's OID, Security.framework does not expose the
# certificate through `find-identity -p codesigning`, and `codesign` then reports
# "The specified item could not be found in the keychain" even though
# `security import` succeeded. This is why the probe failed while every preceding
# step reported success.
APPLE_CODE_SIGNING_OID="1.2.840.113635.100.6.1.13"

openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
  -keyout "$work/key.pem" -out "$work/cert.pem" \
  -subj "/CN=${common_name}/O=DSH Development/C=US" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "subjectKeyIdentifier=hash" \
  -addext "${APPLE_CODE_SIGNING_OID}=DER:05:00"

# OpenSSL 3 writes a p12 that `security import` rejects unless -legacy is used
# (the PKCS#12 MAC algorithm changed in 3.0).
if ! openssl pkcs12 -export -legacy \
  -inkey "$work/key.pem" -in "$work/cert.pem" \
  -name "$common_name" -out "$link" -passout "pass:${password}" 2>/dev/null; then
  openssl pkcs12 -export \
    -inkey "$work/key.pem" -in "$work/cert.pem" \
    -name "$common_name" -out "$link" -passout "pass:${password}"
fi

# Prove the identity is usable before a twenty-minute build depends on it. The
# command sequence is copied from `macos-signing-keychain.mjs:60-73` rather than
# approximated, because the deviations each fail differently:
#
#   - `set-key-partition-list` must come after `import` (before it, the key stays
#     inaccessible and codesign reports "The specified item could not be found in
#     the keychain" even though `security import` printed success).
#   - the keychain must be on the search list: codesign ignores `--keychain`
#     otherwise (`macos-signing-keychain.mjs:66-67`).
#   - the probe must be signed with `--options runtime`, matching what
#     `assertMacOSRuntimeSignatureDetails` requires of the real runtime
#     (`verify-macos-signature.mjs:36`). Signing without it "succeeds" here and
#     proves nothing about the build that follows.
#   - `--timestamp` is requested as upstream does. A self-signed certificate
#     cannot obtain one, so this step IS expected to fail, and that failure is
#     the finding: without an Apple-issued identity the runtime cannot carry the
#     `Timestamp` the build requires, two steps before the build would discover
#     it the expensive way.
keychain="$work/check.keychain-db"
keychain_password="$(openssl rand -base64 32)"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
# A self-signed certificate is its own root and macOS does not trust it, so it is
# never exposed as a code-signing identity: `find-identity -v -p codesigning`
# reports "0 valid identities found" and `codesign` then says "The specified item
# could not be found in the keychain", even though `security import` succeeded and
# the certificate carries the Apple code-signing OID. A real Developer ID needs
# none of this because it chains to Apple's CA. Trust has to be granted to the
# certificate file before the identity becomes usable.
security add-trusted-cert -d -r trustRoot -p codeSign -k "$keychain" "$work/cert.pem"
security import "$link" -k "$keychain" -P "$password" \
  -T /usr/bin/codesign -T /usr/bin/productbuild -A
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')

cp /usr/bin/true "$work/probe"
# A timestamp request to Apple's TSA can stall indefinitely for a certificate
# Apple never issued. Bound every Apple-touching command so this step fails fast
# instead of occupying the job, and so a hang is distinguishable from a reject.
# `timeout` cannot run `security` here (it needs the keychain unlocked in-process),
# so only the network-bound signing call is bounded.
timeout_seconds="${DSH_MACOS_SIGN_TIMEOUT_SECONDS:-120}"
# Assert the identity is actually registered before signing with it. This is the
# check whose absence cost several runs: `security import` reporting success and
# an identity existing are different facts.
if ! security find-identity -v -p codesigning "$keychain" | grep -qF "$common_name"; then
  echo "self-signed-identity: the certificate is not registered as a code-signing identity" >&2
  security find-identity -v -p codesigning "$keychain" >&2 || true
  exit 1
fi
# Report exactly which command fails. `security import` succeeding is not
# evidence that a usable identity exists, and the candidate failures below have
# different fixes. Without this the only visible line is the last error.
report() {
  echo "self-signed-identity: step failed: $*" >&2
  echo "--- identities visible in the keychain ---" >&2
  security find-identity -v -p codesigning "$keychain" >&2 || true
  echo "--- all identities ---" >&2
  security find-identity -v "$keychain" >&2 || true
}
trap 'report "$BASH_COMMAND" || true' ERR

codesign --force --sign "$common_name" --keychain "$keychain" \
  --timestamp --options runtime "$work/probe" &
sign_pid=$!
( sleep "$timeout_seconds"; kill -TERM "$sign_pid" 2>/dev/null ) &
watchdog=$!
if wait "$sign_pid"; then
  kill "$watchdog" 2>/dev/null
else
  status=$?
  kill "$watchdog" 2>/dev/null
  echo "self-signed-identity: codesign --timestamp failed after ${timeout_seconds}s (status ${status})" >&2
  echo "  Apple's timestamp authority does not countersign a certificate it did not issue;" >&2
  echo "  the build requires a secure timestamp, so an Apple-issued Developer ID is mandatory." >&2
  exit 1
fi
codesign --verify --strict "$work/probe"
# The signature must actually carry the CN the build will verify against, so the
# probe is inspected rather than trusted.
codesign --display --verbose=4 "$work/probe" 2>&1 | grep -F "Authority=${common_name}" >/dev/null
# The build additionally requires a secure timestamp
# (`verify-macos-signature.mjs:33`), which only Apple's timestamp authority can
# countersign. Check for it explicitly: a self-signed certificate yields a
# signature without one, and this is the field that decides whether packaging can
# ever succeed here.
if ! codesign --display --verbose=4 "$work/probe" 2>&1 | grep -q '^Timestamp='; then
  echo "self-signed-identity: the signature has no secure timestamp (Apple's TSA only countersigns Developer ID signatures)" >&2
  exit 1
fi

{
  echo "csc_link=$link"
  echo "csc_password=$password"
  echo "identity=$name"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
