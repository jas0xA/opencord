// Per-user choices that only affect what you see and hear: voice volume, voice mute, message mute.
// Stored in your settings (`user_overrides`), so they follow you to every device.
import { RelationshipType, type UserOverride } from '@opencord/shared';
import { toast, updateSettings, useStore } from './store';

export function userOverride(userId: string): UserOverride {
  return useStore.getState().me?.settings.user_overrides?.[userId] ?? {};
}

/** Volume in percent (0-200) you hear `userId` at. */
export const userVolume = (userId: string) => userOverride(userId).volume ?? 100;

export function isBlocked(userId: string) {
  return useStore.getState().relationships[userId]?.type === RelationshipType.BLOCKED;
}

/** Messages from this user are collapsed and never notify you (muted or blocked). */
export function isMessageHidden(userId: string) {
  return isBlocked(userId) || !!userOverride(userId).mute_messages;
}

/** The override map with `patch` applied to `userId` (defaults dropped so the map holds only real choices). */
function withOverride(userId: string, patch: Partial<UserOverride>) {
  const all = { ...(useStore.getState().me?.settings.user_overrides ?? {}) };
  const next: UserOverride = { ...all[userId], ...patch };
  if (next.volume === 100) delete next.volume;
  if (!next.mute_voice) delete next.mute_voice;
  if (!next.mute_messages) delete next.mute_messages;
  if (Object.keys(next).length) all[userId] = next;
  else delete all[userId];
  return all;
}

export function setUserOverride(userId: string, patch: Partial<UserOverride>) {
  updateSettings({ user_overrides: withOverride(userId, patch) }).catch((e) => toast(e.message));
}

/** Applies a change locally only (live while dragging a slider); `setUserOverride` saves it. */
export function previewUserOverride(userId: string, patch: Partial<UserOverride>) {
  const me = useStore.getState().me;
  if (me) useStore.setState({ me: { ...me, settings: { ...me.settings, user_overrides: withOverride(userId, patch) } } });
}
