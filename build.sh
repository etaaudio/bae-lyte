#!/bin/sh
# Builds dist/lyte-chrome.zip and dist/lyte-firefox.zip, and dist/lyte-safari.zip on a Mac with Xcode.
# Each browser gets only the manifest keys it uses, so none of them warns about the others'.
set -eu
cd "$(dirname "$0")"
FILES="background.js bridge.js page.js popup.html popup.js icons LICENSE PRIVACY.md README.md"
rm -rf dist && mkdir dist

pack() { # pack <browser> <jq filter applied to manifest.json>
  mkdir "dist/$1"
  cp -R $FILES "dist/$1/"
  jq "$2" manifest.json > "dist/$1/manifest.json"
  (cd "dist/$1" && zip -qrX "../lyte-$1.zip" .)
}
pack chrome  'del(.background.scripts, .browser_specific_settings)'
pack firefox 'del(.background.service_worker, .minimum_chrome_version)'

# ponytail: ad-hoc signed (runs with Safari's Allow Unsigned Extensions); use a real identity once the Apple developer account is ready
if xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  pack safari '.'
  xcrun safari-web-extension-converter dist/safari --project-location dist/xcode \
    --app-name BAELyte --bundle-identifier com.etaaudio.BAELyte --macos-only --no-open --no-prompt --force
  xcodebuild -quiet -project dist/xcode/BAELyte/BAELyte.xcodeproj -scheme BAELyte -configuration Release \
    -derivedDataPath dist/derived CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
  app=dist/derived/Build/Products/Release/BAELyte.app
  codesign --verify --deep --strict "$app"
  codesign -d --entitlements - "$app/Contents/PlugIns/BAELyte Extension.appex" | grep -q app-sandbox
  rm dist/lyte-safari.zip
  ditto -c -k --keepParent "$app" dist/lyte-safari.zip
fi
ls -l dist/*.zip
