# Making themes

Themes restyle the whole OpenCord app. A theme is **CSS** plus an optional **script** that runs in a sandbox. Make them under **User Settings → Themes → New Theme**.

## The editor

- **theme.css / theme.js:** a code editor with syntax highlighting, autocomplete, bracket matching, search (Ctrl/Cmd+F), code folding and multiple cursors.
- **Reference:** every CSS variable the UI uses (with its current value and a color swatch; click one to add it to your CSS), every class name in the app, and the script API.
- **Live Preview:** applies your theme to the app as you type. Leaving the editor restores the theme you were using.
- **Console:** under the script editor, shows `api.log()` output and script errors while previewing.

A new theme starts with **every UI variable already filled in**, so you can change colors without knowing anything about the app's structure.

## CSS

Everything in the UI is drawn from CSS variables on `:root`:

```css
:root {
  --brand: #ff3388;          /* accent color: buttons, links, mentions */
  --bg-base: #0d0d12;        /* window background, server rail */
  --bg-content: #16161d;     /* chat area */
  --text-normal: #e6e6f0;
  --radius: 12px;
}
```

For finer control, target classes (listed in *Reference*):

```css
.message:hover { background: rgba(255, 51, 136, 0.06); }
.guild-rail { backdrop-filter: blur(12px); }
.call-tile.speaking { box-shadow: 0 0 0 3px var(--brand), 0 0 24px var(--brand); }
```

`@import` is removed, so a theme can't load other stylesheets. Images in `url()` work.

## Scripts

Scripts run in an isolated **Web Worker**, and before your code starts the sandbox removes:

- the DOM and `window`
- `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, WebRTC and `importScripts`
- storage (`localStorage`, `indexedDB`, `caches`)
- your login token, messages and account data (the worker never has them)

That's why any theme, even one from a stranger on another host, is safe to run. What a script *can* do is go through `api`:

```js
api.setVar('--brand', '#ff3388');     // set a CSS variable on <html>
api.setVar('--brand', null);          // remove it again
api.toggleClass('night', true);       // adds class "theme-night" to <html>
api.toggleClass('night');             // toggles it
api.log('hello', { any: 'value' });   // prints in the editor console

api.on('route',   ({ kind, view }) => {});   // 'home' + 'friends' | 'dm' | 'marketplace' | 'explore', or 'guild'
api.on('message', ({ count }) => {});        // new messages arrived
api.on('voice',   ({ in_call, speaking }) => {});
api.on('focus',   (focused) => {});          // window focus changed
api.on('theme',   ({ dark }) => {});         // system light/dark changed
```

`setTimeout` and `setInterval` work normally. Values passed to `setVar` may not contain `url(`, `@import`, `;`, braces or backslashes, and are limited to 300 characters.

### Examples

A slowly cycling accent color:

```js
let hue = 0;
setInterval(() => api.setVar('--brand', `hsl(${(hue = (hue + 1) % 360)} 80% 60%)`), 100);
```

Dim the app when the window loses focus:

```js
api.on('focus', (focused) => api.toggleClass('away', !focused));
```

```css
:root.theme-away .app { filter: saturate(0.4) brightness(0.8); transition: filter 0.4s; }
```

Glow while you're in a call:

```js
api.on('voice', ({ in_call }) => api.toggleClass('in-call', in_call));
```

```css
:root.theme-in-call .user-panel-wrap { box-shadow: 0 0 0 2px var(--green-status); }
```

## Sharing

Each theme has a visibility:

| Visibility | Who can find and use it |
|---|---|
| **Private (only me)** | Only you |
| **Public (this server)** | Everyone on your OpenCord host, under *Themes → This Server* |
| **Global (whole network)** | Everyone on every host in the [global network](global-network.md), under *Themes → Global* |

**Don't allow copies** hides your source in the editor for everyone else and blocks re-publishing the exact same code. People can still *use* the theme. The browser needs the CSS to show it, so this deters copying rather than making it impossible.

Themes that allow copies have a **Copy** button that duplicates them into *My Themes* for remixing.

The active theme is remembered per server on each device. **Reset to Default** turns it off.

## Cosmetics

Marketplace items (avatar decorations, profile effects, nameplates, banners, profile themes) have the same controls when you publish them or later from the item's right-click menu:

- **Only me (private):** never listed; only you can claim and equip it.
- **Everyone:** listed in *Marketplace → Community*.
- **List on the global network:** listed in *Marketplace → Global* on every host.
- **Don't allow copies:** others can use it, but nobody else can upload the same image as their own item.
