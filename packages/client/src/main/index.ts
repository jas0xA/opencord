import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, safeStorage, session, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const secretsFile = () => path.join(app.getPath('userData'), 'accounts.bin');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as { width: number; height: number; x?: number; y?: number; maximized?: boolean };
  } catch {
    return { width: 1280, height: 800 };
  }
}

function iconPath() {
  const candidates = [path.join(process.resourcesPath ?? '', 'icon.png'), path.join(__dirname, '../../build/icon.png'), path.join(__dirname, '../../resources/icon.png')];
  return candidates.find((p) => fs.existsSync(p));
}

function createWindow() {
  const state = loadWindowState();
  const icon = iconPath();
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 940,
    minHeight: 500,
    frame: false,
    show: false,
    backgroundColor: '#121214',
    title: 'OpenCord',
    icon: icon ? nativeImage.createFromPath(icon) : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());

  const saveState = () => {
    if (!win) return;
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  };
  win.on('close', (e) => {
    saveState();
    if (!quitting && tray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('maximize', () => win?.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win?.webContents.send('window:maximized', false));
  win.on('focus', () => win?.flashFrame(false));

  // External links open in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  if (isDev) win.loadURL(process.env.ELECTRON_RENDERER_URL!);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function createTray() {
  const icon = iconPath();
  if (!icon) return;
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 22, height: 22 }));
  tray.setToolTip('OpenCord');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open OpenCord', click: () => win?.show() },
      { type: 'separator' },
      { label: 'Quit OpenCord', click: () => ((quitting = true), app.quit()) },
    ]),
  );
  tray.on('click', () => (win?.isVisible() ? win.focus() : win?.show()));
}

/* ───────────── Linux desktop shortcut (AppImage) ───────────── */

const DESKTOP_ID = 'opencord.desktop';
const appsDir = () => path.join(process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local/share'), 'applications');
const iconsDir = () => path.join(process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local/share'), 'icons/hicolor/512x512/apps');

/** Desktop entries pointing at an OpenCord AppImage: ours plus ones left by AppImageLauncher/older builds. */
function existingShortcuts(): string[] {
  try {
    return fs
      .readdirSync(appsDir())
      .filter((f) => f.endsWith('.desktop'))
      .map((f) => path.join(appsDir(), f))
      .filter((p) => {
        if (path.basename(p) === DESKTOP_ID) return true;
        try {
          const text = fs.readFileSync(p, 'utf8');
          return /^X-OpenCord-Shortcut=true$/m.test(text) || (/^Name=OpenCord$/m.test(text) && /\.AppImage/i.test(text));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function shortcutStatus() {
  const appImage = process.env.APPIMAGE;
  const current = existingShortcuts();
  let installedFor: string | null = null;
  for (const p of current) {
    const m = /^Exec="?([^"\n]+?)"?(?: %U)?$/m.exec(fs.readFileSync(p, 'utf8'));
    if (m) installedFor = m[1];
  }
  return { supported: process.platform === 'linux' && !!appImage, appImage: appImage ?? null, installed: current.length > 0, installedFor, upToDate: !!appImage && installedFor === appImage };
}

/** Installs (or replaces) the app-launcher entry and icon for the running AppImage. */
function installShortcut() {
  const appImage = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !appImage) throw new Error('Shortcuts can only be created when running the AppImage on Linux.');
  // Remove every older entry first so switching versions never leaves duplicates in the app switcher.
  for (const p of existingShortcuts()) fs.rmSync(p, { force: true });
  fs.mkdirSync(appsDir(), { recursive: true });
  fs.mkdirSync(iconsDir(), { recursive: true });
  const src = iconPath();
  const iconFile = path.join(iconsDir(), 'opencord.png');
  if (src) fs.copyFileSync(src, iconFile);
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=OpenCord',
    'Comment=Open-source, self-hosted chat',
    `Exec="${appImage}" %U`,
    `TryExec=${appImage}`,
    `Icon=${src ? iconFile : 'opencord'}`,
    'Terminal=false',
    'Categories=Network;InstantMessaging;Chat;',
    'StartupWMClass=OpenCord',
    'MimeType=x-scheme-handler/opencord;',
    `X-AppImage-Version=${app.getVersion()}`,
    'X-OpenCord-Shortcut=true',
    '',
  ].join('\n');
  const file = path.join(appsDir(), DESKTOP_ID);
  fs.writeFileSync(file, entry, { mode: 0o755 });
  // Best effort: refresh the launcher cache and register the opencord:// handler.
  import('node:child_process').then(({ execFile }) => {
    execFile('update-desktop-database', [appsDir()], () => {});
    execFile('xdg-mime', ['default', DESKTOP_ID, 'x-scheme-handler/opencord'], () => {});
    execFile('gtk-update-icon-cache', ['-f', '-t', path.dirname(path.dirname(iconsDir()))], () => {});
  });
  return shortcutStatus();
}

function removeShortcut() {
  for (const p of existingShortcuts()) fs.rmSync(p, { force: true });
  return shortcutStatus();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const link = argv.find((a) => a.startsWith('opencord://'));
  if (link) win.webContents.send('app:deeplink', link);
});
app.setAsDefaultProtocolClient('opencord');

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // Allow microphone/camera/screen/notifications; the app connects to user-chosen servers.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'display-capture'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  ipcMain.on('window:minimize', () => win?.minimize());
  ipcMain.on('window:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  ipcMain.on('window:close', () => win?.close());
  ipcMain.handle('window:is-maximized', () => win?.isMaximized() ?? false);
  ipcMain.on('app:flash', () => {
    if (win && !win.isFocused()) win.flashFrame(true);
  });
  ipcMain.on('app:badge', (_e, count: number) => app.setBadgeCount?.(count));
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:platform', () => process.platform);
  ipcMain.handle('screen:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), icon: s.appIcon?.toDataURL() ?? null }));
  });
  ipcMain.handle('secrets:load', () => {
    try {
      const buf = fs.readFileSync(secretsFile());
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    } catch {
      return null;
    }
  });
  ipcMain.handle('secrets:save', (_e, data: string) => {
    const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(data) : Buffer.from(data, 'utf8');
    fs.writeFileSync(secretsFile(), buf, { mode: 0o600 });
  });
  ipcMain.on('tray:set', (_e, enabled: boolean) => {
    if (enabled && !tray) createTray();
    if (!enabled && tray) {
      tray.destroy();
      tray = null;
    }
  });
  ipcMain.handle('shortcut:status', () => shortcutStatus());
  ipcMain.handle('shortcut:install', () => installShortcut());
  ipcMain.handle('shortcut:remove', () => removeShortcut());
  ipcMain.on('app:open-external', (_e, url: string) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  createWindow();
  createTray();
});

app.on('before-quit', () => (quitting = true));
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
