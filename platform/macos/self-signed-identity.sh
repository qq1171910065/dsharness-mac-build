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
# prefix is what makes macOS read the certificate as a code-signing identity.
# Note the split: the certificate carries the prefix, while
# `DSH_DESKTOP_MACOS_SIGNING_IDENTITY` must NOT
# (`desktop-release-environment.mjs:78-80` rejects the prefixed form).
common_name="Developer ID Application: ${name}"

openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
  -keyout "$work/key.pem" -out "$work/cert.pem" \
  -subj "/CN=${common_name}/O=DSH Development/C=US" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "subjectKeyIdentifier=hash" 2>/dev/null

# OpenSSL 3 writes a p12 that `security import` rejects unless -legacy is used
# (the PKCS#12 MAC algorithm changed in 3.0).
if ! openssl pkcs12 -export -legacy \
  -inkey "$work/key.pem" -in "$work/cert.pem" \
  -name "$common_name" -out "$link" -passout "pass:${password}" 2>/dev/null; then
  openssl pkcs12 -export \
    -inkey "$work/key.pem" -in "$work/cert.pem" \
    -name "$common_name" -out "$link" -passout "pass:${password}"
fi

# Prove the identity is usable before a twenty-minute build depends on it. This
# mirrors what `withMacOSSigningKeychain` does with its probe
# (`macos-signing-keychain.mjs:60-73`), and the order below is load-bearing:
# `create` -> `unlock` -> `import` -> `set-key-partition-list` -> search list.
# Skipping the partition list makes `codesign` report "The specified item could
# not be found in the keychain" even though `security import` said the identity
# was imported, because the private key stays inaccessible to the tool.
keychain="$work/check.keychain-db"
keychain_password="$(openssl rand -base64 32)"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$link" -k "$keychain" -P "$password" \
  -T /usr/bin/codesign -T /usr/bin/productbuild
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
# `codesign` resolves an identity only from a keychain that is also on the search
# list, and `--keychain` alone is not enough for that reason.
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')

cp /usr/bin/true "$work/probe"
codesign --force --sign "$common_name" --keychain "$keychain" --timestamp=none "$work/probe"
codesign --verify --strict "$work/probe"
# The signature must actually carry the CN the build will verify against, so the
# probe is inspected rather than trusted.
codesign --display --verbose=4 "$work/probe" 2>&1 | grep -F "Authority=${common_name}" >/dev/null

{
  echo "csc_link=$link"
  echo "csc_password=$password"
  echo "identity=$name"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
