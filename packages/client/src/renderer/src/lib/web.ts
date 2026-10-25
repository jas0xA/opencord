// Web app (browser / installed PWA) specifics. In Electron `window.native` exists and none of this applies.

import { useEffect, useState } from 'react';

/** Opens a link in the system browser (desktop app) or a new tab (web). */
export function openExternal(url: string) {
  if (window.native) window.native.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

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

/* ───────────── phone layout ───────────── */

const PHONE_QUERY = '(max-width: 760px), (max-height: 500px) and (pointer: coarse)';
export const isPhone = () => matchMedia(PHONE_QUERY).matches;

/** True while the window is phone-sized (matches the CSS phone layout breakpoint). */
export function usePhone() {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const mq = matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

/**
 * iOS Safari never fires `contextmenu` on a long press, so message/channel/member menus would be
 * unreachable there. Holding a finger still for 500ms dispatches one at the touch point instead.
 */
export function installLongPressMenus() {
  if (!isIOS()) return;
  let timer: number | undefined;
  let start: { x: number; y: number; target: EventTarget | null } | null = null;
  let fired = false;
  const cancel = () => {
    clearTimeout(timer);
    start = null;
  };
  document.addEventListener(
    'touchstart',
    (e) => {
      fired = false;
      if (e.touches.length !== 1) return cancel();
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, target: e.target };
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!start?.target) return;
        const el = start.target as Element;
        if (el.closest('input, textarea, [contenteditable="true"]')) return;
        fired = true;
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y }));
        navigator.vibrate?.(10);
      }, 500);
    },
    { passive: true },
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
    },
    { passive: true },
  );
  document.addEventListener('touchend', (e) => {
    cancel();
    // Swallow the click that would otherwise follow the long press and close the menu again.
    if (fired) e.preventDefault();
  });
  document.addEventListener('touchcancel', cancel, { passive: true });
}

/**
 * Keeps `--app-height` equal to the visible viewport, which shrinks while the on-screen keyboard
 * is up (iOS doesn't resize the layout viewport for it), so the composer stays above the keyboard.
 */
export function trackViewportHeight() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const update = () => {
    root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
    // iOS scrolls the whole page to reveal a focused field; the app sizes itself instead.
    if (vv.offsetTop > 0 && isIOS()) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
