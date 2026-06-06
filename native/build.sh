#!/bin/bash
# Compile the Objective-C app into AirPlayCaster.app.
# We use clang/Obj-C (not Swift) to avoid the Swift compiler/SDK version mismatch
# present in some Command Line Tools installs.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/AirPlayCaster.app"

echo "→ Compilando AirPlayCaster.app …"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"

clang -fobjc-arc -O2 \
  -framework Cocoa -framework AVKit -framework AVFoundation -framework CoreMedia \
  -o "$APP/Contents/MacOS/AirPlayCaster" \
  "$DIR/Sources/main.m"

# Ad-hoc sign so Gatekeeper and Local Network privacy behave for a locally built app.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || \
  echo "  (aviso: no se pudo firmar ad-hoc; debería funcionar igual en local)"

echo "✓ Listo: $APP"
