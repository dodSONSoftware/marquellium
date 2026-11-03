#!/bin/sh
# Run only with an installed Developer ID identity and a Keychain notary profile.
set -eu
: "${MARQUELLIUM_SIGN_IDENTITY:?Set the installed Developer ID Application identity}"
: "${MARQUELLIUM_NOTARY_PROFILE:?Set an existing notarytool Keychain profile}"
app=${1:-src-tauri/target/release/bundle/macos/Marquellium.app}
[ -d "$app" ] || { echo 'Build the release app first' >&2; exit 2; }
security find-identity -v -p codesigning | rg -F -- "$MARQUELLIUM_SIGN_IDENTITY" >/dev/null || { echo 'Developer ID identity is unavailable' >&2; exit 2; }
codesign --force --deep --options runtime --timestamp --sign "$MARQUELLIUM_SIGN_IDENTITY" "$app"
codesign --verify --deep --strict --verbose=2 "$app"
archive="${app%.app}-notarization.zip"
ditto -c -k --keepParent "$app" "$archive"
xcrun notarytool submit "$archive" --keychain-profile "$MARQUELLIUM_NOTARY_PROFILE" --wait
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"
echo 'Re-create the distribution archive after stapling; retain verification output.'
