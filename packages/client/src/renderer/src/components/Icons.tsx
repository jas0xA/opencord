import type { PresenceStatus } from '@opencord/shared';
import type { ReactElement, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

/** OpenCord's own mark: an open ring speech bubble with two "voice" dots. */
export function Logo({ size = 28, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" {...p}>
      <path
        d="M16 3.5C9.1 3.5 3.5 8.6 3.5 14.9c0 3.5 1.7 6.6 4.4 8.7l-.9 4.4c-.1.6.5 1 1 .7l4.6-2.6c1.1.3 2.2.4 3.4.4 6.9 0 12.5-5.1 12.5-11.4S22.9 3.5 16 3.5Z"
        fill="currentColor"
      />
      <circle cx="11.2" cy="14.6" r="2.3" fill="var(--logo-cut, #5865f2)" />
      <circle cx="20.8" cy="14.6" r="2.3" fill="var(--logo-cut, #5865f2)" />
      <path d="M12.6 19.2c2 1.4 4.8 1.4 6.8 0" stroke="var(--logo-cut, #5865f2)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function HashIcon({ size = 20, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M10 3 8 21M16 3l-2 18M4.5 8.5h16M3.5 15.5h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function AnnouncementIcon({ size = 20, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

export function SpeakerIcon({ size = 20, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

export function FriendsIcon({ size = 24, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M13.5 4.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z" transform="translate(-1 2.5)" />
      <path d="M2 20.5C2 16.4 5.1 14 9 14s7 2.4 7 6.5a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5Z" />
      <path d="M17.5 8a3 3 0 1 1-1.9 5.3 5.5 5.5 0 0 0 .8-4.9A3 3 0 0 1 17.5 8ZM17.3 21h4.2a.5.5 0 0 0 .5-.5c0-3.1-2-5.3-4.9-5.8a8 8 0 0 1 1.9 5.3c0 .4-.1.7-.2 1Z" opacity=".9" />
    </svg>
  );
}

export function StatusIcon({ status, size = 10 }: { status: PresenceStatus; size?: number }) {
  const s = size;
  switch (status) {
    case 'online':
      return (
        <svg width={s} height={s} viewBox="0 0 10 10" className="status-icon">
          <circle cx="5" cy="5" r="5" fill="var(--green-status)" />
        </svg>
      );
    case 'idle':
      return (
        <svg width={s} height={s} viewBox="0 0 10 10" className="status-icon">
          <mask id="idle-mask">
            <rect width="10" height="10" fill="#fff" />
            <circle cx="2.5" cy="2.5" r="3.75" fill="#000" />
          </mask>
          <circle cx="5" cy="5" r="5" fill="var(--yellow-status)" mask="url(#idle-mask)" />
        </svg>
      );
    case 'dnd':
      return (
        <svg width={s} height={s} viewBox="0 0 10 10" className="status-icon">
          <circle cx="5" cy="5" r="5" fill="var(--red-status)" />
          <rect x="2" y="4" width="6" height="2" rx="1" fill="var(--status-ring, var(--bg-base))" />
        </svg>
      );
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 10 10" className="status-icon">
          <circle cx="5" cy="5" r="5" fill="var(--gray-status)" />
          <circle cx="5" cy="5" r="2.5" fill="var(--status-ring, var(--bg-base))" />
        </svg>
      );
  }
}

export const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  invisible: 'Invisible',
  offline: 'Offline',
};

/** Badge glyphs shown on profiles. */
export function BadgeIcon({ badge, size = 18 }: { badge: string; size?: number }) {
  const map: Record<string, { color: string; path: ReactElement; title: string }> = {
    staff: { color: '#5865f2', title: 'Instance Admin', path: <path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Z" /> },
    early_supporter: { color: '#f47fff', title: 'Founder', path: <path d="m12 2 2.9 6.2 6.8.8-5 4.7 1.3 6.7L12 17l-6 3.4 1.3-6.7-5-4.7 6.8-.8L12 2Z" /> },
    creator: { color: '#23a55a', title: 'Marketplace Creator', path: <path d="M4 20h4l10-10-4-4L4 16v4Zm12-16 4 4 1-1a2.8 2.8 0 0 0-4-4l-1 1Z" /> },
    bug_hunter: { color: '#3ba55c', title: 'Bug Hunter', path: <path d="M8 3l2 2h4l2-2 1 1-2 2a5 5 0 0 1 2 4v1h3v2h-3v1a5 5 0 0 1-.4 2H20v2h-3.8a5 5 0 0 1-8.4 0H4v-2h3.4a5 5 0 0 1-.4-2v-1H4v-2h3v-1a5 5 0 0 1 2-4L7 4l1-1Z" /> },
  };
  const b = map[badge];
  if (!b) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={b.color} aria-label={b.title}>
      <title>{b.title}</title>
      {b.path}
    </svg>
  );
}
