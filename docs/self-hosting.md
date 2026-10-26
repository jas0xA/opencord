# Self-hosting the OpenCord server

The server is a single Node.js process with an embedded SQLite database. Uploaded files are stored on disk next to the database. Out of the box it also:

- serves the **web app** at `/`, so phones and browsers can use OpenCord without installing anything ([web & mobile](web-and-mobile.md))
- joins the **global OpenCord network**, so usernames are unique everywhere and people can be friends, chat and call across hosts ([global network](global-network.md))

See also: [accounts & moderation](accounts-and-moderation.md) · [themes](themes.md) · [webhooks](webhooks.md).

## Quick start (Linux tarball)

Download the server for your machine from the [releases page](https://github.com/jas0xA/opencord/releases): `linux-x64` for regular PCs and servers, `linux-arm64` for Raspberry Pi 4/5 (64-bit OS) and other ARM64 machines.

```sh
tar xzf opencord-server-<version>-linux-<arch>.tar.gz
cd opencord-server-<version>-linux-<arch>
./opencord-server            # writes ./config.toml on first run, then starts on port 8443
```

The tarball ships its own Node runtime, so nothing else needs to be installed.

### Run it as a service (systemd)

```sh
sudo ./install.sh
```

This installs to `/opt/opencord-server`, writes `/etc/opencord/config.toml`, stores data in `/var/lib/opencord`, and enables the `opencord-server` service:

```sh
sudo systemctl status opencord-server
sudo journalctl -u opencord-server -f
```

### Docker (x86-64 and ARM64)

Every release publishes a multi-architecture image, `ghcr.io/jas0xa/opencord`, for `linux/amd64` and `linux/arm64` (Raspberry Pi 4/5 with a 64-bit OS, Ampere/Graviton servers, Apple Silicon). Docker picks the right one automatically.

```sh
curl -O https://raw.githubusercontent.com/jas0xA/opencord/main/docker-compose.yml
# edit OPENCORD_PUBLIC_URL in docker-compose.yml
docker compose up -d
```

Then open the public URL in a browser (or connect from the desktop app). The first account becomes the admin.

The container keeps `config.toml`, the database, uploads and the host key in the `opencord-data` volume (`/data` inside the container). The environment variables in `docker-compose.yml` override `config.toml`, so most setups never need to edit it:

| Variable | Overrides |
|---|---|
| `OPENCORD_PUBLIC_URL` | `server.public_url` |
| `OPENCORD_TRUST_PROXY` | `server.trust_proxy` |
| `OPENCORD_ANNOUNCED_IP` | `sfu.announced_ip` |
| `OPENCORD_RTC_MIN_PORT`, `OPENCORD_RTC_MAX_PORT` | `sfu.rtc_min_port` / `rtc_max_port` (image default `40000`–`40100`, matching the published ports) |
| `OPENCORD_FEDERATION`, `OPENCORD_HELP_HOST`, `OPENCORD_SEEDS` | `[federation]` (`SEEDS` is comma-separated) |
| `OPENCORD_UPDATE_CHECK` | `updates.check` |
| `OPENCORD_TLS_AUTO`, `OPENCORD_TLS_EMAIL` | `tls.auto`, `tls.email` ([automatic HTTPS](#automatic-https-works-with-just-an-ip-address)) |
| `OPENCORD_HTTP_PORT`, `OPENCORD_ACME_DIRECTORY` | `tls.http_port` (image default `8080`), `tls.acme_directory` |
| `OPENCORD_PORT`, `OPENCORD_HOST`, `OPENCORD_DATA_DIR` | listen port, address, data directory |

If you widen the media port range, change both the variables and the `ports:` mapping.

#### Updating

```sh
docker compose pull && docker compose up -d
```

That's it: data and config live in the volume, and database migrations run automatically on start. The Server Admin page shows when a new version is out (and this command). To roll back or stay on a version, pin the tag, e.g. `image: ghcr.io/jas0xa/opencord:0.1.0`.

**Automatic updates:** start with the `autoupdate` profile and [Watchtower](https://containrrr.dev/watchtower/) checks for a new image every night at 04:00 and restarts OpenCord with it:

```sh
docker compose --profile autoupdate up -d
```

#### Other Docker commands

```sh
docker compose logs -f opencord                                    # logs
docker compose exec opencord node /app/opencord-server.mjs users   # any admin CLI command
docker compose exec opencord node /app/opencord-server.mjs backup /data/backup.db
docker build -t opencord-server .                                  # build the image yourself
```

## Connecting

- **Desktop app:** enter the server's domain or IP address on the welcome screen, e.g. `chat.example.com`, `192.168.1.20` or `203.0.113.5:8443`. The client tries HTTPS and HTTP, and port 8443 when no port is given.
- **Browser / phone:** open the server's address in a browser, e.g. `https://chat.example.com`. On iOS tap *Share → Add to Home Screen*; on Android use *Install* or the APK button ([details](web-and-mobile.md)).
- **Another host's account:** people with an account on another OpenCord host can join your global servers without registering here; they're signed in with their home account ([details](global-network.md#visiting-other-hosts)).

**The first account registered becomes the instance admin.** Admins get a **Server Admin** page in the app, under User Settings and in the home sidebar.

## Configuration (`config.toml`)

All settings have defaults, so you only need to change what you care about. Settings marked *(live)* reload automatically when you save the file.

| Section | Key | Default | Meaning |
|---|---|---|---|
| `server` | `host` | `0.0.0.0` | Interface to listen on |
| | `port` | `8443` | TCP port |
| | `public_url` | `""` | External URL, used in emails and links |
| | `trust_proxy` | `false` | Set to `true` behind nginx/Caddy |
| `tls` | `auto` | `false` | Get and renew a free Let's Encrypt certificate for `public_url`, a domain **or a bare IP** ([details](#automatic-https-works-with-just-an-ip-address)) |
| | `email` | `""` | Optional contact for certificate notices |
| | `http_port` | `80` | Plain-HTTP port for certificate checks and the redirect to HTTPS |
| | `acme_directory` | Let's Encrypt | ACME server (use `https://acme-staging-v02.api.letsencrypt.org/directory` to test) |
| | `enabled`, `cert`, `key` | off | Serve HTTPS with your own certificate files |
| `instance` | `name`, `description` | | Shown on the login screen *(live)* |
| | `admin_emails` | `[]` | These emails become admins when they register |
| `registration` | `mode` | `open` | `open`, `invite_only`, `allowlist` or `closed` *(live)* |
| | `require_email_verification` | `false` | Needs `[smtp]` |
| | `min_password_length` | `8` | Minimum 8; passwords also need a letter and a number ([rules](accounts-and-moderation.md#password-rules)) |
| | `max_accounts_per_email` | `5` | How many accounts one email may own |
| `smtp` | `enabled`, `host`, `port`, `secure`, `user`, `pass`, `from` | off | Used for email verification and password resets |
| `storage` | `data_dir` | `./data` | Database and uploads |
| | `max_upload_mb` | `500` | Largest file a message can carry, up to 500 MB *(live, also in Server Admin → Storage)* |
| | `max_storage_gb` | `0` | Total space OpenCord may use (database + uploads); `0` = no limit. See [Storage limit](#storage-limit) *(live, also in Server Admin → Storage)* |
| | `max_avatar_mb`, `max_emoji_kb` | 8 / 512 | |
| `limits` | `max_guilds_per_user`, `max_members_per_guild`, `max_message_length`, `messages_per_10s`, `max_group_dm_size` | | *(live)* |
| `marketplace` | `community_enabled` | `true` | Let users publish their own cosmetics *(live)* |
| | `require_approval` | `false` | Admins approve community items before they are listed *(live)* |
| | `max_item_mb` | `5` | |
| `voice` | `stun` | Google STUN | Legacy peer-to-peer setting (unused by the SFU) |
| | `turn_url`, `turn_user`, `turn_pass` | | Legacy TURN relay (unused by the SFU) |
| `sfu` | `listen_ip` | `0.0.0.0` | Address the media relay binds to |
| | `announced_ip` | `""` | Public IP/hostname clients use to reach the SFU |
| | `rtc_min_port`, `rtc_max_port` | `40000` / `49999` | UDP/TCP media port range (open in firewall) |
| `federation` | `enabled` | `true` | Join the global OpenCord network (needs `server.public_url`) |
| | `help_host` | `true` | Store and serve the shared directory for other hosts *(live from the admin page)* |
| | `seeds` | `[]` | Hosts to bootstrap from, e.g. `["https://chat.example.org"]` |
| | `sync_interval_s` | `60` | How often to pull directory updates |
| `web` | `enabled` | `true` | Serve the web app at `/` |
| | `android_apk` | `""` | APK offered at `/download/android` (path relative to `config.toml`) |
| | `android_package`, `android_sha256` | | Digital Asset Links for the APK (from `scripts/build-android.sh`) |
| `updates` | `check` | `true` | Look for new releases and show "update available" on the Server Admin page |
| `embeds` | `enabled`, `timeout_ms` | on | Link previews; private network addresses are never fetched |
| `logging` | `level`, `file` | `warn` | |

Environment overrides: `OPENCORD_CONFIG`, `OPENCORD_PORT`, `OPENCORD_HOST`, `OPENCORD_DATA_DIR`, `OPENCORD_WEB_DIR` (where the built web app lives, if not next to the server).

### A complete example

```toml
[server]
port = 8443
public_url = "https://chat.example.com"   # required for the global network and invite links
trust_proxy = true                          # behind Caddy/nginx

[instance]
name = "Example Chat"
description = "Friends of example.com"
admin_emails = ["me@example.com"]

[registration]
mode = "open"
max_accounts_per_email = 5

[smtp]
enabled = true
host = "smtp.example.com"
user = "no-reply@example.com"
pass = "app-password"
from = "Example Chat <no-reply@example.com>"

[sfu]
announced_ip = "203.0.113.5"
rtc_min_port = 40000
rtc_max_port = 40100

[federation]
enabled = true
help_host = true
seeds = ["https://opencord.example.org"]

[web]
enabled = true
android_apk = "OpenCord.apk"
android_sha256 = "AB:CD:…"
```

## Controlling sign-ups

```sh
opencord-server set-registration closed       # nobody can register
opencord-server set-registration allowlist    # only allowlisted emails
opencord-server allow-email add friend@example.com "Bob from work"
opencord-server allow-email list
opencord-server allow-email remove friend@example.com
```

Each allowlist entry can be used once to create the first account for that email; after that, the person can add more accounts on the same email from inside the app. Admins can do all of this from **User Settings → Server Admin** in the app too.

## Admin CLI

```
opencord-server start | init | version
opencord-server create-admin                 # interactive
opencord-server make-admin <username>
opencord-server reset-password <username>
opencord-server disable-user <username> | enable-user <username>
opencord-server users
opencord-server backup [file]                # consistent online backup of the database
```

Add `--config /path/to/config.toml` to any command when the config isn't in the current directory.

## Automatic HTTPS (works with just an IP address)

OpenCord can get its own certificate from Let's Encrypt and renew it, so you don't need a reverse proxy, and you don't even need a domain. Browsers trust it like any other HTTPS site, so microphone, camera, the home-screen app and the service worker all work.

```toml
[server]
port = 443                            # or keep 8443 and forward port 443 to it
public_url = "https://203.0.113.5"    # your server's public IP (IPv4 or IPv6), or a domain

[tls]
auto = true
email = "you@example.com"             # optional
```

Requirements:

- **Port 80** (TCP) from the internet must reach `http_port`, and **port 443** must reach `[server].port`. Let's Encrypt checks port 80 to confirm you control the address. Open both in your firewall and, on a cloud server (Oracle, AWS, ...), in its security list or security group too.
- Nothing else (Caddy, nginx, Apache) may be using those ports.
- The tarball's systemd service already allows binding ports below 1024. Elsewhere, run with `CAP_NET_BIND_SERVICE`, or keep the defaults and forward 80 → `http_port` and 443 → `port`.

On start, the server gets the certificate first (a few seconds), then serves HTTPS. Plain HTTP on port 80 redirects to HTTPS. The certificate and its keys live in `data/tls/`.

**IP addresses** get Let's Encrypt's short-lived certificates, valid for about 6 days. OpenCord renews them in the background about every 2 days, with no restart and no dropped connections. Domain certificates are renewed when a third of their lifetime is left. If renewal fails, the server keeps using the current certificate and retries every hour. If there's no certificate yet, it keeps retrying (after 1, 2, 5, 10 and then every 30 minutes) and logs why, e.g. port 80 not reachable.

With Docker, publish `"443:8443"` and `"80:8080"` and set `OPENCORD_PUBLIC_URL: "https://<your ip>"` and `OPENCORD_TLS_AUTO: "true"` (see the comments in `docker-compose.yml`).

Use `acme_directory = "https://acme-staging-v02.api.letsencrypt.org/directory"` to try it without counting against Let's Encrypt's rate limits. Staging certificates aren't trusted by browsers, so delete `data/tls/cert.pem` and switch back afterwards.

## Reverse proxy

Caddy, with automatic HTTPS:

```
chat.example.com {
    reverse_proxy 127.0.0.1:8443
}
```

nginx:

```nginx
server {
    server_name chat.example.com;
    client_max_body_size 510m;   # at least [storage].max_upload_mb
    proxy_request_buffering off; # stream big uploads straight through
    location / {
        proxy_pass http://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set `trust_proxy = true` and `public_url = "https://chat.example.com"`.

Caddy has no request size limit by default. With nginx, keep `client_max_body_size` at or above the max file size you set in Server Admin → Storage, or larger uploads fail with "That file is too large for this server". Cloudflare's proxy caps uploads at 100 MB on its free plan.

## Storage limit

**Server Admin → Storage** (in the app, for instance admins) shows how much space OpenCord uses and has two settings, also in `config.toml` under `[storage]`:

- **Max file size** (`max_upload_mb`): the largest file someone can attach to a message, up to 500 MB. Uploads stream to disk, so large files don't use memory.
- **Storage limit** (`max_storage_gb`): the most disk space OpenCord may use for its database and uploads. `0` means no limit.

When a new upload or message would take usage above 95% of the limit, OpenCord makes room, down to 90%, in this order:

1. The files of the oldest messages. A message that also has text keeps its text; one that was only a file is removed.
2. Only if that isn't enough, the oldest messages themselves.

Pinned messages go last in both steps. **Accounts, servers, channels, roles, invites, avatars, banners, emoji, stickers, soundboard sounds, marketplace items and settings are never deleted**; only message history and its attachments are treated as expendable. If nothing is left to delete and there is still no room, the upload is refused ("This server is out of storage space") and the server logs what happened.

Set the limit below the free space on the disk (the admin page warns if it isn't), and keep backups if your message history matters.

## Voice & video

Voice, video and screen share run through a built-in **SFU** (Selective Forwarding Unit, via mediasoup). Each participant uploads once to the server, which forwards their audio/video to everyone else — so large groups don't multiply your upload bandwidth the way a peer-to-peer mesh does.

The SFU needs its UDP (and TCP) media ports reachable from the internet. Configure them under `[sfu]` and open the range in your firewall:

```sh
sudo ufw allow 40000:49999/udp
sudo ufw allow 40000:49999/tcp
```

Set `[sfu] announced_ip` to this server's public IP (or hostname) if clients can't reach it directly, e.g. when it's behind NAT or listening on `0.0.0.0`. Leave it empty to derive it from `[server].public_url`.

Calls between people on **different hosts** are split between both hosts: each person uses their own host's SFU and the two SFUs exchange one copy of each stream over an encrypted pipe. For that, the media port range must also be reachable from other OpenCord hosts (UDP). See [global network → calls](global-network.md#calls-across-hosts).

## Firewall checklist

| Port | Protocol | Needed for |
|---|---|---|
| 8443 (or 443 behind a proxy) | TCP | API, gateway, web app, global network |
| `rtc_min_port`–`rtc_max_port` | UDP (+TCP fallback) | Voice, video, screen share; calls with other hosts |

## Backups

Back up the `data_dir` (or run `opencord-server backup`) together with `config.toml`. The data directory includes `host-key.pem`, this host's identity on the global network: **keep it** when moving servers, otherwise other hosts will refuse your new key until their admins reset it.
