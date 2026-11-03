#!/usr/bin/env bash
# Usage: scripts/ipa.sh
# Builds an unsigned PiClient IPA for sideloading (SideStore resigns it on-device).
set -euo pipefail

config=Release
root="$(cd "$(dirname "$0")/.." && pwd)"
build="$root/ios/build"
product="$build/Build/Products/$config-iphoneos/PiMobile.app"

cd "$root/ios"
xcodebuild build -quiet -project PiMobile.xcodeproj -scheme PiMobile -configuration "$config" \
  -destination 'generic/platform=iOS' -derivedDataPath "$build" CODE_SIGNING_ALLOWED=NO

rm -rf "$build/Payload" "$build/PiMobile.ipa"
mkdir -p "$build/Payload"
cp -R "$product" "$build/Payload/"
cd "$build" && zip -qry PiMobile.ipa Payload
echo "$build/PiMobile.ipa"
