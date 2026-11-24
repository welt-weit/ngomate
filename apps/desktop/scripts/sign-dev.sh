#!/bin/sh
# Cargo runs this in place of each macOS build it starts (see src-tauri/.cargo/config.toml).
#
# A plain build is signed ad hoc, so the keychain sees every rebuild as a new app and asks again for
# each saved key. With NGOMATE_DEV_SIGNING_IDENTITY set to one of your code signing certificates
# (`security find-identity -v -p codesigning` lists them), the build is signed with it under one fixed
# identifier, so "Always Allow" holds across rebuilds. Without it, the build starts as it is.
set -e
if [ -n "$NGOMATE_DEV_SIGNING_IDENTITY" ]; then
	codesign --force --sign "$NGOMATE_DEV_SIGNING_IDENTITY" --identifier org.ngomate.desktop.dev --timestamp=none "$1" 2>/dev/null ||
		echo "Could not sign $1 with \"$NGOMATE_DEV_SIGNING_IDENTITY\"; the keychain will ask again." >&2
fi
exec "$@"
