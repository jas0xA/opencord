// User themes: CSS injected into the page, plus optional JavaScript that runs in a sandboxed Web
// Worker. The worker has no DOM, no storage and no network APIs (they are removed before the theme
// code runs), so a theme can't read your token or messages. It talks to the app only through a
// small message API: set CSS variables, toggle `theme-*` classes on <html>, and receive app events.
import { useStore } from './store';

export interface ThemeCode {
  id: string;
  name: string;
  css: string;
  js: string;
}

const STYLE_ID = 'opencord-user-theme';

/* ───────────── worker sandbox ───────────── */

// Runs inside the worker before the theme code. Everything that could reach the network or
// persist data is removed; the theme only gets `api`.
const BOOTSTRAP = `
'use strict';
(() => {
  const blocked = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches',
    'BroadcastChannel', 'Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection', 'navigator'];
  // Clear them on the global and every prototype above it, so they can't be fished back out.
  for (let o = self; o; o = Object.getPrototypeOf(o)) {
    for (const k of blocked) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      try { Object.defineProperty(o, k, { value: undefined, configurable: false, writable: false }); } catch {}
    }
  }
  for (const k of blocked) {
    try { Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch {}
  }
})();
const __post = self.postMessage.bind(self);
const __handlers = {};
self.postMessage = undefined;
const api = Object.freeze({
  /** Sets a CSS custom property on <html>, e.g. api.setVar('--brand', '#ff00aa'). */
  setVar: (name, value) => __post({ t: 'var', name: String(name), value: value == null ? null : String(value) }),
  /** Adds or removes the class "theme-<name>" on <html>. */
  toggleClass: (name, on) => __post({ t: 'class', name: String(name), on: on === undefined ? null : !!on }),
  /** Subscribes to app events: 'route', 'message', 'voice', 'focus', 'theme'. */
  on: (event, cb) => { (__handlers[event] ||= []).push(cb); },
  log: (...args) => __post({ t: 'log', args: args.map((a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }) }),
});
self.onmessage = (e) => {
  const { event, data } = e.data || {};
  for (const cb of __handlers[event] || []) { try { cb(data); } catch (err) { api.log('error in ' + event + ' handler: ' + err); } }
};
`;

/** Values for setVar may not load external resources or break out of the declaration. */
function safeCssValue(v: string) {
  return v.length <= 300 && !/url\s*\(|expression\s*\(|image-set|@import|[;{}<>\\]|javascript:/i.test(v);
}

class ThemeRuntime {
  private worker: Worker | null = null;
  private vars = new Set<string>();
  private classes = new Set<string>();
  private unsubs: (() => void)[] = [];
  active: ThemeCode | null = null;
  logs: string[] = [];
  onLog: ((line: string) => void) | null = null;

  apply(theme: ThemeCode | null) {
    this.stop();
    this.active = theme;
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!theme) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    // Theme CSS may not pull in other stylesheets.
    style.textContent = theme.css.replace(/@import[^;]*;?/gi, '');
    if (theme.js.trim()) this.startWorker(theme.js);
  }

  private startWorker(js: string) {
    const src = `${BOOTSTRAP}\n;(function(){\n${js}\n})();`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (e) {
      this.log(`Could not start theme script: ${(e as Error).message}`);
      return;
    } finally {
      URL.revokeObjectURL(url);
    }
    this.worker = worker;
    worker.onerror = (e) => this.log(`Theme script error: ${e.message}`);
    worker.onmessage = (e) => this.handle(e.data);
    const send = (event: string, data: unknown) => this.worker?.postMessage({ event, data });

    // App events the theme can react to. Only coarse, non-sensitive information is shared.
    let lastRoute = '';
    let lastChannelMsgs = 0;
    this.unsubs.push(
      useStore.subscribe((s) => {
        const route = JSON.stringify({ kind: s.route.kind, view: s.route.kind === 'home' ? s.route.view : 'guild' });
        if (route !== lastRoute) {
          lastRoute = route;
          send('route', JSON.parse(route));
        }
        const total = Object.values(s.messages).reduce((n, c) => n + c.list.length, 0);
        if (total > lastChannelMsgs && lastChannelMsgs) send('message', { count: total - lastChannelMsgs });
        lastChannelMsgs = total;
      }),
    );
    const onFocus = () => send('focus', document.hasFocus());
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onFocus);
    this.unsubs.push(() => (window.removeEventListener('focus', onFocus), window.removeEventListener('blur', onFocus)));
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => send('theme', { dark: mq.matches });
    mq.addEventListener('change', onScheme);
    this.unsubs.push(() => mq.removeEventListener('change', onScheme));
    setTimeout(() => {
      send('route', JSON.parse(lastRoute || '{}'));
      onFocus();
      onScheme();
    }, 0);
  }

  /** Lets the voice manager tell themes about calls. */
  voiceEvent(data: { in_call: boolean; speaking: number }) {
    this.worker?.postMessage({ event: 'voice', data });
  }

  private handle(m: any) {
    const root = document.documentElement;
    if (m?.t === 'var' && /^--[a-z0-9-]{1,60}$/i.test(m.name)) {
      if (m.value === null) {
        root.style.removeProperty(m.name);
        this.vars.delete(m.name);
      } else if (safeCssValue(m.value)) {
        root.style.setProperty(m.name, m.value);
        this.vars.add(m.name);
      } else this.log(`Blocked unsafe value for ${m.name}`);
    } else if (m?.t === 'class' && /^[a-z0-9-]{1,40}$/i.test(m.name)) {
      const cls = `theme-${m.name}`;
      const on = m.on === null ? !root.classList.contains(cls) : m.on;
      root.classList.toggle(cls, on);
      on ? this.classes.add(cls) : this.classes.delete(cls);
    } else if (m?.t === 'log') {
      this.log(m.args.join(' '));
    }
  }

  private log(line: string) {
    this.logs = [...this.logs.slice(-199), line];
    this.onLog?.(line);
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    const root = document.documentElement;
    for (const v of this.vars) root.style.removeProperty(v);
    for (const c of this.classes) root.classList.remove(c);
    this.vars.clear();
    this.classes.clear();
  }
}

export const themeRuntime = new ThemeRuntime();

/* ───────────── active theme (per server, on this device) ───────────── */

const key = () => `opencord.theme.${useStore.getState().server?.url ?? ''}`;

export function loadActiveTheme(): ThemeCode | null {
  try {
    return JSON.parse(localStorage.getItem(key()) ?? 'null');
  } catch {
    return null;
  }
}

export function setActiveTheme(theme: ThemeCode | null) {
  try {
    if (theme) localStorage.setItem(key(), JSON.stringify(theme));
    else localStorage.removeItem(key());
  } catch {
    /* storage unavailable */
  }
  themeRuntime.apply(theme);
}

/* ───────────── reference material for theme authors ───────────── */

/** Every CSS custom property the UI defines on :root, with its current value. */
export function cssVariables(): { name: string; value: string }[] {
  const names = new Set<string>();
  for (const sheet of [...document.styleSheets]) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of [...rules]) {
      if (rule instanceof CSSStyleRule && /(^|,)\s*(:root|html|\.theme-[a-z]+)/.test(rule.selectorText)) {
        for (const prop of [...rule.style]) if (prop.startsWith('--')) names.add(prop);
      }
    }
  }
  const cs = getComputedStyle(document.documentElement);
  return [...names].sort().map((name) => ({ name, value: cs.getPropertyValue(name).trim() }));
}

/** Class names used by the UI (for targeting elements in theme CSS). */
export function cssClasses(): string[] {
  const out = new Set<string>();
  for (const sheet of [...document.styleSheets]) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of [...rules]) {
      if (rule instanceof CSSStyleRule) for (const m of rule.selectorText.matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(m[1]);
    }
  }
  return [...out].filter((c) => !c.startsWith('theme-')).sort();
}

/** A starting point containing every UI variable with its current value. */
export function themeTemplate() {
  const vars = cssVariables()
    .filter((v) => v.value)
    .map((v) => `  ${v.name}: ${v.value};`)
    .join('\n');
  return {
    css: `/* Every color, radius and font in the UI comes from these variables.\n   Change any of them, or target classes (see Reference) for finer control. */\n:root {\n${vars}\n}\n`,
    js: `// Theme scripts run in a sandbox: no network, no storage, no access to your account.\n// api.setVar(name, value)   set a CSS variable on <html>\n// api.toggleClass(name, on) add/remove class "theme-<name>" on <html>\n// api.on(event, callback)   'route' | 'message' | 'voice' | 'focus' | 'theme'\n// api.log(...values)        print to the console below the editor\n\n// Example: shift the accent color slowly through the rainbow.\n// let hue = 230;\n// setInterval(() => api.setVar('--brand', \`hsl(\${(hue = (hue + 1) % 360)} 80% 60%)\`), 100);\n`,
  };
}
