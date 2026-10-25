# OpenCord

An open-source, self-hosted chat platform: a desktop **client**, a **web app** for phones and browsers, and a **server** you run yourself. Servers join one shared **global network**, so people on different hosts can be friends, chat, call and join each other's servers.

- **Friends & DMs**: friend requests, blocking, 1:1 and group DMs, unread badges, mentions, typing indicators
- **Servers**: text, voice and announcement channels, categories, roles with a full permission system and per-channel overrides, invites with expiry and use limits, vanity URLs, emoji, stickers, soundboard, webhooks, server templates
- **Accounts**: several accounts per email with instant switching, sensible password rules, two-factor auth
- **Moderation**: message reports with a review queue for server mods and instance admins, kick, ban (with message cleanup), timeouts, server mute/deafen, move/disconnect, slowmode, AutoMod (keywords, spam, mention spam, links), audit log, role hierarchy enforcement
- **Voice & video**: DM calls and voice channels through a built-in SFU, camera, screen share, push-to-talk, noise suppression, speaking indicators, a call grid that scales to fit any number of participants
- **Global network**: usernames unique across every host, cross-host friends and DMs, calls whose load is split between both hosts, global servers, cosmetics and themes. Hosts help host the shared directory (opt-out). See [docs/global-network.md](docs/global-network.md)
- **Web & mobile**: every server serves the app in the browser; add it to the iPhone home screen, install it on Android, or offer an APK. See [docs/web-and-mobile.md](docs/web-and-mobile.md)
- **Themes**: a built-in code editor for CSS + sandboxed scripts, with live preview and a reference of every UI variable and class; share privately, with your host, or globally. See [docs/themes.md](docs/themes.md)
- **Profiles**: avatars and banners with crop & reposition (animated GIF/APNG/WebP included), display-name styles, pronouns, about me, profile themes, avatar decorations, profile effects, nameplates, connected accounts, notes, custom status
- **Marketplace**: every cosmetic is free. There's an official catalog, a **Community** tab where users publish their own items, and a **Global** tab with items from the whole network. Items can be private, and creators can block copies.
- **Self-hosting**: one config file, SQLite, an admin CLI, and registration that can be open, invite-only, allowlist-only (approve specific emails) or closed

> OpenCord is an independent project. It is not affiliated with Discord Inc. and uses its own name, logo and assets.

## Repository layout

```
packages/shared   protocol types, permission bitfield, constants
packages/server   Fastify REST API + WebSocket gateway + SQLite
packages/client   Electron + React desktop app (also built as the web app the server serves)
docs/             documentation (see below)
scripts/          release packaging, Android APK build
```

## Running from source

Requires Node.js 22+.

```sh
npm install
npm run dev:server        # starts on :8443 and writes packages/server/config.toml
npm run dev:client        # opens the desktop app; connect to "localhost"
npm test                  # server integration tests
```

## Building releases

| Target | Command | Output |
|---|---|---|
| Linux server (self-contained tarball with Node runtime + systemd installer) | `npm run dist:server` | `release/opencord-server-<v>-linux-<x64\|arm64>.tar.gz` (host architecture) |
| Linux ARM64 server from an x64 machine | `npm run dist:server:arm64` | `release/opencord-server-<v>-linux-arm64.tar.gz` |
| Linux client (AppImage) | `npm run dist:client` | `packages/client/release/OpenCord-<v>-<x86_64\|arm64>.AppImage` |
| Windows server (zip with node.exe) | `scripts\package-server.ps1` on Windows | `release\opencord-server-<v>-win-x64.zip` |
| Windows client (NSIS installer) | `npm run dist:win -w @opencord/client` on Windows | `packages/client/release/OpenCord-Setup-<v>.exe` |
| Docker server (amd64 + arm64) | `docker build -t opencord-server .` | image; releases publish `ghcr.io/jas0xa/opencord` |
| Android app (TWA wrapping a server's web app) | `scripts/build-android.sh https://your.host` | `android-build/OpenCord.apk` |

Server packages include the web app (`web/`).

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds all of these natively (Linux x64 and arm64, Windows), publishes the multi-arch Docker image as `<version>` and `latest`, and attaches every file to the GitHub Release.

## Running with Docker

```sh
curl -O https://raw.githubusercontent.com/jas0xA/opencord/main/docker-compose.yml   # set OPENCORD_PUBLIC_URL
docker compose up -d
docker compose pull && docker compose up -d   # update later
```

Works on x86-64 and ARM64. Details in [docs/self-hosting.md](docs/self-hosting.md#docker-x86-64-and-arm64).

## Documentation

| Guide | What's in it |
|---|---|
| [Self-hosting](docs/self-hosting.md) | Install (tarball, systemd, Docker), every `config.toml` option, admin CLI, reverse proxy, firewall, backups |
| [Global network](docs/global-network.md) | How hosts join and trust each other, helping host, usernames, cross-host friends/DMs/calls, global servers, troubleshooting |
| [Web & mobile](docs/web-and-mobile.md) | The web app, iPhone home screen, Android install and APK, desktop launcher shortcut |
| [Accounts & moderation](docs/accounts-and-moderation.md) | Username and password rules, several accounts per email, image cropping, message reports |
| [Themes](docs/themes.md) | Writing themes: CSS variables, the sandboxed script API, sharing and no-copy |
| [Webhooks](docs/webhooks.md) | Posting messages from other services |

## License

AGPL-3.0-or-later. If you run a modified server for others, share your changes.
