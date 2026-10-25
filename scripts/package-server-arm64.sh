#!/usr/bin/env bash
# Builds a self-contained Linux ARM64 (aarch64) server tarball, including a Node runtime and
# native modules. It can run on any host (x64 or arm64): better-sqlite3 and mediasoup ship
# prebuilt arm64 binaries that are downloaded directly, so no cross-compiler, Docker, or QEMU is
# required.
#   scripts/package-server-arm64.sh -> release/opencord-server-<version>-linux-arm64.tar.gz
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/packages/server/package.json').version")"
ARCH="${TARGET_ARCH:-arm64}"
# Keep the runtime on the same major as the build host so better-sqlite3's ABI prebuild matches.
NODE_VERSION="${NODE_VERSION:-$(node -p 'process.version')}"
# mediasoup publishes a prebuilt worker per libc/kernel era (kernel6 or kernel7). Default to the
# broadly-compatible kernel6; override with MEDIASOUP_KERNEL=7 for very recent distros.
MS_KERNEL="${MEDIASOUP_KERNEL:-6}"
NAME="opencord-server-$VERSION-linux-$ARCH"
OUT="$ROOT/release/$NAME"
CACHE="$ROOT/.cache/arm64"

rm -rf "$OUT" && mkdir -p "$OUT" "$CACHE"

# 1. The JS bundle is platform-neutral (esbuild target node22).
(cd "$ROOT/packages/server" && node build.mjs >/dev/null)
cp "$ROOT/packages/server/dist/opencord-server.mjs" "$OUT/"

# The web app (for phones and browsers) is served by the server from ./web.
(cd "$ROOT/packages/client" && npx electron-vite build >/dev/null)
cp -r "$ROOT/packages/client/out/renderer" "$OUT/web"

# 2. Native dependencies, installed for linux-arm64. better-sqlite3's install script
#    (prebuild-install) honours npm_config_arch and downloads the arm64 prebuild. MEDIASOUP_WORKER_BIN
#    makes mediasoup skip its own (host-arch) worker download; we fetch the arm64 worker below.
node -e "
const p = require('$ROOT/packages/server/package.json');
const pick = ['better-sqlite3', '@node-rs/argon2', 'mediasoup'];
const deps = Object.fromEntries(pick.map((k) => [k, p.dependencies[k]]));
require('fs').writeFileSync('$OUT/package.json', JSON.stringify({ name: 'opencord-server', version: p.version, private: true, type: 'module', dependencies: deps }, null, 2));
"
(cd "$OUT" && MEDIASOUP_WORKER_BIN=/dev/null npm_config_arch="$ARCH" npm_config_platform=linux \
  npm install --omit=dev --no-audit --no-fund --loglevel=error)

# @node-rs/argon2 ships its binary in a per-platform package, but npm only installs the host
# arch's one. Add the arm64 packages explicitly, then drop the host-arch leftovers.
ARGON2_VERSION="$(node -p "require('$OUT/node_modules/@node-rs/argon2/package.json').version")"
# --force bypasses npm's host os/arch check for the arm64 packages (EBADPLATFORM).
(cd "$OUT" && npm install --force --omit=dev --no-audit --no-fund --loglevel=error --no-save \
  "@node-rs/argon2-linux-arm64-gnu@$ARGON2_VERSION" "@node-rs/argon2-linux-arm64-musl@$ARGON2_VERSION")
rm -rf "$OUT/node_modules/@node-rs/argon2-linux-x64-gnu" "$OUT/node_modules/@node-rs/argon2-linux-x64-musl"

# 3. mediasoup-worker: fetch the arm64 prebuilt binary and place it where mediasoup expects it.
MS_VERSION="$(node -p "require('$OUT/node_modules/mediasoup/package.json').version")"
MS_WORKER="$OUT/node_modules/mediasoup/worker/out/Release/mediasoup-worker"
mkdir -p "$(dirname "$MS_WORKER")"
echo "Downloading mediasoup-worker $MS_VERSION linux-arm64 (kernel$MS_KERNEL)..."
curl -fsSL "https://github.com/versatica/mediasoup/releases/download/$MS_VERSION/mediasoup-worker-$MS_VERSION-linux-arm64-kernel$MS_KERNEL.tgz" \
  | tar -xzf - -C "$(dirname "$MS_WORKER")" mediasoup-worker
chmod +x "$MS_WORKER"

# 4. Bundle an arm64 Node runtime so the target machine needs nothing installed.
NODE_ARCHIVE="$CACHE/node-$NODE_VERSION-linux-arm64.tar.xz"
if [ ! -f "$NODE_ARCHIVE" ]; then
  echo "Downloading $NODE_VERSION linux-arm64 runtime..."
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-arm64.tar.xz" -o "$NODE_ARCHIVE"
fi
tar -xJf "$NODE_ARCHIVE" -C "$CACHE"
cp "$CACHE/node-$NODE_VERSION-linux-arm64/bin/node" "$OUT/node"

# 5. Launcher shim + install assets (same as the native package).
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
