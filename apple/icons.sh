#!/bin/sh
# Renders the app icons in App/Shared/Assets.xcassets from the SVGs in public/icons, so the web app,
# the PWA and the native apps share one source. macOS only (uses Quick Look and sips). Re-run after
# editing an SVG, then ./generate.sh.
#   iOS:   attest-maskable.svg, full bleed and opaque (iOS applies its own rounded mask).
#   macOS: attest-macos.svg, the squircle on Apple's grid with a margin and shadow.
set -e
cd "$(dirname "$0")"
SRC=../public/icons
OUT=App/Shared/Assets.xcassets/AppIcon.appiconset
TMP=$(mktemp -d)
trap 'rm -r "$TMP"' EXIT

qlmanage -t -s 1024 -o "$TMP" "$SRC/attest-maskable.svg" "$SRC/attest-macos.svg" >/dev/null 2>&1
[ -f "$TMP/attest-maskable.svg.png" ] && [ -f "$TMP/attest-macos.svg.png" ] || { echo "Quick Look did not render the SVGs" >&2; exit 1; }

# The App Store rejects iOS icons with an alpha channel: a round trip through JPEG drops it.
sips -s format jpeg -s formatOptions best "$TMP/attest-maskable.svg.png" --out "$TMP/ios.jpg" >/dev/null
sips -s format png "$TMP/ios.jpg" --out "$OUT/ios-1024.png" >/dev/null

for s in 16 32 64 128 256 512 1024; do
  sips -s format png -z $s $s "$TMP/attest-macos.svg.png" --out "$OUT/mac-$s.png" >/dev/null
done
echo "Icons written to $OUT"
