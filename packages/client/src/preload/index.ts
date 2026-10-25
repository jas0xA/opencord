import { contextBridge, ipcRenderer } from 'electron';

export interface ShortcutStatus {
  supported: boolean;
  appImage: string | null;
  installed: boolean;
  installedFor: string | null;
  upToDate: boolean;
}

const native = {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onMaximized: (cb: (v: boolean) => void) => {
    const fn = (_: unknown, v: boolean) => cb(v);
    ipcRenderer.on('window:maximized', fn);
    return () => {
      ipcRenderer.removeListener('window:maximized', fn);
    };
  },
  onDeepLink: (cb: (url: string) => void) => {
    const fn = (_: unknown, url: string) => cb(url);
    ipcRenderer.on('app:deeplink', fn);
    return () => {
      ipcRenderer.removeListener('app:deeplink', fn);
    };
  },
  flash: () => ipcRenderer.send('app:flash'),
  setBadge: (n: number) => ipcRenderer.send('app:badge', n),
  setTray: (enabled: boolean) => ipcRenderer.send('tray:set', enabled),
  openExternal: (url: string) => ipcRenderer.send('app:open-external', url),
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
  platform: (): Promise<string> => ipcRenderer.invoke('app:platform'),
  screenSources: (): Promise<{ id: string; name: string; thumbnail: string; icon: string | null }[]> => ipcRenderer.invoke('screen:sources'),
  shortcutStatus: (): Promise<ShortcutStatus> => ipcRenderer.invoke('shortcut:status'),
  installShortcut: (): Promise<ShortcutStatus> => ipcRenderer.invoke('shortcut:install'),
  removeShortcut: (): Promise<ShortcutStatus> => ipcRenderer.invoke('shortcut:remove'),
  loadSecrets: (): Promise<string | null> => ipcRenderer.invoke('secrets:load'),
  saveSecrets: (data: string): Promise<void> => ipcRenderer.invoke('secrets:save', data),
};

contextBridge.exposeInMainWorld('native', native);
export type Native = typeof native;
