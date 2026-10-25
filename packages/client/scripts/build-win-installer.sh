#!/usr/bin/env bash
# Builds release/OpenCord-Setup-<version>.exe on Linux without Wine. electron-builder's own NSIS
# target needs Wine to generate its uninstaller; this compiles build/installer.nsi with the native
# Linux makensis that electron-builder already downloads.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")

npx electron-vite build
npx electron-builder --win dir --x64

MAKENSIS=$(find "${ELECTRON_BUILDER_CACHE:-$HOME/.cache/electron-builder}" -path '*/linux/makensis' | head -n1)
if [ -z "$MAKENSIS" ]; then
  # Fetch the NSIS bundle by letting electron-builder start an NSIS build; it fails at the Wine step.
  npx electron-builder --win nsis --x64 --prepackaged release/win-unpacked >/dev/null 2>&1 || true
  MAKENSIS=$(find "${ELECTRON_BUILDER_CACHE:-$HOME/.cache/electron-builder}" -path '*/linux/makensis' | head -n1)
fi
[ -n "$MAKENSIS" ] || { echo "makensis not found" >&2; exit 1; }
chmod +x "$MAKENSIS"
export NSISDIR="$(dirname "$(dirname "$MAKENSIS")")"

python3 - <<'EOF'
from PIL import Image
Image.open('build/icon.png').save('release/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
EOF

"$MAKENSIS" -V2 \
  -DVERSION="$VERSION" \
  -DSRC="$PWD/release/win-unpacked" \
  -DICON="$PWD/release/icon.ico" \
  -DLICENSE="$PWD/../../LICENSE" \
  -DOUTFILE="$PWD/release/OpenCord-Setup-$VERSION.exe" \
  build/installer.nsi

echo "Built release/OpenCord-Setup-$VERSION.exe"
