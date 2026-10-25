#!/usr/bin/env bash
# Builds a self-contained Linux server tarball: bundled JS + native modules + a Node runtime.
#   scripts/package-server.sh            -> release/opencord-server-<version>-linux-<arch>.tar.gz
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/packages/server/package.json').version")"
ARCH="$(node -p 'process.arch')"
NAME="opencord-server-$VERSION-linux-$ARCH"
OUT="$ROOT/release/$NAME"

rm -rf "$OUT" && mkdir -p "$OUT"
(cd "$ROOT/packages/server" && node build.mjs >/dev/null)
cp "$ROOT/packages/server/dist/opencord-server.mjs" "$OUT/"

# The web app (for phones and browsers) is served by the server from ./web.
(cd "$ROOT/packages/client" && npx electron-vite build >/dev/null)
cp -r "$ROOT/packages/client/out/renderer" "$OUT/web"

# Only the native dependencies need to be installed next to the bundle.
node -e "
const p = require('$ROOT/packages/server/package.json');
const pick = ['better-sqlite3', '@node-rs/argon2', 'mediasoup'];
const deps = Object.fromEntries(pick.map((k) => [k, p.dependencies[k]]));
require('fs').writeFileSync('$OUT/package.json', JSON.stringify({ name: 'opencord-server', version: p.version, private: true, type: 'module', dependencies: deps }, null, 2));
"
(cd "$OUT" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

# Bundle the Node runtime this script runs with, so the target machine needs nothing installed.
cp "$(command -v node)" "$OUT/node"
cat > "$OUT/opencord-server" <<'SH'
#!/bin/sh
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
exec "$DIR/node" "$DIR/opencord-server.mjs" "$@"
SH
chmod +x "$OUT/opencord-server" "$OUT/node"
cp "$ROOT/packaging/systemd/opencord-server.service" "$OUT/"
cp "$ROOT/packaging/install-server.sh" "$OUT/install.sh"
cp "$ROOT/docs/self-hosting.md" "$OUT/README.md"

(cd "$ROOT/release" && tar -czf "$NAME.tar.gz" "$NAME")
echo "Created release/$NAME.tar.gz"
