import { RelationshipType } from '@opencord/shared';
import { api } from '../lib/api';
import { toast, useStore } from '../lib/store';
import { isBlocked, previewUserOverride, setUserOverride, userOverride } from '../lib/userPrefs';
import type { MenuItem } from './Layers';

/** How loud you hear one person (0-200%), live while dragging and saved when let go. */
export function UserVolumeSlider({ userId }: { userId: string }) {
  const volume = useStore((s) => s.me?.settings.user_overrides?.[userId]?.volume ?? 100);
  const muted = useStore((s) => !!s.me?.settings.user_overrides?.[userId]?.mute_voice);
  const save = (v: number) => setUserOverride(userId, { volume: v });
  return (
    <div className="user-volume" onClick={(e) => e.stopPropagation()}>
      <div className="uv-label">
        <span>User Volume</span>
        <span className="uv-value">{muted ? 'Muted' : `${volume}%`}</span>
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={volume}
        aria-label="User volume"
        style={{ ['--fill' as string]: `${volume / 2}%` }}
        onChange={(e) => previewUserOverride(userId, { volume: Number(e.target.value) })}
        onPointerUp={(e) => save(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => save(Number((e.target as HTMLInputElement).value))}
        onDoubleClick={() => save(100)}
      />
    </div>
  );
}

/** Volume, voice mute, message mute and block for one user - shared by every user menu. */
export function userControlItems(userId: string, { voice = true }: { voice?: boolean } = {}): MenuItem[] {
  if (userId === useStore.getState().me?.id) return [];
  const o = userOverride(userId);
  const blocked = isBlocked(userId);
  return [
    { separator: true },
    voice && { render: () => <UserVolumeSlider userId={userId} /> },
    voice && { label: 'Mute Voice', checked: !!o.mute_voice, onClick: () => setUserOverride(userId, { mute_voice: !o.mute_voice }) },
    { label: 'Mute Messages', checked: !!o.mute_messages, onClick: () => setUserOverride(userId, { mute_messages: !o.mute_messages }) },
    blocked
      ? { label: 'Unblock', onClick: () => api.del(`/users/@me/relationships/${userId}`).catch((e) => toast(e.message)) }
      : { label: 'Block', danger: true, onClick: () => api.put(`/users/@me/relationships/${userId}`, { type: RelationshipType.BLOCKED }).catch((e) => toast(e.message)) },
  ];
}
