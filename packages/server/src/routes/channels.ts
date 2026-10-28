import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ChannelType, MessageType, Permissions, hasPermission, type Attachment, type AutoModRule,
} from '@opencord/shared';
import { authenticate, parse, type Ctx } from '../app';
import { extractUrls, fetchEmbed } from '../embeds';
import { imageSize, readHead } from '../files';
import { ApiError, badRequest, forbidden, inviteCode, json, notFound, randomToken, snowflake } from '../util';
import { channelCreateSchema, normalizeChannelName } from './guilds';
import { areFriends, isBlocked, mutualGuildIds } from './users';
import { profileOf, relayDmMessage, remoteRecipient, sendToRemote } from '../federation/relay';

const P = Permissions;

const messageSchema = z.object({
  content: z.string().default(''),
  nonce: z.string().max(64).optional(),
  message_reference: z.object({ message_id: z.string() }).nullable().optional(),
  sticker_ids: z.array(z.string()).max(3).optional(),
  attachments: z.array(z.object({ id: z.union([z.string(), z.number()]), filename: z.string().optional() })).optional(),
});

export default (ctx: Ctx) => async (app: FastifyInstance) => {
  const { db, store, hub, files, config } = ctx;
  const auth = authenticate(ctx);

  // In-memory rate limiting: slowmode per (channel,user) and global per user.
  const lastSent = new Map<string, number>();
  const recent = new Map<string, number[]>();
  const spamTracker = new Map<string, { content: string; count: number; at: number }>();

  const isPrivate = (row: any) => row.type === ChannelType.DM || row.type === ChannelType.GROUP_DM;
  const channelOr404 = (id: string, userId: string) => {
    const row = store.channelRow(id);
    if (!row || !hasPermission(store.channelPermissions(id, userId), P.VIEW_CHANNEL)) throw notFound('Channel');
    return row;
  };
  /**
   * Only permissions you hold in a channel can be granted or denied there (as in role editing).
   * Compares against the current overwrites, so re-saving someone else's untouched bits still works.
   */
  const checkOverwriteChange = (channelId: string, userId: string, before: any[], after: { id: string; allow: string; deny: string }[]) => {
    const mine = store.channelPermissions(channelId, userId);
    if ((mine & P.ADMINISTRATOR) === P.ADMINISTRATOR) return;
    const bits = (o?: { allow: string; deny: string }) => ({ allow: BigInt(o?.allow ?? '0'), deny: BigInt(o?.deny ?? '0') });
    const ids = new Set([...before.map((o) => o.id), ...after.map((o) => o.id)]);
    for (const oid of ids) {
      const a = bits(before.find((o) => o.id === oid));
      const b = bits(after.find((o) => o.id === oid));
      const changed = (a.allow ^ b.allow) | (a.deny ^ b.deny);
      if (changed & ~mine) throw forbidden("You can't change permissions you don't have yourself.");
    }
  };
  const checkParent = (guildId: string, parentId: string | null | undefined, selfId?: string) => {
    if (!parentId) return;
    const parent = store.channelRow(parentId);
    if (!parent || parent.guild_id !== guildId || parent.type !== ChannelType.GUILD_CATEGORY || parent.id === selfId) throw badRequest('Invalid category');
  };
  const broadcastChannel = (row: any) => {
    const ch = store.channel(store.channelRow(row.id));
    if (row.guild_id) hub.toGuild(row.guild_id, 'CHANNEL_UPDATE', ch);
    else hub.toUsers(store.recipientIds(row.id), 'CHANNEL_UPDATE', ch);
    return ch;
  };

  /* ───────────── channel CRUD ───────────── */

  app.get('/channels/:id', { preHandler: auth }, async (req) => store.channel(channelOr404((req.params as any).id, req.userId)));

  app.patch('/channels/:id', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const row = channelOr404(id, req.userId);
    if (row.type === ChannelType.GROUP_DM) {
      const body = parse(z.object({ name: z.string().max(100).nullable().optional(), icon: z.string().nullable().optional() }), req.body);
      if (body.name !== undefined) db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(body.name?.trim() || null, id);
      if (body.icon !== undefined) {
        files.remove(row.icon);
        db.prepare('UPDATE channels SET icon = ? WHERE id = ?').run(body.icon ? files.saveDataUrl('icons', body.icon, 4 * 1024 * 1024) : null, id);
      }
      if (body.name !== undefined) systemMessage(id, req.userId, MessageType.CHANNEL_NAME_CHANGE, body.name ?? '');
      return broadcastChannel(row);
    }
    if (!row.guild_id) throw forbidden();
    store.requireChannelPerm(id, req.userId, P.MANAGE_CHANNELS);
    const body = parse(channelCreateSchema.partial(), req.body);
    if (body.permission_overwrites !== undefined) {
      store.requireChannelPerm(id, req.userId, P.MANAGE_ROLES);
      checkOverwriteChange(id, req.userId, json<any[]>(row.overwrites, []), body.permission_overwrites as any[]);
    }
    if (body.parent_id !== undefined) {
      if (row.type === ChannelType.GUILD_CATEGORY && body.parent_id) throw badRequest('Categories cannot be nested');
      checkParent(row.guild_id, body.parent_id, id);
    }
    const sets: Record<string, unknown> = {};
    const changes: any[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || k === 'type') continue;
      const col = k === 'permission_overwrites' ? 'overwrites' : k;
      let val: unknown = v;
      if (k === 'name') val = normalizeChannelName(v as string, row.type);
      if (k === 'permission_overwrites') val = JSON.stringify(v);
      if (typeof v === 'boolean') val = +v;
      sets[col] = val;
      changes.push({ key: k, old: row[col], new: v });
    }
    if (Object.keys(sets).length) {
      db.prepare(`UPDATE channels SET ${Object.keys(sets).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...sets, id });
      store.audit(row.guild_id, req.userId, 'CHANNEL_UPDATE', id, changes);
    }
    return broadcastChannel(row);
  });

  app.delete('/channels/:id', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const row = channelOr404(id, req.userId);
    if (row.type === ChannelType.DM) {
      db.prepare('UPDATE channel_recipients SET closed = 1 WHERE channel_id = ? AND user_id = ?').run(id, req.userId);
      hub.toUsers([req.userId], 'CHANNEL_DELETE', store.channel(row));
      return { ok: true };
    }
    if (row.type === ChannelType.GROUP_DM) {
      removeRecipient(row, req.userId, req.userId);
      return { ok: true };
    }
    store.requireChannelPerm(id, req.userId, P.MANAGE_CHANNELS);
    const ch = store.channel(row);
    for (const [uid, v] of hub.voiceStates) if (v.channel_id === id) hub.leaveVoice(uid);
    db.transaction(() => {
      db.prepare('UPDATE channels SET parent_id = NULL WHERE parent_id = ?').run(id);
      db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    })();
    store.audit(row.guild_id, req.userId, 'CHANNEL_DELETE', id, [{ key: 'name', old: row.name }]);
    hub.toGuild(row.guild_id, 'CHANNEL_DELETE', ch);
    return ch;
  });

  app.put('/channels/:id/permissions/:oid', { preHandler: auth }, async (req) => {
    const { id, oid } = req.params as { id: string; oid: string };
    const row = channelOr404(id, req.userId);
    if (!row.guild_id) throw forbidden();
    store.requireChannelPerm(id, req.userId, P.MANAGE_ROLES);
    const body = parse(z.object({ type: z.union([z.literal(0), z.literal(1)]), allow: z.string().regex(/^\d+$/), deny: z.string().regex(/^\d+$/) }), req.body);
    const before = json<any[]>(row.overwrites, []);
    const ow = before.filter((o) => o.id !== oid);
    ow.push({ id: oid, ...body });
    checkOverwriteChange(id, req.userId, before, ow);
    db.prepare('UPDATE channels SET overwrites = ? WHERE id = ?').run(JSON.stringify(ow), id);
    store.audit(row.guild_id, req.userId, 'CHANNEL_OVERWRITE_UPDATE', id, [{ key: oid, new: body }]);
    return broadcastChannel(row);
  });

  app.delete('/channels/:id/permissions/:oid', { preHandler: auth }, async (req) => {
    const { id, oid } = req.params as { id: string; oid: string };
    const row = channelOr404(id, req.userId);
    if (!row.guild_id) throw forbidden();
    store.requireChannelPerm(id, req.userId, P.MANAGE_ROLES);
    const before = json<any[]>(row.overwrites, []);
    const ow = before.filter((o) => o.id !== oid);
    checkOverwriteChange(id, req.userId, before, ow);
    db.prepare('UPDATE channels SET overwrites = ? WHERE id = ?').run(JSON.stringify(ow), id);
    return broadcastChannel(row);
  });

  /* ───────────── group DM recipients ───────────── */

  function removeRecipient(row: any, actorId: string, uid: string) {
    if (actorId !== uid && row.owner_id !== actorId) throw forbidden('Only the group owner can remove members');
    const user = store.user(uid);
    const remaining = store.recipientIds(row.id).filter((r) => r !== uid);
    db.prepare('DELETE FROM channel_recipients WHERE channel_id = ? AND user_id = ?').run(row.id, uid);
    hub.toUsers([uid], 'CHANNEL_DELETE', store.channel(row, false));
    if (hub.voiceStates.get(uid)?.channel_id === row.id) hub.leaveVoice(uid);
    if (remaining.length === 0) {
      db.prepare('DELETE FROM channels WHERE id = ?').run(row.id);
      return;
    }
    if (row.owner_id === uid) db.prepare('UPDATE channels SET owner_id = ? WHERE id = ?').run(remaining[0], row.id);
    hub.toUsers(remaining, 'CHANNEL_RECIPIENT_REMOVE', { channel_id: row.id, user });
    systemMessage(row.id, actorId, MessageType.RECIPIENT_REMOVE, '', [uid]);
    broadcastChannel(row);
  }

  app.put('/channels/:id/recipients/:uid', { preHandler: auth }, async (req) => {
    const { id, uid } = req.params as { id: string; uid: string };
    const row = channelOr404(id, req.userId);
    if (row.type !== ChannelType.GROUP_DM) throw badRequest('Not a group DM');
    if (!areFriends(ctx, req.userId, uid)) throw forbidden('You can only add friends');
    const recipients = store.recipientIds(id);
    if (recipients.includes(uid)) return { ok: true };
    if (recipients.length >= config.limits.max_group_dm_size) throw badRequest(`Group DMs are limited to ${config.limits.max_group_dm_size} members`);
    db.prepare('INSERT INTO channel_recipients (channel_id, user_id) VALUES (?,?)').run(id, uid);
    const user = store.user(uid);
    hub.toUsers(recipients, 'CHANNEL_RECIPIENT_ADD', { channel_id: id, user });
    hub.toUsers([uid], 'CHANNEL_CREATE', store.channel(store.channelRow(id)));
    systemMessage(id, req.userId, MessageType.RECIPIENT_ADD, '', [uid]);
    return { ok: true };
  });

  app.delete('/channels/:id/recipients/:uid', { preHandler: auth }, async (req) => {
    const { id, uid } = req.params as { id: string; uid: string };
    const row = channelOr404(id, req.userId);
    if (row.type !== ChannelType.GROUP_DM) throw badRequest('Not a group DM');
    removeRecipient(row, req.userId, uid);
    return { ok: true };
  });

  /* ───────────── messages ───────────── */

  function systemMessage(channelId: string, authorId: string, type: number, content: string, mentions: string[] = [], reference?: string) {
    const row = store.channelRow(channelId);
    const id = snowflake();
    db.prepare('INSERT INTO messages (id, channel_id, guild_id, author_id, content, type, created_at, mentions, reference_id) VALUES (?,?,?,?,?,?,?,?,?)').run(
      id, channelId, row.guild_id, authorId, content, type, Date.now(), JSON.stringify(mentions), reference ?? null,
    );
    db.prepare('UPDATE channels SET last_message_id = ? WHERE id = ?').run(id, channelId);
    hub.toChannel(channelId, 'MESSAGE_CREATE', (uid) => store.message(store.messageRow(id), uid));
  }

  app.get('/channels/:id/messages', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    channelOr404(id, req.userId);
    store.requireChannelPerm(id, req.userId, P.READ_MESSAGE_HISTORY);
    const q = req.query as { before?: string; after?: string; around?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
    let rows: any[];
    // Snowflake strings sort numerically only when padded; ids have equal length within our epoch so compare via CAST.
    if (q.around) {
      const half = Math.floor(limit / 2);
      const before = db.prepare('SELECT * FROM messages WHERE channel_id = ? AND CAST(id AS INTEGER) < CAST(? AS INTEGER) ORDER BY CAST(id AS INTEGER) DESC LIMIT ?').all(id, q.around, half) as any[];
      const after = db.prepare('SELECT * FROM messages WHERE channel_id = ? AND CAST(id AS INTEGER) >= CAST(? AS INTEGER) ORDER BY CAST(id AS INTEGER) ASC LIMIT ?').all(id, q.around, limit - half) as any[];
      rows = [...after.reverse(), ...before];
    } else if (q.after) {
      rows = (db.prepare('SELECT * FROM messages WHERE channel_id = ? AND CAST(id AS INTEGER) > CAST(? AS INTEGER) ORDER BY CAST(id AS INTEGER) ASC LIMIT ?').all(id, q.after, limit) as any[]).reverse();
    } else if (q.before) {
      rows = db.prepare('SELECT * FROM messages WHERE channel_id = ? AND CAST(id AS INTEGER) < CAST(? AS INTEGER) ORDER BY CAST(id AS INTEGER) DESC LIMIT ?').all(id, q.before, limit) as any[];
    } else {
      rows = db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY CAST(id AS INTEGER) DESC LIMIT ?').all(id, limit) as any[];
    }
    // Newest first, like the reference API.
    return rows.map((r) => store.message(r, req.userId));
  });

  type Upload = { tmp: string; size: number; filename: string; mime: string };

  // Uploads stream to temp files; whatever a request didn't keep (rejected message, error) is dropped.
  app.addHook('onResponse', async (req) => {
    for (const u of ((req as any).uploads ?? []) as Upload[]) files.discard(u.tmp);
  });

  async function readMessageBody(req: FastifyRequest, canAttach: boolean): Promise<{ body: z.infer<typeof messageSchema>; uploads: Upload[] }> {
    if (!req.isMultipart()) return { body: parse(messageSchema, req.body), uploads: [] };
    // Make room up front (old media/messages go first when near the storage limit), using the
    // request size, so an upload that can't fit is turned away before it's received.
    if (canAttach) ctx.storage.ensureSpace(Number(req.headers['content-length']) || 0);
    let payload: unknown = {};
    const uploads: Upload[] = [];
    (req as any).uploads = uploads;
    const maxMb = config.storage.max_upload_mb;
    const tooLarge = () => new ApiError(413, `Files must be smaller than ${maxMb} MB`, 40005);
    try {
      for await (const part of req.parts({ limits: { fileSize: maxMb * 1024 * 1024 } })) {
        if (part.type === 'file') {
          if (!canAttach) throw forbidden('You cannot attach files here');
          const got = await files.receive(part.file);
          uploads.push({ tmp: got.tmp, size: got.size, filename: part.filename.slice(0, 200) || 'file', mime: part.mimetype });
          if (got.truncated) throw tooLarge();
        } else if (part.fieldname === 'payload_json') {
          payload = json(part.value as string, {});
        } else if (part.fieldname === 'content') {
          payload = { ...(payload as object), content: part.value };
        }
      }
    } catch (e: any) {
      if (e?.code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
      throw e;
    }
    return { body: parse(messageSchema, payload), uploads };
  }

  /** Returns a block reason, or null. May also time the author out. */
  function runAutoMod(row: any, userId: string, content: string, mentionCount: number): string | null {
    const rules = (db.prepare('SELECT * FROM automod_rules WHERE guild_id = ?').all(row.guild_id) as any[]).map(
      (r) => ({ id: r.id, ...JSON.parse(r.data) }) as AutoModRule,
    );
    if (!rules.length) return null;
    const perms = store.guildPermissions(row.guild_id, userId);
    if (hasPermission(perms, P.MANAGE_GUILD)) return null;
    const roles = store.memberRoleIds(row.guild_id, userId);
    const lower = content.toLowerCase();
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (rule.exempt_channels.includes(row.id) || rule.exempt_roles.some((r) => roles.includes(r))) continue;
      let hit: string | null = null;
      if (rule.trigger === 'keyword') {
        for (const kw of rule.keywords) {
          const k = kw.toLowerCase();
          const re = k.startsWith('*') || k.endsWith('*')
            ? new RegExp(k.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\S*'), 'i')
            : new RegExp(`(^|\\W)${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\W)`, 'i');
          if (re.test(lower) && !rule.allow_list.some((a) => lower.includes(a.toLowerCase()))) {
            hit = kw;
            break;
          }
        }
      } else if (rule.trigger === 'mention_spam') {
        if (mentionCount >= rule.mention_limit) hit = `${mentionCount} mentions`;
      } else if (rule.trigger === 'link') {
        if (extractUrls(content).length && !rule.allow_list.some((a) => lower.includes(a.toLowerCase()))) hit = 'link';
      } else if (rule.trigger === 'spam') {
        const key = `${row.guild_id}:${userId}`;
        const prev = spamTracker.get(key);
        const now = Date.now();
        if (prev && prev.content === lower && now - prev.at < 30_000) {
          prev.count++;
          prev.at = now;
          if (prev.count >= 4) hit = 'repeated messages';
        } else spamTracker.set(key, { content: lower, count: 1, at: now });
      }
      if (!hit) continue;
      let blocked: string | null = null;
      for (const action of rule.actions) {
        if (action.type === 'block') blocked = action.message || 'Your message was blocked by AutoMod.';
        if (action.type === 'timeout' && action.duration) {
          db.prepare('UPDATE members SET timeout_until = ? WHERE guild_id = ? AND user_id = ?').run(Date.now() + action.duration * 1000, row.guild_id, userId);
          hub.toGuild(row.guild_id, 'GUILD_MEMBER_UPDATE', store.member(row.guild_id, userId)!);
        }
        if (action.type === 'alert' && action.channel_id && store.channelRow(action.channel_id)) {
          const id = snowflake();
          db.prepare('INSERT INTO messages (id, channel_id, guild_id, author_id, content, type, created_at, embeds) VALUES (?,?,?,?,?,?,?,?)').run(
            id, action.channel_id, row.guild_id, userId, content.slice(0, 2000), MessageType.AUTO_MODERATION_ACTION, Date.now(),
            JSON.stringify([{ type: 'rich', title: `AutoMod: ${rule.name}`, description: `Matched: ${hit} in <#${row.id}>`, color: '#f23f43' }]),
          );
          db.prepare('UPDATE channels SET last_message_id = ? WHERE id = ?').run(id, action.channel_id);
          hub.toChannel(action.channel_id, 'MESSAGE_CREATE', (uid) => store.message(store.messageRow(id), uid));
        }
      }
      store.audit(row.guild_id, userId, 'AUTOMOD_BLOCK_MESSAGE', userId, [{ key: 'rule', new: rule.name }, { key: 'match', new: hit }]);
      if (blocked) return blocked;
    }
    return null;
  }

  app.post('/channels/:id/messages', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const row = channelOr404(id, req.userId);
    if (row.type === ChannelType.GUILD_CATEGORY) throw badRequest('Cannot send messages in a category');
    const perms = store.channelPermissions(id, req.userId);
    if (!hasPermission(perms, P.SEND_MESSAGES)) {
      const m = row.guild_id ? (db.prepare('SELECT timeout_until FROM members WHERE guild_id = ? AND user_id = ?').get(row.guild_id, req.userId) as any) : null;
      if (m?.timeout_until > Date.now()) throw new ApiError(403, 'You are timed out in this server.', 40008);
      throw forbidden('You do not have permission to send messages in this channel.');
    }
    const { body, uploads } = await readMessageBody(req, hasPermission(perms, P.ATTACH_FILES));
    const content = body.content.trim();
    if (!content && !uploads.length && !body.sticker_ids?.length) throw badRequest('Cannot send an empty message');
    if (content.length > config.limits.max_message_length) throw badRequest(`Messages are limited to ${config.limits.max_message_length} characters`);
    if (uploads.length && !hasPermission(perms, P.ATTACH_FILES)) throw forbidden('You cannot attach files here');

    // DMs: respect blocks and privacy settings.
    if (row.type === ChannelType.DM) {
      const other = store.recipientIds(id).find((r) => r !== req.userId);
      if (other) {
        if (isBlocked(ctx, other, req.userId) || isBlocked(ctx, req.userId, other)) {
          throw new ApiError(403, 'Your message could not be delivered. This is usually because you don\'t share a server with the recipient or the recipient is only accepting direct messages from friends.', 50007);
        }
        if (!areFriends(ctx, req.userId, other)) {
          const otherRow = store.userRow(other);
          const shared = mutualGuildIds(ctx, req.userId, other).length > 0;
          if (!otherRow || !shared || !store.settings(otherRow).allow_dms_from_guild_members) {
            throw new ApiError(403, "Your message could not be delivered. This is usually because you don't share a server with the recipient or the recipient is only accepting direct messages from friends.", 50007);
          }
        }
      }
    }

    // Rate limits.
    const bypassSlow = hasPermission(perms, P.MANAGE_MESSAGES) || hasPermission(perms, P.MANAGE_CHANNELS);
    const slowKey = `${id}:${req.userId}`;
    if (row.rate_limit_per_user > 0 && !bypassSlow) {
      const last = lastSent.get(slowKey) ?? 0;
      const wait = last + row.rate_limit_per_user * 1000 - Date.now();
      if (wait > 0) throw new ApiError(429, `Slowmode is enabled. Try again in ${Math.ceil(wait / 1000)}s.`, 20016);
    }
    const now = Date.now();
    const times = (recent.get(req.userId) ?? []).filter((t) => now - t < 10_000);
    if (times.length >= config.limits.messages_per_10s) throw new ApiError(429, 'You are sending messages too quickly.', 20028);
    times.push(now);
    recent.set(req.userId, times);

    // Mentions.
    const mentions = [...new Set([...content.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]))].filter((u) => store.userRow(u));
    let mentionRoles: string[] = [];
    let mentionEveryone = false;
    if (row.guild_id) {
      const roles = new Map(store.roles(row.guild_id).map((r) => [r.id, r]));
      mentionRoles = [...new Set([...content.matchAll(/<@&(\d+)>/g)].map((m) => m[1]))].filter(
        (r) => roles.has(r) && (roles.get(r)!.mentionable || hasPermission(perms, P.MENTION_EVERYONE)),
      );
      mentionEveryone = /(^|\s)@(everyone|here)\b/.test(content) && hasPermission(perms, P.MENTION_EVERYONE);
      const blocked = runAutoMod(row, req.userId, content, mentions.length + mentionRoles.length);
      if (blocked) throw new ApiError(400, blocked, 200000);
    }

    let referenceId: string | null = null;
    if (body.message_reference?.message_id) {
      const ref = store.messageRow(body.message_reference.message_id);
      if (ref && ref.channel_id === id) {
        referenceId = ref.id;
        if (!mentions.includes(ref.author_id) && ref.author_id !== req.userId) mentions.push(ref.author_id);
      }
    }

    // Near the storage limit this deletes old media/messages to make room (uploads were checked as they arrived).
    if (!uploads.length) ctx.storage.ensureSpace(content.length + 1024);

    const messageId = snowflake();
    const attachments: Attachment[] = uploads.map((u) => {
      const ext = u.filename.includes('.') ? u.filename.split('.').pop()! : 'bin';
      const size = u.mime.startsWith('image/') ? imageSize(readHead(u.tmp)) : null;
      const path = files.adopt(`attachments/${id}`, u.tmp, ext);
      return {
        id: snowflake(), filename: u.filename, url: `/uploads/${path}`, content_type: u.mime, size: u.size,
        width: size?.width ?? null, height: size?.height ?? null,
      };
    });
    const stickerIds = (body.sticker_ids ?? []).filter((s) => db.prepare('SELECT 1 FROM stickers WHERE id = ?').get(s));

    db.transaction(() => {
      db.prepare(
        `INSERT INTO messages (id, channel_id, guild_id, author_id, content, type, created_at, mention_everyone, mentions, mention_roles, attachments, sticker_ids, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        messageId, id, row.guild_id, req.userId, content, referenceId ? MessageType.REPLY : MessageType.DEFAULT, now, +mentionEveryone,
        JSON.stringify(mentions), JSON.stringify(mentionRoles), JSON.stringify(attachments), JSON.stringify(stickerIds), referenceId,
      );
      db.prepare('UPDATE channels SET last_message_id = ? WHERE id = ?').run(messageId, id);
      db.prepare(
        `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?,?,?,0)
         ON CONFLICT DO UPDATE SET last_message_id = excluded.last_message_id, mention_count = 0`,
      ).run(req.userId, id, messageId);
    })();
    lastSent.set(slowKey, now);

    // Reopen closed DMs for recipients and count mentions.
    let notify: string[] = [];
    if (isPrivate(row)) {
      const closed = (db.prepare('SELECT user_id FROM channel_recipients WHERE channel_id = ? AND closed = 1').all(id) as any[]).map((r) => r.user_id);
      if (closed.length) {
        db.prepare('UPDATE channel_recipients SET closed = 0 WHERE channel_id = ?').run(id);
        const ch = store.channel(store.channelRow(id));
        hub.toUsers(closed, 'CHANNEL_CREATE', ch);
      }
      notify = store.recipientIds(id).filter((u) => u !== req.userId);
    } else {
      const viewers = new Set(hub.channelViewers(id));
      const all = mentionEveryone ? store.guildMemberIds(row.guild_id) : [];
      const roleMembers = mentionRoles.length
        ? (db.prepare(`SELECT user_id FROM member_roles WHERE role_id IN (${mentionRoles.map(() => '?').join(',')})`).all(...mentionRoles) as any[]).map((r) => r.user_id)
        : [];
      notify = [...new Set([...mentions, ...all, ...roleMembers])].filter(
        (u) => u !== req.userId && (viewers.has(u) || hasPermission(store.channelPermissions(id, u), P.VIEW_CHANNEL)),
      );
    }
    // No unread badges from people you've blocked or whose messages you've muted.
    if (notify.length) {
      const silenced = new Set(
        (db.prepare('SELECT user_id FROM relationships WHERE other_id = ? AND type = 2').all(req.userId) as { user_id: string }[]).map((r) => r.user_id),
      );
      const mutedPath = `$.user_overrides."${req.userId}".mute_messages`;
      for (let i = 0; i < notify.length; i += 500) {
        const chunk = notify.slice(i, i + 500);
        for (const r of db
          .prepare(`SELECT id FROM users WHERE id IN (${chunk.map(() => '?').join(',')}) AND json_extract(settings, ?) = 1`)
          .all(...chunk, mutedPath) as { id: string }[])
          silenced.add(r.id);
      }
      notify = notify.filter((u) => !silenced.has(u));
    }
    const bump = db.prepare(
      `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?,?,NULL,1)
       ON CONFLICT DO UPDATE SET mention_count = mention_count + 1`,
    );
    for (const u of notify) bump.run(u, id);

    const msgFor = (uid: string) => ({ ...store.message(store.messageRow(messageId), uid), nonce: body.nonce });
    hub.toChannel(id, 'MESSAGE_CREATE', msgFor);
    relayDmMessage(ctx, id, messageId, req.userId);
    const result = msgFor(req.userId);

    // Link previews arrive later as an update.
    if (config.embeds.enabled && hasPermission(perms, P.EMBED_LINKS)) {
      const urls = extractUrls(content);
      if (urls.length) {
        Promise.all(urls.map((u) => fetchEmbed(u, config.embeds.timeout_ms))).then((embeds) => {
          const ok = embeds.filter(Boolean);
          if (!ok.length || !store.messageRow(messageId)) return;
          db.prepare('UPDATE messages SET embeds = ? WHERE id = ?').run(JSON.stringify(ok), messageId);
          hub.toChannel(id, 'MESSAGE_UPDATE', (uid) => store.message(store.messageRow(messageId), uid));
        });
      }
    }
    return result;
  });

  app.patch('/channels/:id/messages/:mid', { preHandler: auth }, async (req) => {
    const { id, mid } = req.params as { id: string; mid: string };
    const row = channelOr404(id, req.userId);
    const msg = store.messageRow(mid);
    if (!msg || msg.channel_id === undefined || msg.channel_id !== id) throw notFound('Message');
    if (msg.author_id !== req.userId) throw forbidden('You can only edit your own messages');
    if (msg.type !== MessageType.DEFAULT && msg.type !== MessageType.REPLY) throw badRequest('This message cannot be edited');
    const { content } = parse(z.object({ content: z.string().trim().min(1).max(config.limits.max_message_length) }), req.body);
    if (row.guild_id) {
      const blocked = runAutoMod(row, req.userId, content, 0);
      if (blocked) throw new ApiError(400, blocked, 200000);
    }
    const mentions = [...new Set([...content.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]))];
    db.prepare('UPDATE messages SET content = ?, edited_at = ?, mentions = ?, embeds = ? WHERE id = ?').run(content.trim(), Date.now(), JSON.stringify(mentions), '[]', mid);
    hub.toChannel(id, 'MESSAGE_UPDATE', (uid) => store.message(store.messageRow(mid), uid));
    const remoteEdit = remoteRecipient(ctx, id, req.userId);
    if (remoteEdit) sendToRemote(ctx, remoteEdit, { type: 'dm_message_update', from: profileOf(ctx, req.userId), id: mid, content: content.trim() });
    if (config.embeds.enabled) {
      const urls = extractUrls(content);
      if (urls.length) {
        Promise.all(urls.map((u) => fetchEmbed(u, config.embeds.timeout_ms))).then((embeds) => {
          const ok = embeds.filter(Boolean);
          if (!ok.length || !store.messageRow(mid)) return;
          db.prepare('UPDATE messages SET embeds = ? WHERE id = ?').run(JSON.stringify(ok), mid);
          hub.toChannel(id, 'MESSAGE_UPDATE', (uid) => store.message(store.messageRow(mid), uid));
        });
      }
    }
    return store.message(store.messageRow(mid), req.userId);
  });

  /** Deletes messages of this channel (ids from elsewhere are ignored) and returns the ids deleted. */
  function deleteMessages(row: any, ids: string[]): string[] {
    const mine = ids.map((mid) => store.messageRow(mid)).filter((m) => m?.channel_id === row.id);
    for (const m of mine) {
      for (const a of json<Attachment[]>(m.attachments, [])) files.remove(a.url.replace(/^\/uploads\//, ''));
    }
    ids = mine.map((m) => m.id);
    const del = db.prepare('DELETE FROM messages WHERE id = ? AND channel_id = ?');
    db.transaction(() => ids.forEach((mid) => del.run(mid, row.id)))();
    const last = db.prepare('SELECT id FROM messages WHERE channel_id = ? ORDER BY CAST(id AS INTEGER) DESC LIMIT 1').get(row.id) as any;
    db.prepare('UPDATE channels SET last_message_id = ? WHERE id = ?').run(last?.id ?? null, row.id);
    return ids;
  }

  app.delete('/channels/:id/messages/:mid', { preHandler: auth }, async (req) => {
    const { id, mid } = req.params as { id: string; mid: string };
    const row = channelOr404(id, req.userId);
    const msg = store.messageRow(mid);
    if (!msg || msg.channel_id !== id) throw notFound('Message');
    if (msg.author_id !== req.userId) {
      if (isPrivate(row)) throw forbidden();
      store.requireChannelPerm(id, req.userId, P.MANAGE_MESSAGES);
      store.audit(row.guild_id, req.userId, 'MESSAGE_DELETE', msg.author_id, [{ key: 'channel_id', new: id }]);
    }
    deleteMessages(row, [mid]);
    hub.toChannel(id, 'MESSAGE_DELETE', { id: mid, channel_id: id, guild_id: row.guild_id });
    const remoteDel = msg.author_id === req.userId ? remoteRecipient(ctx, id, req.userId) : null;
    if (remoteDel) sendToRemote(ctx, remoteDel, { type: 'dm_message_delete', from: profileOf(ctx, req.userId), id: mid });
    return { ok: true };
  });

  /* ── reports ── */

  app.post('/channels/:id/messages/:mid/report', { preHandler: auth }, async (req) => {
    const { id, mid } = req.params as { id: string; mid: string };
    const row = channelOr404(id, req.userId);
    const msg = store.messageRow(mid);
    if (!msg || msg.channel_id !== id) throw notFound('Message');
    if (msg.author_id === req.userId) throw badRequest("You can't report your own message.");
    const body = parse(
      z.object({ reason: z.enum(['spam', 'harassment', 'hate', 'nsfw', 'violence', 'self_harm', 'illegal', 'other']), details: z.string().max(1000).default('') }),
      req.body,
    );
    const snapshot = JSON.stringify({ content: msg.content, attachments: json(msg.attachments, []), created_at: msg.created_at, author: msg.author_id ? store.user(msg.author_id) : null });
    db.prepare(
      `INSERT INTO message_reports (id, message_id, channel_id, guild_id, author_id, reporter_id, reason, details, snapshot, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(message_id, reporter_id) DO UPDATE SET reason = excluded.reason, details = excluded.details, status = 'open'`,
    ).run(snowflake(), mid, id, row.guild_id ?? null, msg.author_id, req.userId, body.reason, body.details, snapshot, Date.now());
    return { ok: true };
  });

  app.post('/channels/:id/messages/bulk-delete', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const row = channelOr404(id, req.userId);
    if (!row.guild_id) throw forbidden();
    store.requireChannelPerm(id, req.userId, P.MANAGE_MESSAGES);
    const { messages } = parse(z.object({ messages: z.array(z.string()).min(1).max(100) }), req.body);
    const deleted = deleteMessages(row, messages);
    store.audit(row.guild_id, req.userId, 'MESSAGE_BULK_DELETE', id, [{ key: 'count', new: deleted.length }]);
    if (deleted.length) hub.toChannel(id, 'MESSAGE_DELETE_BULK', { ids: deleted, channel_id: id, guild_id: row.guild_id });
    return { ok: true };
  });

  app.get('/channels/:id/messages/search', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    channelOr404(id, req.userId);
    store.requireChannelPerm(id, req.userId, P.READ_MESSAGE_HISTORY);
    return searchMessages([id], req.query as any, req.userId);
  });

  app.get('/guilds/:id/messages/search', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    if (!store.isMember(id, req.userId)) throw notFound('Guild');
    const channels = store
      .guildChannels(id)
      .filter((c) => hasPermission(store.channelPermissions(c.id, req.userId), P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY))
      .map((c) => c.id);
    return searchMessages(channels, req.query as any, req.userId);
  });

  function searchMessages(channelIds: string[], q: { content?: string; author_id?: string; has?: string; mentions?: string; offset?: string }, viewer: string) {
    if (!channelIds.length) return { total: 0, messages: [] };
    const where = [`channel_id IN (${channelIds.map(() => '?').join(',')})`];
    const args: unknown[] = [...channelIds];
    if (q.content) {
      where.push("content LIKE ? ESCAPE '\\'");
      args.push(`%${q.content.replace(/[%_\\]/g, (c) => '\\' + c)}%`);
    }
    if (q.author_id) {
      where.push('author_id = ?');
      args.push(q.author_id);
    }
    if (q.mentions) {
      where.push('mentions LIKE ?');
      args.push(`%"${q.mentions}"%`);
    }
    if (q.has === 'file' || q.has === 'image') where.push("attachments != '[]'");
    if (q.has === 'link') where.push("content LIKE '%http%'");
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE ${where.join(' AND ')}`).get(...args) as any).c;
    const rows = db
      .prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY CAST(id AS INTEGER) DESC LIMIT 25 OFFSET ?`)
      .all(...args, Number(q.offset) || 0) as any[];
    return { total, messages: rows.map((r) => store.message(r, viewer)) };
  }

  /* ───────────── reactions ───────────── */

  function parseEmoji(raw: string) {
    const s = decodeURIComponent(raw);
    const custom = /^(.+):(\d+)$/.exec(s);
    return custom ? { id: custom[2], name: custom[1] } : { id: null, name: s };
  }

  app.put('/channels/:id/messages/:mid/reactions/:emoji/@me', { preHandler: auth }, async (req) => {
    const { id, mid, emoji } = req.params as { id: string; mid: string; emoji: string };
    const row = channelOr404(id, req.userId);
    const msg = store.messageRow(mid);
    if (!msg || msg.channel_id !== id) throw notFound('Message');
    const e = parseEmoji(emoji);
    const existing = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND emoji_id = ? AND emoji_name = ? LIMIT 1').get(mid, e.id ?? '', e.name);
    if (!existing) store.requireChannelPerm(id, req.userId, P.ADD_REACTIONS);
    if (e.id && !db.prepare('SELECT 1 FROM emojis WHERE id = ?').get(e.id)) throw badRequest('Unknown emoji');
    const count = (db.prepare('SELECT COUNT(DISTINCT emoji_id || emoji_name) AS c FROM reactions WHERE message_id = ?').get(mid) as any).c;
    if (!existing && count >= 20) throw badRequest('Maximum number of reactions reached (20)');
    if (row.type === ChannelType.DM) {
      const other = store.recipientIds(id).find((r) => r !== req.userId);
      if (other && (isBlocked(ctx, other, req.userId))) throw forbidden();
    }
    db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji_id, emoji_name, created_at) VALUES (?,?,?,?,?)').run(mid, req.userId, e.id ?? '', e.name, Date.now());
    hub.toChannel(id, 'MESSAGE_REACTION_ADD', { message_id: mid, channel_id: id, user_id: req.userId, emoji: e });
    return { ok: true };
  });

  app.delete('/channels/:id/messages/:mid/reactions/:emoji/:uid', { preHandler: auth }, async (req) => {
    const { id, mid, emoji } = req.params as { id: string; mid: string; emoji: string; uid: string };
    let { uid } = req.params as { uid: string };
    channelOr404(id, req.userId);
    if (store.messageRow(mid)?.channel_id !== id) throw notFound('Message');
    if (uid === '@me') uid = req.userId;
    if (uid !== req.userId) store.requireChannelPerm(id, req.userId, P.MANAGE_MESSAGES);
    const e = parseEmoji(emoji);
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji_id = ? AND emoji_name = ?').run(mid, uid, e.id ?? '', e.name);
    hub.toChannel(id, 'MESSAGE_REACTION_REMOVE', { message_id: mid, channel_id: id, user_id: uid, emoji: e });
    return { ok: true };
  });

  app.get('/channels/:id/messages/:mid/reactions/:emoji', { preHandler: auth }, async (req) => {
    const { id, mid, emoji } = req.params as { id: string; mid: string; emoji: string };
    channelOr404(id, req.userId);
    if (store.messageRow(mid)?.channel_id !== id) throw notFound('Message');
    const e = parseEmoji(emoji);
    return (db.prepare('SELECT user_id FROM reactions WHERE message_id = ? AND emoji_id = ? AND emoji_name = ? ORDER BY created_at LIMIT 100').all(mid, e.id ?? '', e.name) as any[]).map(
      (r) => store.user(r.user_id),
    );
  });

  /* ───────────── pins ───────────── */

  app.get('/channels/:id/pins', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    channelOr404(id, req.userId);
    return (db.prepare('SELECT * FROM messages WHERE channel_id = ? AND pinned = 1 ORDER BY CAST(id AS INTEGER) DESC').all(id) as any[]).map((r) => store.message(r, req.userId));
  });

  for (const method of ['PUT', 'DELETE'] as const) {
    app.route({
      method,
      url: '/channels/:id/pins/:mid',
      preHandler: auth,
      handler: async (req) => {
        const { id, mid } = req.params as { id: string; mid: string };
        const row = channelOr404(id, req.userId);
        store.requireChannelPerm(id, req.userId, row.guild_id ? P.PIN_MESSAGES : P.VIEW_CHANNEL);
        const msg = store.messageRow(mid);
        if (!msg || msg.channel_id !== id) throw notFound('Message');
        const pin = method === 'PUT';
        if (pin && (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ? AND pinned = 1').get(id) as any).c >= 250) {
          throw badRequest('Maximum number of pins reached (250)');
        }
        db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(+pin, mid);
        if (row.guild_id) store.audit(row.guild_id, req.userId, pin ? 'MESSAGE_PIN' : 'MESSAGE_UNPIN', msg.author_id, [{ key: 'message_id', new: mid }]);
        hub.toChannel(id, 'MESSAGE_UPDATE', (uid) => store.message(store.messageRow(mid), uid));
        hub.toChannel(id, 'CHANNEL_PINS_UPDATE', { channel_id: id });
        if (pin) systemMessage(id, req.userId, MessageType.CHANNEL_PINNED_MESSAGE, '', [], mid);
        return { ok: true };
      },
    });
  }

  /* ───────────── typing / ack ───────────── */

  app.post('/channels/:id/typing', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const row = channelOr404(id, req.userId);
    store.requireChannelPerm(id, req.userId, P.SEND_MESSAGES);
    const payload = { channel_id: id, user_id: req.userId, guild_id: row.guild_id, timestamp: Date.now() };
    hub.toUsers(hub.channelViewers(id).filter((u) => u !== req.userId), 'TYPING_START', payload);
    return { ok: true };
  });

  app.post('/channels/:id/messages/:mid/ack', { preHandler: auth }, async (req) => {
    const { id, mid } = req.params as { id: string; mid: string };
    channelOr404(id, req.userId);
    db.prepare(
      `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?,?,?,0)
       ON CONFLICT DO UPDATE SET last_message_id = excluded.last_message_id, mention_count = 0`,
    ).run(req.userId, id, mid);
    hub.toUsers([req.userId], 'MESSAGE_ACK', { channel_id: id, message_id: mid });
    return { ok: true };
  });

  /* ───────────── invites ───────────── */

  app.post('/channels/:id/invites', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const row = channelOr404(id, req.userId);
    if (!row.guild_id) throw badRequest('Cannot create invites for private channels');
    store.requireChannelPerm(id, req.userId, P.CREATE_INVITE);
    const body = parse(
      z.object({ max_age: z.number().int().min(0).max(604800).default(604800), max_uses: z.number().int().min(0).max(100).default(0), temporary: z.boolean().default(false), unique: z.boolean().default(false) }),
      req.body,
    );
    if (!body.unique) {
      const existing = db.prepare('SELECT * FROM invites WHERE channel_id = ? AND inviter_id = ? AND max_age = ? AND max_uses = ? AND temporary = ?').get(
        id, req.userId, body.max_age, body.max_uses, +body.temporary,
      ) as any;
      const { resolveInvite, serializeInvite } = await import('./invites');
      if (existing && resolveInvite(ctx, existing.code)) return serializeInvite(ctx, existing);
    }
    const code = inviteCode();
    db.prepare('INSERT INTO invites (code, guild_id, channel_id, inviter_id, max_uses, max_age, temporary, created_at) VALUES (?,?,?,?,?,?,?,?)').run(
      code, row.guild_id, id, req.userId, body.max_uses, body.max_age, +body.temporary, Date.now(),
    );
    store.audit(row.guild_id, req.userId, 'INVITE_CREATE', null, [{ key: 'code', new: code }]);
    const { serializeInvite } = await import('./invites');
    return serializeInvite(ctx, db.prepare('SELECT * FROM invites WHERE code = ?').get(code));
  });

  /* ───────────── calls ───────────── */

  app.post('/channels/:id/call/ring', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    channelOr404(id, req.userId);
    const { recipients } = parse(z.object({ recipients: z.array(z.string()).nullable().optional() }), req.body);
    hub.ring(id, recipients ?? null, false, req.userId);
    return { ok: true };
  });

  app.post('/channels/:id/call/stop-ringing', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    channelOr404(id, req.userId);
    const { recipients } = parse(z.object({ recipients: z.array(z.string()).nullable().optional() }), req.body);
    hub.ring(id, recipients ?? [req.userId], true);
    return { ok: true };
  });

  /* ───────────── webhooks ───────────── */

  app.post('/channels/:id/webhooks', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    const row = channelOr404(id, req.userId);
    if (!row.guild_id || row.type !== ChannelType.GUILD_TEXT && row.type !== ChannelType.GUILD_ANNOUNCEMENT) throw badRequest('Webhooks need a text channel');
    store.requireChannelPerm(id, req.userId, P.MANAGE_WEBHOOKS);
    const { name } = parse(z.object({ name: z.string().min(1).max(80) }), req.body);
    const wid = snowflake();
    const token = randomToken(48);
    db.prepare('INSERT INTO webhooks (id, guild_id, channel_id, name, token, creator_id, created_at) VALUES (?,?,?,?,?,?,?)').run(wid, row.guild_id, id, name, token, req.userId, Date.now());
    store.audit(row.guild_id, req.userId, 'WEBHOOK_CREATE', wid, [{ key: 'name', new: name }]);
    return { id: wid, guild_id: row.guild_id, channel_id: id, name, avatar: null, token, creator: store.user(req.userId), created_at: Date.now() };
  });

  app.patch('/webhooks/:wid', { preHandler: auth }, async (req) => {
    const { wid } = req.params as { wid: string };
    const w = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(wid) as any;
    if (!w) throw notFound('Webhook');
    store.requireGuildPerm(w.guild_id, req.userId, P.MANAGE_WEBHOOKS);
    const body = parse(z.object({ name: z.string().min(1).max(80).optional(), avatar: z.string().nullable().optional(), channel_id: z.string().optional() }), req.body);
    if (body.name) db.prepare('UPDATE webhooks SET name = ? WHERE id = ?').run(body.name, wid);
    if (body.avatar !== undefined) {
      files.remove(w.avatar);
      db.prepare('UPDATE webhooks SET avatar = ? WHERE id = ?').run(body.avatar ? files.saveDataUrl('avatars', body.avatar, 4 * 1024 * 1024) : null, wid);
    }
    if (body.channel_id) {
      const ch = store.channelRow(body.channel_id);
      if (!ch || ch.guild_id !== w.guild_id) throw badRequest('Invalid channel');
      db.prepare('UPDATE webhooks SET channel_id = ? WHERE id = ?').run(body.channel_id, wid);
    }
    return { ok: true };
  });

  app.delete('/webhooks/:wid', { preHandler: auth }, async (req) => {
    const { wid } = req.params as { wid: string };
    const w = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(wid) as any;
    if (!w) throw notFound('Webhook');
    store.requireGuildPerm(w.guild_id, req.userId, P.MANAGE_WEBHOOKS);
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(wid);
    store.audit(w.guild_id, req.userId, 'WEBHOOK_DELETE', wid, [{ key: 'name', old: w.name }]);
    return { ok: true };
  });

  // Unauthenticated: the token is the credential.
  app.post('/webhooks/:wid/:token', async (req) => {
    const { wid, token } = req.params as { wid: string; token: string };
    const w = db.prepare('SELECT * FROM webhooks WHERE id = ? AND token = ?').get(wid, token) as any;
    if (!w) throw notFound('Webhook');
    const body = parse(
      z.object({
        content: z.string().max(config.limits.max_message_length).default(''),
        username: z.string().max(80).optional(),
        avatar_url: z.string().optional(),
        embeds: z.array(z.object({ title: z.string().max(256).optional(), description: z.string().max(4096).optional(), url: z.string().optional(), color: z.union([z.string(), z.number()]).optional() })).max(10).optional(),
      }),
      req.body,
    );
    if (!body.content && !body.embeds?.length) throw badRequest('Cannot send an empty message');
    ctx.storage.ensureSpace(body.content.length + 4096);
    const id = snowflake();
    const embeds = (body.embeds ?? []).map((e) => ({ type: 'rich', ...e, color: typeof e.color === 'number' ? `#${e.color.toString(16).padStart(6, '0')}` : e.color }));
    db.prepare(
      'INSERT INTO messages (id, channel_id, guild_id, author_id, content, type, created_at, embeds, webhook_id, webhook_name, webhook_avatar) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, w.channel_id, w.guild_id, wid, body.content, 0, Date.now(), JSON.stringify(embeds), wid, body.username ?? w.name, w.avatar);
    db.prepare('UPDATE channels SET last_message_id = ? WHERE id = ?').run(id, w.channel_id);
    hub.toChannel(w.channel_id, 'MESSAGE_CREATE', (uid) => store.message(store.messageRow(id), uid));
    return { id };
  });

};
