import { useStore } from './store';

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function is24h() {
  return useStore.getState().me?.settings.time_24h ?? false;
}

function locale() {
  return useStore.getState().me?.settings.locale ?? 'en-US';
}

export function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit', hour12: !is24h() });
}

/** "9:57 AM", "Yesterday at 7:40 PM" or "10/21/26, 9:50 PM" — as in the message header. */
export function formatTimestamp(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return formatTime(ts);
  if (sameDay(d, yesterday)) return `Yesterday at ${formatTime(ts)}`;
  return `${d.toLocaleDateString(locale(), { month: 'numeric', day: 'numeric', year: '2-digit' })}, ${formatTime(ts)}`;
}

export function formatFullDate(ts: number) {
  return new Date(ts).toLocaleString(locale(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: !is24h() });
}

/** "October 23, 2026" for day dividers. */
export function formatDay(ts: number) {
  return new Date(ts).toLocaleDateString(locale(), { month: 'long', day: 'numeric', year: 'numeric' });
}

/** "Nov 6, 2021" for Member Since. */
export function formatShortDate(ts: number) {
  return new Date(ts).toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Oct 2026" for invite cards ("Est. Oct 2026"). */
export function formatMonthYear(ts: number) {
  return new Date(ts).toLocaleDateString(locale(), { month: 'short', year: 'numeric' });
}

export function isSameDay(a: number, b: number) {
  return sameDay(new Date(a), new Date(b));
}

export function humanDuration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 45) return 'a few seconds';
  const m = Math.round(s / 60);
  if (m <= 1) return 'a minute';
  if (m < 45) return `${m} minutes`;
  const h = Math.round(m / 60);
  if (h <= 1) return 'an hour';
  if (h < 22) return `${h} hours`;
  const d = Math.round(h / 24);
  return d <= 1 ? 'a day' : `${d} days`;
}

export function relativeTime(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Initials for icon-less guilds, like "jas" → "j a s" style acronym. */
export function acronym(name: string) {
  return name
    .replace(/'s /g, ' ')
    .replace(/\w+/g, (w) => w[0])
    .replace(/\s/g, '')
    .slice(0, 5);
}

export function classNames(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

/** Deterministic default avatar color for users without an avatar. */
export function defaultAvatarColor(id: string) {
  const colors = ['#5865f2', '#757e8a', '#3ba55c', '#faa61a', '#ed4245', '#eb459f'];
  let n = 0;
  for (const ch of id) n = (n + ch.charCodeAt(0)) % 997;
  return colors[n % colors.length];
}

export function copy(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}
