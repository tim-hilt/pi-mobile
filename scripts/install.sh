#!/usr/bin/env bash
# Usage: scripts/install.sh <device-name>
# Builds PiClient and installs it on a connected device.
set -euo pipefail

config=Release
device="${1:?usage: $0 <device-name>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
build="$root/ios/build"

cd "$root/ios"
xcodebuild build -project PiMobile.xcodeproj -scheme PiMobile -configuration "$config" \
  -destination "platform=iOS,name=$device" -derivedDataPath "$build" -allowProvisioningUpdates

xcrun devicectl device install app --device "$device" \
  "$build/Build/Products/$config-iphoneos/PiMobile.app"
xcrun devicectl device process launch --device "$device" dev.timhilt.PiMobile
