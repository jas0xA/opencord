# Web app, iPhone and Android

Every OpenCord server serves the full app in the browser at its own address (`[web] enabled = true`, the default). The same app works on desktop browsers and phones.

## Using it

Open your server's address, e.g. `https://chat.example.com`. The web app connects to that server automatically, so there's no server picker. Invite links (`https://chat.example.com/invite/abc123`) open the app and join the server after you sign in.

On narrow screens the layout switches to a phone layout:

- The server and channel lists slide in from the ☰ button.
- The member list (or a DM's profile) slides over the chat from the members button; search expands over the channel header.
- Settings open as a list; tap a section to open it and ← to go back.
- Pickers, menus and dialogs open as sheets from the bottom of the screen, sized to fit.
- Long-press a message, channel or member for its menu (the same menu right-click opens on a computer).
- The composer stays above the on-screen keyboard, and text fields don't zoom the page on iPhone.

| Feature | Desktop app | Desktop browser | Phone browser |
|---|---|---|---|
| Chat, DMs, servers, marketplace, themes | ✓ | ✓ | ✓ |
| Voice & video calls | ✓ | ✓ | ✓ |
| Screen share | ✓ (window/screen picker) | ✓ (browser picker) | ✗ (browsers on phones can't capture the screen) |
| Notifications | ✓ | ✓ while the tab is open | ✓ while the app is open |

> Browsers only allow microphone, camera and screen access on **HTTPS** (or `localhost`). Turn on [automatic HTTPS](self-hosting.md#automatic-https-works-with-just-an-ip-address) (works with just an IP address) or put the server behind a [reverse proxy](self-hosting.md#reverse-proxy) with a certificate.

## iPhone / iPad: add to Home Screen

1. Open the server's address in **Safari**.
2. Tap **Share** (square with an arrow), then **Add to Home Screen**.

OpenCord then opens full-screen with its own icon, like an installed app, and keeps clear of the notch, the Dynamic Island and the home indicator. The web app shows these instructions in a banner on iOS.

## Android

Two options; the web app offers whichever is available:

- **Install** (Chrome): adds the web app to the home screen and app drawer. No setup needed on the server.
- **APK download**: a real Android package your server offers at `/download/android`.

### Building the APK

`scripts/build-android.sh` wraps your server's web app in a **Trusted Web Activity**, a small native app that opens your site full-screen with its own icon:

```sh
scripts/build-android.sh https://chat.example.com            # optional 2nd arg: package id
```

It needs Node 22+. On first run Bubblewrap downloads a JDK and the Android SDK (about 1 GB) and asks you to accept the SDK license. It creates a signing key in `android-build/android.keystore`. **Keep that file and its password**: Android only installs updates signed with the same key.

When it finishes it prints three lines for `config.toml`:

```toml
[web]
android_apk = "OpenCord.apk"            # copy android-build/OpenCord.apk next to config.toml
android_package = "org.opencord.app"
android_sha256 = "AB:CD:EF:…"
```

Restart the server. Android visitors now see an **APK** button. The `android_sha256` fingerprint is published at `/.well-known/assetlinks.json`, which lets the app hide the browser bar.

The APK loads the web app from your server, so app updates reach phones as soon as you update the server. Rebuild the APK only to change the icon, name or package id.

## Desktop app: launcher shortcut (Linux AppImage)

AppImages don't install themselves. In the desktop app, open **User Settings → System → Desktop Shortcut** and press **Create Shortcut**. This adds OpenCord with its icon to your app launcher and app switcher, and registers `opencord://` links.

Pressing it again from another version (or after moving the AppImage) **replaces** the old entry, so you never get duplicates. **Remove** deletes it.

## Self-hosting notes

- The web app is part of the server download (`web/` next to `opencord-server`) and the Docker image. From source, build it with `npm run build -w @opencord/client`; the server finds `packages/client/out/renderer` automatically.
- To serve it from somewhere else, set `OPENCORD_WEB_DIR=/path/to/web`.
- Set `[web] enabled = false` to show only a small landing page at `/`.
- A service worker caches the app shell so it starts quickly and keeps working offline until the connection returns. API calls, uploads and the gateway always go to the network.
