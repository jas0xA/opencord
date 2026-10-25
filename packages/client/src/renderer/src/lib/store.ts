import { create } from 'zustand';
import {
  ChannelType, GatewayOp, Permissions, RelationshipType, applyOverwrites, computeBasePermissions, hasPermission,
  type Channel, type GuildFull, type GuildMember, type InstanceInfo, type MarketplaceItem, type Message, type Presence,
  type PresenceStatus, type PublicUser, type ReadState, type Relationship, type Role, type SelfUser, type UserSettings,
  type VoiceState,
} from '@opencord/shared';
import { api, cdn as cdnUrl, configureApi } from './api';
import { GatewayClient } from './gateway';
import { notifyMessage } from './notify';
import { playSound, startRinging, stopRinging } from './sounds';
import { voice } from './voice';

/* ───────────── saved accounts (persisted encrypted by the main process) ───────────── */

export interface SavedAccount {
  id: string | null;
  username: string;
  avatar: string | null;
  token: string;
}

export interface SavedServer {
  url: string;
  name: string;
  token: string | null;
  username: string | null;
  avatar: string | null;
  /** Other signed-in accounts on this server (e.g. several accounts on one email) to switch to. */
  others?: SavedAccount[];
}

interface Accounts {
  servers: SavedServer[];
  last: string | null;
}

export async function loadAccounts(): Promise<Accounts> {
  try {
    const raw = window.native ? await window.native.loadSecrets() : localStorage.getItem('opencord.accounts');
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { servers: [], last: null };
}

export async function saveAccounts(a: Accounts) {
  const raw = JSON.stringify(a);
  if (window.native) await window.native.saveSecrets(raw);
  else localStorage.setItem('opencord.accounts', raw);
}

/* ───────────── routing ───────────── */

export type Route =
  | { kind: 'home'; view: 'friends' | 'marketplace' | 'explore' | 'dm'; channelId?: string }
  | { kind: 'guild'; guildId: string; channelId: string | null };

export interface ChannelMessages {
  list: Message[]; // oldest → newest
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
}

export type Modal =
  | { type: 'create-guild' }
  | { type: 'invite'; guildId: string; channelId?: string }
  | { type: 'create-channel'; guildId: string; parentId: string | null; channelType?: number }
  | { type: 'profile'; userId: string; guildId?: string }
  | { type: 'confirm'; title: string; body: string; confirm: string; danger?: boolean; onConfirm: () => Promise<void> | void }
  | { type: 'create-dm' }
  | { type: 'image'; url: string }
  | { type: 'moderate'; action: 'kick' | 'ban' | 'timeout'; guildId: string; userId: string }
  | { type: 'nickname'; guildId: string; userId: string }
  | { type: 'channel-settings'; channelId: string }
  | { type: 'screen-share' }
  | { type: 'pins'; channelId: string }
  | { type: 'leave-guild'; guildId: string }
  | { type: 'status' }
  | { type: 'publish-item' }
  | { type: 'report-message'; channelId: string; messageId: string; preview: string; author: string };

export interface AppState {
  // connection
  server: SavedServer | null;
  instance: InstanceInfo | null;
  connection: 'idle' | 'connecting' | 'connected' | 'disconnected';
  ready: boolean;

  // data
  me: SelfUser | null;
  users: Record<string, PublicUser>;
  guilds: Record<string, GuildFull>;
  guildOrder: string[];
  privateChannels: Record<string, Channel>;
  relationships: Record<string, Relationship>;
  presences: Record<string, Presence>;
  readStates: Record<string, ReadState>;
  messages: Record<string, ChannelMessages>;
  typing: Record<string, Record<string, number>>;
  voiceStates: Record<string, VoiceState>;
  calls: Record<string, { ringing: string[]; messageId: string }>;
  notes: Record<string, string>;
  marketplace: Record<string, MarketplaceItem>;

  // ui
  route: Route;
  history: Route[];
  future: Route[];
  modal: Modal | null;
  settings: null | { kind: 'user'; section: string } | { kind: 'guild'; guildId: string; section: string };
  showProfilePanel: boolean;
  showMemberList: boolean;
  replyingTo: Record<string, Message | null>;
  editing: { channelId: string; messageId: string } | null;
  toast: { text: string; kind: 'error' | 'info' } | null;
  voiceView: boolean;
}

const initial: AppState = {
  server: null,
  instance: null,
  connection: 'idle',
  ready: false,
  me: null,
  users: {},
  guilds: {},
  guildOrder: [],
  privateChannels: {},
  relationships: {},
  presences: {},
  readStates: {},
  messages: {},
  typing: {},
  voiceStates: {},
  calls: {},
  notes: {},
  marketplace: {},
  route: { kind: 'home', view: 'friends' },
  history: [],
  future: [],
  modal: null,
  settings: null,
  showProfilePanel: true,
  showMemberList: true,
  replyingTo: {},
  editing: null,
  toast: null,
  voiceView: false,
};

export const useStore = create<AppState>(() => initial);
const set = useStore.setState;
const get = useStore.getState;

let gateway: GatewayClient | null = null;

export function sendGateway(op: number, d: unknown) {
  gateway?.send(op, d);
}

/* ───────────── session lifecycle ───────────── */

export async function startSession(server: SavedServer, instance: InstanceInfo) {
  gateway?.close();
  configureApi(server.url, server.token ?? '');
  set({ ...initial, server, instance, connection: 'connecting', route: restoreRoute(server.url) });
  gateway = new GatewayClient(
    server.url,
    server.token!,
    handleDispatch,
    (s) => set({ connection: s }),
    (d) => voice.handleSfu(d),
    () => logout(true),
  );
  gateway.connect();
}

export async function logout(expired = false) {
  voice.leave();
  try {
    if (!expired) await api.post('/auth/logout');
  } catch {
    /* ignore */
  }
  gateway?.close();
  gateway = null;
  const accounts = await loadAccounts();
  const s = get().server;
  if (s) {
    accounts.servers = accounts.servers.map((x) => (x.url === s.url ? { ...x, token: null } : x));
    await saveAccounts(accounts);
  }
  set({ ...initial });
}

/**
 * Switches to another account on the current server. The current account stays signed in and is
 * kept in the server's `others` list so you can switch back. Pass a token for a freshly created
 * or logged-in account.
 */
export async function switchAccount(target: SavedAccount) {
  const s = get();
  if (!s.server || !s.instance || !s.me) return;
  voice.leave();
  const accounts = await loadAccounts();
  const saved = accounts.servers.find((x) => x.url === s.server!.url) ?? s.server;
  const current: SavedAccount | null = saved.token ? { id: s.me.id, username: s.me.username, avatar: s.me.avatar, token: saved.token } : null;
  const others = [...(saved.others ?? []).filter((o) => o.token !== target.token && o.username !== target.username), ...(current ? [current] : [])];
  const next: SavedServer = { ...saved, token: target.token, username: target.username, avatar: target.avatar, others };
  accounts.servers = accounts.servers.map((x) => (x.url === next.url ? next : x));
  await saveAccounts(accounts);
  await startSession(next, s.instance);
}

/** Keeps the current account signed in (as a saved account) and returns to the login screen to add another. */
export async function parkCurrentAccount() {
  const s = get();
  if (!s.server || !s.me) return;
  voice.leave();
  const accounts = await loadAccounts();
  accounts.servers = accounts.servers.map((x) =>
    x.url === s.server!.url && x.token
      ? { ...x, token: null, others: [...(x.others ?? []).filter((o) => o.username !== s.me!.username), { id: s.me!.id, username: s.me!.username, avatar: s.me!.avatar, token: x.token }] }
      : x,
  );
  await saveAccounts(accounts);
  gateway?.close();
  gateway = null;
  set({ ...initial });
}

/** Forgets a saved (inactive) account on the current server. */
export async function forgetAccount(username: string) {
  const s = get();
  if (!s.server) return;
  const accounts = await loadAccounts();
  accounts.servers = accounts.servers.map((x) => (x.url === s.server!.url ? { ...x, others: (x.others ?? []).filter((o) => o.username !== username) } : x));
  await saveAccounts(accounts);
}

function restoreRoute(url: string): Route {
  try {
    const r = JSON.parse(localStorage.getItem(`opencord.route.${url}`) ?? 'null');
    if (r && (r.kind === 'home' || r.kind === 'guild')) return r;
  } catch {
    /* ignore */
  }
  return { kind: 'home', view: 'friends' };
}

/* ───────────── navigation ───────────── */

export function navigate(route: Route, push = true) {
  const s = get();
  if (JSON.stringify(route) === JSON.stringify(s.route)) return;
  set({
    route,
    history: push ? [...s.history.slice(-50), s.route] : s.history,
    future: push ? [] : s.future,
    editing: null,
    voiceView: false,
  });
  if (s.server) localStorage.setItem(`opencord.route.${s.server.url}`, JSON.stringify(route));
  if (route.kind === 'guild' && route.guildId) localStorage.setItem(`opencord.lastChannel.${route.guildId}`, route.channelId ?? '');
}

export function goBack() {
  const s = get();
  const prev = s.history[s.history.length - 1];
  if (!prev) return;
  set({ route: prev, history: s.history.slice(0, -1), future: [s.route, ...s.future] });
}

export function goForward() {
  const s = get();
  const next = s.future[0];
  if (!next) return;
  set({ route: next, future: s.future.slice(1), history: [...s.history, s.route] });
}

export function openGuild(guildId: string) {
  const g = get().guilds[guildId];
  if (!g) return;
  const last = localStorage.getItem(`opencord.lastChannel.${guildId}`);
  const visible = sortedChannels(g).filter((c) => c.type !== ChannelType.GUILD_CATEGORY && canView(g, c));
  const channel = visible.find((c) => c.id === last) ?? visible.find((c) => c.type === ChannelType.GUILD_TEXT) ?? null;
  navigate({ kind: 'guild', guildId, channelId: channel?.id ?? null });
}

export function openDm(channelId: string) {
  navigate({ kind: 'home', view: 'dm', channelId });
}

export async function openDmWith(userId: string) {
  const existing = Object.values(get().privateChannels).find(
    (c) => c.type === ChannelType.DM && c.recipients?.some((r) => r.id === userId),
  );
  if (existing) return openDm(existing.id);
  const ch = await api.post<Channel>('/users/@me/channels', { recipient_id: userId });
  upsertPrivate(ch);
  openDm(ch.id);
}

export function toast(text: string, kind: 'error' | 'info' = 'error') {
  set({ toast: { text, kind } });
  setTimeout(() => {
    if (get().toast?.text === text) set({ toast: null });
  }, 4000);
}

export function openModal(modal: Modal) {
  set({ modal });
}
export function closeModal() {
  set({ modal: null });
}

/* ───────────── selectors / helpers ───────────── */

export function displayName(user: PublicUser | null | undefined, guildId?: string | null): string {
  if (!user) return 'Unknown';
  if (guildId) {
    const m = get().guilds[guildId]?.members.find((x) => x.user.id === user.id);
    if (m?.nick) return m.nick;
  }
  const rel = get().relationships[user.id];
  if (rel?.nickname) return rel.nickname;
  return user.display_name || user.username;
}

export function getUser(id: string): PublicUser | undefined {
  const s = get();
  if (s.me?.id === id) return s.me;
  return s.users[id];
}

export function statusOf(userId: string): PresenceStatus {
  const s = get();
  if (s.me?.id === userId) return s.presences[userId]?.status ?? s.me.settings.status ?? 'online';
  return s.presences[userId]?.status ?? 'offline';
}

export function sortedChannels(g: GuildFull): Channel[] {
  const cats = g.channels.filter((c) => c.type === ChannelType.GUILD_CATEGORY).sort((a, b) => a.position - b.position);
  const byParent = (pid: string | null) =>
    g.channels
      .filter((c) => c.type !== ChannelType.GUILD_CATEGORY && (c.parent_id ?? null) === pid)
      .sort((a, b) => {
        const av = a.type === ChannelType.GUILD_VOICE || a.type === ChannelType.GUILD_STAGE ? 1 : 0;
        const bv = b.type === ChannelType.GUILD_VOICE || b.type === ChannelType.GUILD_STAGE ? 1 : 0;
        return av - bv || a.position - b.position;
      });
  const out = [...byParent(null)];
  for (const c of cats) out.push(c, ...byParent(c.id));
  return out;
}

export function guildPermissions(g: GuildFull, userId = get().me?.id ?? ''): bigint {
  const member = g.members.find((m) => m.user.id === userId);
  if (!member) return 0n;
  const everyone = g.roles.find((r) => r.id === g.id);
  let perms = computeBasePermissions({
    isOwner: g.owner_id === userId,
    everyonePerms: BigInt(everyone?.permissions ?? '0'),
    memberRolePerms: g.roles.filter((r) => member.roles.includes(r.id)).map((r) => BigInt(r.permissions)),
  });
  if (member.communication_disabled_until && member.communication_disabled_until > Date.now() && g.owner_id !== userId && !hasPermission(perms, Permissions.ADMINISTRATOR)) {
    perms &= Permissions.VIEW_CHANNEL | Permissions.READ_MESSAGE_HISTORY;
  }
  return perms;
}

export function channelPermissions(g: GuildFull, c: Channel, userId = get().me?.id ?? ''): bigint {
  const base = guildPermissions(g, userId);
  const member = g.members.find((m) => m.user.id === userId);
  let overwrites = c.permission_overwrites;
  if (!overwrites.length && c.parent_id) overwrites = g.channels.find((x) => x.id === c.parent_id)?.permission_overwrites ?? [];
  return applyOverwrites({ base, guildId: g.id, userId, roleIds: member?.roles ?? [], overwrites });
}

export function canView(g: GuildFull, c: Channel) {
  if (c.type === ChannelType.GUILD_CATEGORY) {
    return g.channels.some((x) => x.parent_id === c.id && hasPermission(channelPermissions(g, x), Permissions.VIEW_CHANNEL)) || hasPermission(channelPermissions(g, c), Permissions.VIEW_CHANNEL);
  }
  return hasPermission(channelPermissions(g, c), Permissions.VIEW_CHANNEL);
}

export function can(flag: bigint, guildId: string, channelId?: string | null): boolean {
  const g = get().guilds[guildId];
  if (!g) return false;
  if (channelId) {
    const c = g.channels.find((x) => x.id === channelId);
    if (c) return hasPermission(channelPermissions(g, c), flag);
  }
  return hasPermission(guildPermissions(g), flag);
}

export function memberColor(guildId: string | null | undefined, userId: string): string | null {
  if (!guildId) return null;
  const g = get().guilds[guildId];
  const m = g?.members.find((x) => x.user.id === userId);
  if (!g || !m) return null;
  const roles = g.roles.filter((r) => m.roles.includes(r.id) && r.color).sort((a, b) => b.position - a.position);
  return roles[0]?.color ?? null;
}

export function highestRole(g: GuildFull, userId: string): Role | null {
  const m = g.members.find((x) => x.user.id === userId);
  if (!m) return null;
  return g.roles.filter((r) => m.roles.includes(r.id)).sort((a, b) => b.position - a.position)[0] ?? null;
}

export function findChannel(id: string): Channel | undefined {
  const s = get();
  if (s.privateChannels[id]) return s.privateChannels[id];
  for (const g of Object.values(s.guilds)) {
    const c = g.channels.find((x) => x.id === id);
    if (c) return c;
  }
  return undefined;
}

export function isUnread(channel: Channel): boolean {
  const rs = get().readStates[channel.id];
  if (!channel.last_message_id) return false;
  if (!rs?.last_message_id) return true;
  return BigInt(channel.last_message_id) > BigInt(rs.last_message_id);
}

export function mentionCount(channelId: string): number {
  return get().readStates[channelId]?.mention_count ?? 0;
}

/* ───────────── state mutation helpers ───────────── */

function cacheUsers(users: (PublicUser | undefined | null)[]) {
  const next = { ...get().users };
  let changed = false;
  for (const u of users) {
    if (u && (!next[u.id] || JSON.stringify(next[u.id]) !== JSON.stringify(u))) {
      next[u.id] = u;
      changed = true;
    }
  }
  if (changed) set({ users: next });
}

function upsertPrivate(ch: Channel) {
  cacheUsers(ch.recipients ?? []);
  set({ privateChannels: { ...get().privateChannels, [ch.id]: ch } });
}

function updateGuild(id: string, fn: (g: GuildFull) => GuildFull) {
  const g = get().guilds[id];
  if (!g) return;
  set({ guilds: { ...get().guilds, [id]: fn(g) } });
}

function updateChannel(ch: Channel) {
  if (ch.guild_id) {
    updateGuild(ch.guild_id, (g) => ({ ...g, channels: g.channels.some((c) => c.id === ch.id) ? g.channels.map((c) => (c.id === ch.id ? ch : c)) : [...g.channels, ch] }));
  } else if (get().privateChannels[ch.id] || ch.recipients) {
    upsertPrivate({ ...get().privateChannels[ch.id], ...ch });
  }
}

function bumpLastMessage(channelId: string, messageId: string) {
  const ch = findChannel(channelId);
  if (ch) updateChannel({ ...ch, last_message_id: messageId });
}

function updateMessages(channelId: string, fn: (list: Message[]) => Message[]) {
  const cm = get().messages[channelId];
  if (!cm) return;
  set({ messages: { ...get().messages, [channelId]: { ...cm, list: fn(cm.list) } } });
}

export function setReplying(channelId: string, m: Message | null) {
  set({ replyingTo: { ...get().replyingTo, [channelId]: m } });
}

/* ───────────── messages ───────────── */

export async function loadMessages(channelId: string, before?: string) {
  const cm = get().messages[channelId];
  if (cm?.loading) return;
  set({ messages: { ...get().messages, [channelId]: { list: cm?.list ?? [], hasMore: cm?.hasMore ?? true, loading: true, loaded: cm?.loaded ?? false } } });
  try {
    const q = before ? `?before=${before}&limit=50` : '?limit=50';
    const msgs = await api.get<Message[]>(`/channels/${channelId}/messages${q}`);
    cacheUsers(msgs.map((m) => m.author));
    const older = [...msgs].reverse();
    const current = get().messages[channelId]?.list ?? [];
    const merged = before ? [...older, ...current] : mergeById(older, current);
    set({ messages: { ...get().messages, [channelId]: { list: merged, hasMore: msgs.length === 50, loading: false, loaded: true } } });
  } catch (e) {
    set({ messages: { ...get().messages, [channelId]: { list: cm?.list ?? [], hasMore: false, loading: false, loaded: true } } });
    throw e;
  }
}

function mergeById(a: Message[], b: Message[]) {
  const map = new Map<string, Message>();
  for (const m of [...a, ...b]) map.set(m.id, m);
  return [...map.values()].sort((x, y) => (BigInt(x.id) < BigInt(y.id) ? -1 : 1));
}

let nonceSeq = 0;
export async function sendMessage(channelId: string, content: string, files: File[] = [], stickerIds: string[] = []) {
  const s = get();
  const reply = s.replyingTo[channelId];
  const nonce = `${Date.now()}${nonceSeq++}`;
  const body = { content, nonce, message_reference: reply ? { message_id: reply.id } : null, sticker_ids: stickerIds };
  // Optimistic pending message.
  if (s.me && !files.length) {
    const pending: Message & { pending?: boolean } = {
      id: `pending-${nonce}`, channel_id: channelId, guild_id: null, author: s.me, content, type: 0, created_at: Date.now(),
      edited_at: null, pinned: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [],
      reactions: [], sticker_ids: stickerIds, referenced_message: reply ?? null, message_reference: null, call: null,
      webhook_id: null, nonce, pending: true,
    };
    updateMessages(channelId, (l) => [...l, pending]);
  }
  setReplying(channelId, null);
  try {
    if (files.length) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(body));
      files.forEach((f, i) => form.append(`files[${i}]`, f, f.name));
      await api.post(`/channels/${channelId}/messages`, form);
    } else {
      await api.post(`/channels/${channelId}/messages`, body);
    }
  } catch (e: any) {
    updateMessages(channelId, (l) => l.filter((m) => m.nonce !== nonce || !m.id.startsWith('pending-')));
    toast(e.message);
  }
}

export async function ackChannel(channelId: string) {
  const ch = findChannel(channelId);
  if (!ch?.last_message_id) return;
  const rs = get().readStates[channelId];
  if (rs?.last_message_id === ch.last_message_id && !rs.mention_count) return;
  set({ readStates: { ...get().readStates, [channelId]: { channel_id: channelId, last_message_id: ch.last_message_id, mention_count: 0 } } });
  try {
    await api.post(`/channels/${channelId}/messages/${ch.last_message_id}/ack`);
  } catch {
    /* ignore */
  }
}

export async function updateSettings(patch: Partial<UserSettings>) {
  const me = get().me;
  if (me) set({ me: { ...me, settings: { ...me.settings, ...patch } } });
  await api.patch('/users/@me/settings', patch);
}

export function setStatus(status: PresenceStatus) {
  sendGateway(GatewayOp.PRESENCE_UPDATE, { status });
  updateSettings({ status }).catch(() => {});
}

/* ───────────── gateway dispatch ───────────── */

/** Strips self-only fields so embedded copies only ever hold public profile data. */
function toPublic(u: SelfUser | PublicUser): PublicUser {
  const { email, mfa_enabled, admin, settings, connections, inventory, ...pub } = u as SelfUser;
  void email; void mfa_enabled; void admin; void settings; void connections; void inventory;
  return pub;
}

/**
 * A user's profile changed: refresh every copy of that user the client holds (member lists, DMs,
 * friends, loaded messages) so the change shows everywhere immediately.
 */
function applyUserUpdate(d: SelfUser | PublicUser) {
  const s = get();
  const pub = toPublic(d);
  const id = pub.id;
  const patch: Partial<AppState> = { users: { ...s.users, [id]: pub } };
  if (id === s.me?.id) patch.me = { ...s.me!, ...d };

  let guildsChanged = false;
  const guilds = { ...s.guilds };
  for (const [gid, g] of Object.entries(guilds)) {
    if (g.members.some((m) => m.user.id === id)) {
      guilds[gid] = { ...g, members: g.members.map((m) => (m.user.id === id ? { ...m, user: pub } : m)) };
      guildsChanged = true;
    }
  }
  if (guildsChanged) patch.guilds = guilds;

  const rel = s.relationships[id];
  if (rel) patch.relationships = { ...s.relationships, [id]: { ...rel, user: pub } };

  let dmsChanged = false;
  const privateChannels = { ...s.privateChannels };
  for (const [cid, c] of Object.entries(privateChannels)) {
    if (c.recipients?.some((r) => r.id === id)) {
      privateChannels[cid] = { ...c, recipients: c.recipients.map((r) => (r.id === id ? pub : r)) };
      dmsChanged = true;
    }
  }
  if (dmsChanged) patch.privateChannels = privateChannels;

  let msgsChanged = false;
  const messages = { ...s.messages };
  for (const [cid, cm] of Object.entries(messages)) {
    if (!cm.list.some((m) => m.author.id === id || m.referenced_message?.author.id === id)) continue;
    messages[cid] = {
      ...cm,
      list: cm.list.map((m) => {
        const author = m.author.id === id && !m.webhook_id ? pub : m.author;
        const ref = m.referenced_message?.author.id === id ? { ...m.referenced_message, author: pub } : m.referenced_message;
        return author === m.author && ref === m.referenced_message ? m : { ...m, author, referenced_message: ref };
      }),
    };
    msgsChanged = true;
  }
  if (msgsChanged) patch.messages = messages;
  set(patch);
  // Lets open profile popouts refetch details that aren't on the user object (connections, mutuals).
  window.dispatchEvent(new CustomEvent('opencord:user-update', { detail: id }));
}

function handleDispatch(t: string, d: any) {
  const s = get();
  switch (t) {
    case 'READY': {
      const users: Record<string, PublicUser> = {};
      const guilds: Record<string, GuildFull> = {};
      const voiceStates: Record<string, VoiceState> = {};
      for (const g of d.guilds as GuildFull[]) {
        guilds[g.id] = g;
        for (const m of g.members) users[m.user.id] = m.user;
        for (const v of g.voice_states) voiceStates[v.user_id] = v;
      }
      const privateChannels: Record<string, Channel> = {};
      for (const c of d.private_channels as Channel[]) {
        privateChannels[c.id] = c;
        for (const u of c.recipients ?? []) users[u.id] = u;
      }
      for (const v of d.voice_states as VoiceState[]) voiceStates[v.user_id] = v;
      const relationships: Record<string, Relationship> = {};
      for (const r of d.relationships as Relationship[]) {
        relationships[r.id] = r;
        users[r.id] = r.user;
      }
      const presences: Record<string, Presence> = {};
      for (const p of d.presences as Presence[]) presences[p.user_id] = p;
      presences[d.user.id] = { user_id: d.user.id, status: d.user.settings.status, custom_status: d.user.settings.custom_status, activities: [] };
      const readStates: Record<string, ReadState> = {};
      for (const r of d.read_states as ReadState[]) readStates[r.channel_id] = r;
      const saved = d.user.settings.guild_positions as string[];
      const ids = Object.keys(guilds);
      const guildOrder = [...saved.filter((id) => guilds[id]), ...ids.filter((id) => !saved.includes(id))];
      let route = s.route;
      if (route.kind === 'guild' && !guilds[route.guildId]) route = { kind: 'home', view: 'friends' };
      if (route.kind === 'home' && route.view === 'dm' && route.channelId && !privateChannels[route.channelId]) route = { kind: 'home', view: 'friends' };
      set({
        me: d.user, users, guilds, guildOrder, privateChannels, relationships, presences, readStates, voiceStates,
        notes: d.notes, ready: true, route, messages: {},
      });
      applyAppearance(d.user.settings);
      // Remember who we are on this server for the server picker.
      loadAccounts().then((a) => {
        a.servers = a.servers.map((x) =>
          x.url === s.server?.url ? { ...x, username: d.user.username, avatar: d.user.avatar, others: (x.others ?? []).filter((o) => o.username !== d.user.username) } : x,
        );
        saveAccounts(a);
      });
      voice.onReconnect();
      break;
    }
    case 'USER_UPDATE':
      applyUserUpdate(d);
      break;
    case 'USER_SETTINGS_UPDATE':
      if (s.me) {
        set({ me: { ...s.me, settings: { ...s.me.settings, ...d } } });
        applyAppearance({ ...s.me.settings, ...d });
      }
      break;
    case 'RELATIONSHIP_ADD': {
      const prev = s.relationships[d.id];
      cacheUsers([d.user]);
      set({ relationships: { ...s.relationships, [d.id]: d } });
      if (d.type === RelationshipType.INCOMING && prev?.type !== RelationshipType.INCOMING) playSound('request');
      break;
    }
    case 'RELATIONSHIP_REMOVE': {
      const next = { ...s.relationships };
      delete next[d.id];
      set({ relationships: next });
      break;
    }
    case 'PRESENCE_UPDATE':
      set({ presences: { ...s.presences, [d.user_id]: d } });
      break;
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
      updateChannel(d);
      break;
    case 'CHANNEL_DELETE': {
      if (d.guild_id) updateGuild(d.guild_id, (g) => ({ ...g, channels: g.channels.filter((c) => c.id !== d.id) }));
      else {
        const pc = { ...s.privateChannels };
        delete pc[d.id];
        set({ privateChannels: pc });
      }
      const r = get().route;
      if ((r.kind === 'guild' && r.channelId === d.id) || (r.kind === 'home' && r.channelId === d.id)) {
        if (d.guild_id) openGuild(d.guild_id);
        else navigate({ kind: 'home', view: 'friends' }, false);
      }
      break;
    }
    case 'CHANNEL_RECIPIENT_ADD': {
      const ch = s.privateChannels[d.channel_id];
      if (ch) upsertPrivate({ ...ch, recipients: [...(ch.recipients ?? []), d.user] });
      break;
    }
    case 'CHANNEL_RECIPIENT_REMOVE': {
      const ch = s.privateChannels[d.channel_id];
      if (ch) upsertPrivate({ ...ch, recipients: (ch.recipients ?? []).filter((u) => u.id !== d.user.id) });
      break;
    }
    case 'GUILD_CREATE': {
      for (const m of (d as GuildFull).members) cacheUsers([m.user]);
      const vs = { ...get().voiceStates };
      for (const v of (d as GuildFull).voice_states) vs[v.user_id] = v;
      set({
        guilds: { ...get().guilds, [d.id]: d },
        guildOrder: get().guildOrder.includes(d.id) ? get().guildOrder : [...get().guildOrder, d.id],
        voiceStates: vs,
      });
      break;
    }
    case 'GUILD_UPDATE':
      updateGuild(d.id, (g) => ({ ...g, ...d }));
      break;
    case 'GUILD_DELETE': {
      const guilds = { ...s.guilds };
      delete guilds[d.id];
      set({ guilds, guildOrder: s.guildOrder.filter((x) => x !== d.id) });
      if (s.route.kind === 'guild' && s.route.guildId === d.id) navigate({ kind: 'home', view: 'friends' }, false);
      if (s.settings?.kind === 'guild' && s.settings.guildId === d.id) set({ settings: null });
      break;
    }
    case 'GUILD_MEMBER_ADD':
    case 'GUILD_MEMBER_UPDATE': {
      const m = d as GuildMember;
      cacheUsers([m.user]);
      updateGuild(m.guild_id, (g) => ({
        ...g,
        members: g.members.some((x) => x.user.id === m.user.id) ? g.members.map((x) => (x.user.id === m.user.id ? m : x)) : [...g.members, m],
        member_count: g.members.some((x) => x.user.id === m.user.id) ? g.member_count : g.member_count + 1,
      }));
      break;
    }
    case 'GUILD_MEMBER_REMOVE':
      updateGuild(d.guild_id, (g) => ({ ...g, members: g.members.filter((x) => x.user.id !== d.user.id), member_count: g.member_count - 1 }));
      break;
    case 'GUILD_ROLE_CREATE':
    case 'GUILD_ROLE_UPDATE':
      updateGuild(d.guild_id, (g) => ({
        ...g,
        roles: (g.roles.some((r) => r.id === d.role.id) ? g.roles.map((r) => (r.id === d.role.id ? d.role : r)) : [...g.roles, d.role]).sort((a, b) => a.position - b.position),
      }));
      break;
    case 'GUILD_ROLE_DELETE':
      updateGuild(d.guild_id, (g) => ({ ...g, roles: g.roles.filter((r) => r.id !== d.role_id), members: g.members.map((m) => ({ ...m, roles: m.roles.filter((r) => r !== d.role_id) })) }));
      break;
    case 'GUILD_EMOJIS_UPDATE':
      updateGuild(d.guild_id, (g) => ({ ...g, emojis: d.emojis }));
      break;
    case 'GUILD_STICKERS_UPDATE':
      updateGuild(d.guild_id, (g) => ({ ...g, stickers: d.stickers }));
      break;
    case 'GUILD_SOUNDBOARD_UPDATE':
      updateGuild(d.guild_id, (g) => ({ ...g, sounds: d.sounds }));
      break;
    case 'MESSAGE_CREATE': {
      const m = d as Message;
      cacheUsers([m.author]);
      const cm = get().messages[m.channel_id];
      if (cm) {
        const withoutPending = cm.list.filter((x) => !(x.id.startsWith('pending-') && x.nonce && x.nonce === m.nonce));
        if (!withoutPending.some((x) => x.id === m.id)) set({ messages: { ...get().messages, [m.channel_id]: { ...cm, list: [...withoutPending, m] } } });
      }
      bumpLastMessage(m.channel_id, m.id);
      // Typing stops when a message lands.
      const typing = get().typing[m.channel_id];
      if (typing?.[m.author.id]) {
        const next = { ...typing };
        delete next[m.author.id];
        set({ typing: { ...get().typing, [m.channel_id]: next } });
      }
      const me = get().me;
      if (m.author.id === me?.id) {
        set({ readStates: { ...get().readStates, [m.channel_id]: { channel_id: m.channel_id, last_message_id: m.id, mention_count: 0 } } });
      } else {
        const ch = findChannel(m.channel_id);
        const isPrivate = !m.guild_id;
        const member = m.guild_id ? get().guilds[m.guild_id]?.members.find((x) => x.user.id === me?.id) : null;
        const mentioned = isPrivate || m.mentions.includes(me?.id ?? '') || m.mention_everyone || m.mention_roles.some((r) => member?.roles.includes(r));
        if (mentioned) {
          const rs = get().readStates[m.channel_id];
          set({ readStates: { ...get().readStates, [m.channel_id]: { channel_id: m.channel_id, last_message_id: rs?.last_message_id ?? null, mention_count: (rs?.mention_count ?? 0) + 1 } } });
        }
        const r = get().route;
        const viewing = document.hasFocus() && ((r.kind === 'home' && r.channelId === m.channel_id) || (r.kind === 'guild' && r.channelId === m.channel_id));
        if (viewing) ackChannel(m.channel_id);
        else if (mentioned && ch && me?.settings.status !== 'dnd') notifyMessage(m, ch);
      }
      break;
    }
    case 'MESSAGE_UPDATE':
      cacheUsers([d.author]);
      updateMessages(d.channel_id, (l) => l.map((m) => (m.id === d.id ? d : m)));
      break;
    case 'MESSAGE_DELETE':
      updateMessages(d.channel_id, (l) => l.filter((m) => m.id !== d.id));
      break;
    case 'MESSAGE_DELETE_BULK':
      updateMessages(d.channel_id, (l) => l.filter((m) => !d.ids.includes(m.id)));
      break;
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE': {
      const add = t === 'MESSAGE_REACTION_ADD';
      const isMe = d.user_id === s.me?.id;
      updateMessages(d.channel_id, (l) =>
        l.map((m) => {
          if (m.id !== d.message_id) return m;
          const key = (e: { id: string | null; name: string }) => `${e.id ?? ''}:${e.name}`;
          const reactions = [...m.reactions];
          const i = reactions.findIndex((r) => key(r.emoji) === key(d.emoji));
          if (add) {
            if (i === -1) reactions.push({ emoji: d.emoji, count: 1, me: isMe });
            else reactions[i] = { ...reactions[i], count: reactions[i].count + 1, me: reactions[i].me || isMe };
          } else if (i !== -1) {
            const r = { ...reactions[i], count: reactions[i].count - 1, me: isMe ? false : reactions[i].me };
            if (r.count <= 0) reactions.splice(i, 1);
            else reactions[i] = r;
          }
          return { ...m, reactions };
        }),
      );
      break;
    }
    case 'MESSAGE_ACK':
      set({ readStates: { ...s.readStates, [d.channel_id]: { channel_id: d.channel_id, last_message_id: d.message_id, mention_count: 0 } } });
      break;
    case 'TYPING_START': {
      const ch = { ...(s.typing[d.channel_id] ?? {}), [d.user_id]: Date.now() + 10_000 };
      set({ typing: { ...s.typing, [d.channel_id]: ch } });
      setTimeout(() => {
        const cur = get().typing[d.channel_id];
        if (cur?.[d.user_id] && cur[d.user_id] <= Date.now()) {
          const next = { ...cur };
          delete next[d.user_id];
          set({ typing: { ...get().typing, [d.channel_id]: next } });
        }
      }, 10_500);
      break;
    }
    case 'VOICE_STATE_UPDATE': {
      const vs = { ...s.voiceStates };
      const prev = vs[d.user_id];
      if (d.channel_id) vs[d.user_id] = d;
      else delete vs[d.user_id];
      set({ voiceStates: vs });
      voice.onVoiceState(d, prev);
      if (d.user_id !== s.me?.id && voice.channelId) {
        if (d.channel_id === voice.channelId && prev?.channel_id !== voice.channelId) playSound('join');
        if (prev?.channel_id === voice.channelId && d.channel_id !== voice.channelId) playSound('leave');
      }
      break;
    }
    case 'CALL_CREATE':
    case 'CALL_UPDATE': {
      const prevRinging = s.calls[d.channel_id]?.ringing.includes(s.me?.id ?? '');
      set({ calls: { ...s.calls, [d.channel_id]: { ringing: d.ringing, messageId: d.message_id ?? s.calls[d.channel_id]?.messageId } } });
      const nowRinging = d.ringing.includes(s.me?.id ?? '');
      if (nowRinging && !prevRinging) startRinging();
      if (!nowRinging) stopRingingIfIdle();
      break;
    }
    case 'CALL_DELETE': {
      const calls = { ...s.calls };
      delete calls[d.channel_id];
      set({ calls });
      stopRingingIfIdle();
      break;
    }
    case 'MARKETPLACE_ITEM_CREATE':
    case 'MARKETPLACE_ITEM_UPDATE':
      set({ marketplace: { ...s.marketplace, [d.id]: d } });
      break;
    case 'MARKETPLACE_ITEM_DELETE': {
      const mp = { ...s.marketplace };
      delete mp[d.id];
      set({ marketplace: mp });
      break;
    }
    case 'SOUNDBOARD_PLAY': {
      const g = s.guilds[d.guild_id];
      const sound = g?.sounds.find((x) => x.id === d.sound_id);
      if (sound && !voice.deafened) {
        const a = new Audio(cdnUrl(sound.url) ?? undefined);
        a.volume = sound.volume * ((s.me?.settings.output_volume ?? 100) / 100);
        a.play().catch(() => {});
      }
      break;
    }
  }
}

/* ───────────── appearance ───────────── */

export function applyAppearance(settings: UserSettings) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme === 'sync' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
  root.dataset.display = settings.message_display;
  root.style.fontSize = `${settings.font_scale}px`;
  root.style.setProperty('--saturation', `${settings.saturation}%`);
  root.dataset.reducedMotion = String(settings.reduced_motion);
  root.dataset.underlineLinks = String(settings.underline_links);
  (document.body.style as any).zoom = `${settings.zoom}%`;
}

/* ───────────── sounds ───────────── */

function stopRingingIfIdle() {
  const s = get();
  const ringing = Object.values(s.calls).some((c) => c.ringing.includes(s.me?.id ?? ''));
  if (!ringing) stopRinging();
}
