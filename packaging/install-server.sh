#!/usr/bin/env bash
# Installs this OpenCord server build as a systemd service. Run as root from the extracted folder.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Please run as root (sudo ./install.sh)"; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"

id opencord >/dev/null 2>&1 || useradd --system --home /var/lib/opencord --shell /usr/sbin/nologin opencord
mkdir -p /opt/opencord-server /etc/opencord /var/lib/opencord
cp -a "$SRC/." /opt/opencord-server/
ln -sf /opt/opencord-server/opencord-server /usr/local/bin/opencord-server

if [ ! -f /etc/opencord/config.toml ]; then
  /opt/opencord-server/opencord-server init --config /etc/opencord/config.toml >/dev/null
  sed -i 's|^data_dir = .*|data_dir = "/var/lib/opencord"|' /etc/opencord/config.toml
fi
chown -R opencord:opencord /var/lib/opencord /etc/opencord

cp /opt/opencord-server/opencord-server.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now opencord-server
echo
echo "OpenCord is running. Config: /etc/opencord/config.toml"
echo "Manage it with: sudo -u opencord opencord-server <command> --config /etc/opencord/config.toml"
