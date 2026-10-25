#!/usr/bin/env bash
# Builds an Android APK for your OpenCord server's web app, as a Trusted Web Activity (TWA):
# a small native shell that opens your server's web app full-screen with its own icon.
#
#   scripts/build-android.sh https://chat.example.com [package.id]
#
# Requirements: Node 22+. Bubblewrap downloads a JDK and the Android SDK on first run (~1 GB)
# and asks you to accept the Android SDK license. The server must be reachable over HTTPS.
#
# Output (in android-build/): app-release-signed.apk and the signing key. Then:
#   1. copy the APK next to config.toml and set [web] android_apk = "OpenCord.apk"
#   2. set [web] android_sha256 to the fingerprint printed at the end
#   3. restart the server — the web app now offers the APK on Android
set -euo pipefail
HOST="${1:?usage: build-android.sh https://your.host [package.id]}"
HOST="${HOST%/}"
PACKAGE="${2:-org.opencord.app}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/android-build"
mkdir -p "$OUT"
cd "$OUT"

DOMAIN="$(node -p "new URL('$HOST').host")"
NAME="$(curl -fsSL "$HOST/api/v1/instance" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).name" 2>/dev/null || echo OpenCord)"
KEYSTORE="$OUT/android.keystore"
KEY_ALIAS="opencord"
if [ ! -f "$KEYSTORE" ]; then
  read -r -s -p "New keystore password (keep it safe, you need it for updates): " STOREPASS; echo
  keytool -genkeypair -v -keystore "$KEYSTORE" -alias "$KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$STOREPASS" -keypass "$STOREPASS" -dname "CN=$NAME, O=OpenCord"
else
  read -r -s -p "Keystore password: " STOREPASS; echo
fi

cat > twa-manifest.json <<JSON
{
  "packageId": "$PACKAGE",
  "host": "$DOMAIN",
  "name": "$NAME",
  "launcherName": "OpenCord",
  "display": "standalone",
  "themeColor": "#121214",
  "navigationColor": "#121214",
  "backgroundColor": "#121214",
  "enableNotifications": true,
  "startUrl": "/",
  "iconUrl": "$HOST/icon-512.png",
  "maskableIconUrl": "$HOST/icon-maskable.png",
  "webManifestUrl": "$HOST/manifest.webmanifest",
  "signingKey": { "path": "$KEYSTORE", "alias": "$KEY_ALIAS" },
  "appVersionName": "$(node -p "require('$ROOT/packages/client/package.json').version")",
  "appVersionCode": $(date +%s | cut -c1-9),
  "generatorApp": "opencord-build-android",
  "fallbackType": "customtabs",
  "enableSiteSettingsShortcut": false,
  "orientation": "default"
}
JSON

BUBBLEWRAP_KEYSTORE_PASSWORD="$STOREPASS" BUBBLEWRAP_KEY_PASSWORD="$STOREPASS" npx --yes @bubblewrap/cli@1.24.1 update --skipVersionUpgrade
BUBBLEWRAP_KEYSTORE_PASSWORD="$STOREPASS" BUBBLEWRAP_KEY_PASSWORD="$STOREPASS" npx --yes @bubblewrap/cli@1.24.1 build --skipPwaValidation

cp app-release-signed.apk "$OUT/OpenCord.apk"
FP="$(keytool -list -v -keystore "$KEYSTORE" -alias "$KEY_ALIAS" -storepass "$STOREPASS" | awk '/SHA256:/ {print $2; exit}')"
echo
echo "Built $OUT/OpenCord.apk"
echo "Add to config.toml:"
echo "  [web]"
echo "  android_apk = \"OpenCord.apk\"   # after copying the APK next to config.toml"
echo "  android_package = \"$PACKAGE\""
echo "  android_sha256 = \"$FP\""
