// Web app (browser / installed PWA) specifics. In Electron `window.native` exists and none of this applies.

export const isWeb = () => !window.native && /^https?:$/.test(location.protocol);

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isAndroid = () => /Android/i.test(navigator.userAgent);

export function registerServiceWorker() {
  if (!isWeb() || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* not supported (e.g. plain http on a LAN address) */
  });
}

/** Invite code from a /invite/<code> link (redirected to /?invite=<code>), consumed once. */
export function takePendingInvite(): string | null {
  if (!isWeb()) return null;
  const params = new URLSearchParams(location.search);
  const code = params.get('invite');
  if (!code) return null;
  params.delete('invite');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
  return code;
}

let deferredPrompt: any = null;
const promptListeners = new Set<() => void>();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  for (const l of promptListeners) l();
});

export const canPromptInstall = () => !!deferredPrompt;
export function onInstallPromptChange(fn: () => void) {
  promptListeners.add(fn);
  return () => void promptListeners.delete(fn);
}
export async function promptInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice.catch(() => null);
  deferredPrompt = null;
  return choice?.outcome === 'accepted';
}
