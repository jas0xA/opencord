// Users from other hosts, and the friend/DM events relayed between hosts.
//
// A user from another host is represented locally by a "remote user" row (home_host + home_id set,
// username "name@host", no password). Friendships and DMs with them are ordinary local rows; what
// a local user does to them is mirrored to their home host through the federation outbox, and
// events from their home host arrive in the inbox and are applied here.
import { ChannelType, MessageType, RelationshipType, defaultUserSettings } from '@opencord/shared';
import type { Ctx } from '../app';
import { fileUrl } from '../store';
import { json, snowflake } from '../util';
import { hostnameOf, toOrigin } from './index';

export interface RemoteProfile {
  id: string;
  username: string;
  display_name: string | null;
  avatar: string | null;
}

export const isRemote = (row: { home_host?: string | null } | null | undefined) => !!row?.home_host;

/** Finds or creates the local row for a user from another host, refreshing their profile. */
export function ensureRemoteUser(ctx: Ctx, origin: string, p: RemoteProfile): string {
  const { db } = ctx;
  const username = `${p.username}@${hostnameOf(origin)}`.slice(0, 80);
  const avatar = p.avatar && /^https?:\/\//.test(p.avatar) ? p.avatar : null;
  const existing = db.prepare('SELECT id FROM users WHERE home_host = ? AND home_id = ?').get(origin, p.id) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE users SET username = ?, display_name = ?, avatar = ? WHERE id = ?').run(username, p.display_name?.slice(0, 32) ?? null, avatar, existing.id);
    return existing.id;
  }
  // A stale row may hold the name (the remote user was renamed); free it.
  db.prepare("UPDATE users SET username = username || '~' || id WHERE username = ? AND home_host IS NOT NULL").run(username);
  const id = snowflake();
  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, display_name, avatar, email_verified, settings, created_at, home_host, home_id)
     VALUES (?,?,?,?,?,?,1,?,?,?,?)`,
  ).run(id, username, '', '!remote', p.display_name?.slice(0, 32) ?? null, avatar, JSON.stringify(defaultUserSettings()), Date.now(), origin, p.id);
  return id;
}

/** A local user's public profile as sent to other hosts. */
export function profileOf(ctx: Ctx, userId: string): RemoteProfile {
  const u = ctx.store.userRow(userId)!;
  const origin = ctx.federation!.origin;
  const avatar = fileUrl(u.avatar);
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    avatar: avatar ? (/^https?:/.test(avatar) ? avatar : `${origin}${avatar}`) : null,
  };
}

/** Resolves "name@host" (or a bare name another host owns) to a local remote-user id. */
export async function resolveRemote(ctx: Ctx, input: string): Promise<string | null> {
  const fed = ctx.federation;
  if (!fed) return null;
  let name = input.trim().replace(/^@/, '').toLowerCase();
  let origin: string | null = null;
  const at = name.lastIndexOf('@');
  if (at > 0) {
    const host = name.slice(at + 1);
    name = name.slice(0, at);
    // Prefer the directory's origin (keeps http:// for dev hosts); fall back to https.
    const claim = fed.getRecord(`user:${name}`);
    origin = claim && hostnameOf(claim.host) === host ? claim.host : toOrigin(host);
  } else {
    origin = await fed.usernameOwner(name);
  }
  if (!origin || origin === fed.origin) return null;
  const profile = await fed.lookupRemoteUser(origin, name);
  return profile ? ensureRemoteUser(ctx, origin, profile) : null;
}

/** Queues an event for a remote user's home host. */
export function sendToRemote(ctx: Ctx, remoteUserId: string, event: Record<string, unknown>) {
  const row = ctx.store.userRow(remoteUserId) as any;
  if (!ctx.federation || !row?.home_host) return;
  ctx.federation.enqueue(row.home_host, { ...event, to_id: row.home_id });
}

/* ───────────── inbox ───────────── */

type Helpers = {
  setRel: (a: string, b: string, type: number) => void;
  delRel: (a: string, b: string) => void;
  getRel: (a: string, b: string) => number | undefined;
  emitRel: (owner: string, other: string) => void;
  openDm: (a: string, b: string) => { id: string };
};

export function makeInboxHandler(ctx: Ctx, h: Helpers) {
  const { db, store, hub } = ctx;

  const localTarget = (event: any) => {
    const row = typeof event.to_id === 'string' ? (store.userRow(event.to_id) as any) : null;
    return row && !row.home_host && !row.disabled ? row : null;
  };

  return async (from: string, event: any) => {
    if (!event?.from || typeof event.from.id !== 'string' || typeof event.from.username !== 'string') throw new Error('Bad event');
    const target = localTarget(event);
    if (!target) throw new Error('Unknown recipient');
    const remote = ensureRemoteUser(ctx, from, event.from as RemoteProfile);
    hub.broadcastUserUpdate(remote);

    if (['call_state', 'pipe_open', 'pipe_produce', 'pipe_unproduce'].includes(event.type)) {
      // Calls are only for friends, like DMs.
      if (h.getRel(target.id, remote) !== RelationshipType.FRIEND || !ctx.callBridge) return { ok: false };
      return ctx.callBridge.handle(event, target, remote, h.openDm);
    }

    switch (event.type) {
      case 'friend_request': {
        if (h.getRel(target.id, remote) === RelationshipType.BLOCKED) return { ok: true };
        if (h.getRel(target.id, remote) === RelationshipType.OUTGOING || h.getRel(target.id, remote) === RelationshipType.FRIEND) {
          // Both asked: that's a friendship.
          becomeFriends(target.id, remote);
          return { ok: true, friends: true };
        }
        if (!store.settings(target).friend_requests_from.everyone) return { ok: false };
        h.setRel(target.id, remote, RelationshipType.INCOMING);
        h.setRel(remote, target.id, RelationshipType.OUTGOING);
        h.emitRel(target.id, remote);
        return { ok: true };
      }
      case 'friend_accept': {
        if (h.getRel(target.id, remote) === RelationshipType.OUTGOING) becomeFriends(target.id, remote);
        return { ok: true };
      }
      case 'friend_remove': {
        if (h.getRel(target.id, remote) !== RelationshipType.BLOCKED) h.delRel(target.id, remote);
        h.delRel(remote, target.id);
        h.emitRel(target.id, remote);
        return { ok: true };
      }
      case 'dm_message': {
        // Only friends can reach someone across hosts; this keeps the relay from becoming a spam vector.
        if (h.getRel(target.id, remote) !== RelationshipType.FRIEND) return { ok: false };
        const m = event.message ?? {};
        if (typeof m.id !== 'string' || typeof m.content !== 'string') throw new Error('Bad message');
        if (db.prepare('SELECT 1 FROM federation_messages WHERE origin = ? AND remote_id = ?').get(from, m.id)) return { ok: true };
        const dm = h.openDm(target.id, remote);
        const id = snowflake();
        const attachments = (Array.isArray(m.attachments) ? m.attachments : [])
          .filter((a: any) => typeof a?.url === 'string' && /^https?:\/\//.test(a.url))
          .slice(0, 10)
          .map((a: any) => ({
            id: snowflake(), filename: String(a.filename ?? 'file').slice(0, 200), url: a.url, content_type: String(a.content_type ?? 'application/octet-stream'),
            size: Number(a.size) || 0, width: Number(a.width) || null, height: Number(a.height) || null,
          }));
        const now = Date.now();
        db.transaction(() => {
          db.prepare('INSERT INTO messages (id, channel_id, guild_id, author_id, content, type, created_at, attachments) VALUES (?,?,?,?,?,?,?,?)').run(
            id, dm.id, null, remote, m.content.slice(0, ctx.config.limits.max_message_length), MessageType.DEFAULT, now, JSON.stringify(attachments),
          );
          db.prepare('UPDATE channels SET last_message_id = ? WHERE id = ?').run(id, dm.id);
          db.prepare('INSERT INTO federation_messages (origin, remote_id, local_id) VALUES (?,?,?)').run(from, m.id, id);
          db.prepare(
            `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?,?,NULL,1)
             ON CONFLICT DO UPDATE SET mention_count = mention_count + 1`,
          ).run(target.id, dm.id);
        })();
        const closed = db.prepare('UPDATE channel_recipients SET closed = 0 WHERE channel_id = ? AND user_id = ? AND closed = 1').run(dm.id, target.id);
        if (closed.changes) hub.toUsers([target.id], 'CHANNEL_CREATE', store.channel(store.channelRow(dm.id)));
        hub.toChannel(dm.id, 'MESSAGE_CREATE', (uid: string) => store.message(store.messageRow(id), uid));
        return { ok: true };
      }
      case 'dm_message_update':
      case 'dm_message_delete': {
        const map = db.prepare('SELECT local_id FROM federation_messages WHERE origin = ? AND remote_id = ?').get(from, String(event.id)) as { local_id: string } | undefined;
        const msg = map ? store.messageRow(map.local_id) : null;
        if (!msg || msg.author_id !== remote) return { ok: true };
        if (event.type === 'dm_message_delete') {
          db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
          hub.toChannel(msg.channel_id, 'MESSAGE_DELETE', { id: msg.id, channel_id: msg.channel_id, guild_id: null });
        } else if (typeof event.content === 'string') {
          db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(event.content.slice(0, ctx.config.limits.max_message_length), Date.now(), msg.id);
          hub.toChannel(msg.channel_id, 'MESSAGE_UPDATE', (uid: string) => store.message(store.messageRow(msg.id), uid));
        }
        return { ok: true };
      }
      case 'profile_update':
        return { ok: true }; // ensureRemoteUser above already refreshed the profile
      default:
        throw new Error(`Unknown event ${event.type}`);
    }
  };

  function becomeFriends(local: string, remote: string) {
    h.setRel(local, remote, RelationshipType.FRIEND);
    h.setRel(remote, local, RelationshipType.FRIEND);
    h.emitRel(local, remote);
    h.openDm(local, remote);
  }
}

/** Relays a message a local user sent in a DM with a remote user to that user's host. */
export function relayDmMessage(ctx: Ctx, channelId: string, messageId: string, authorId: string) {
  const ch = ctx.store.channelRow(channelId);
  if (!ctx.federation || ch?.type !== ChannelType.DM) return;
  const other = ctx.store.recipientIds(channelId).find((u) => u !== authorId);
  const row = other ? (ctx.store.userRow(other) as any) : null;
  if (!row?.home_host) return;
  const m = ctx.store.messageRow(messageId);
  const origin = ctx.federation.origin;
  sendToRemote(ctx, other!, {
    type: 'dm_message',
    from: profileOf(ctx, authorId),
    message: {
      id: messageId,
      content: m.content,
      created_at: m.created_at,
      attachments: json<any[]>(m.attachments, []).map((a) => ({ ...a, url: /^https?:/.test(a.url) ? a.url : `${origin}${a.url}` })),
    },
  });
}

/** The DM's remote recipient, if the DM is with a user from another host. */
export function remoteRecipient(ctx: Ctx, channelId: string, selfId: string): string | null {
  const ch = ctx.store.channelRow(channelId);
  if (ch?.type !== ChannelType.DM) return null;
  const other = ctx.store.recipientIds(channelId).find((u) => u !== selfId);
  return other && isRemote(ctx.store.userRow(other) as any) ? other : null;
}
