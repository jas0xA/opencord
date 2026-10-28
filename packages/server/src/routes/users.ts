import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CONNECTION_PROVIDERS, ChannelType, RelationshipType, defaultUserSettings, passwordProblem, usernameProblem, type UserSettings,
} from '@opencord/shared';
import { authenticate, parse, type Ctx } from '../app';
import { ApiError, badRequest, forbidden, notFound, snowflake } from '../util';
import { checkPassword, hashPassword, usernameAvailable } from './auth';
import { isRemote, profileOf, resolveRemote, sendToRemote } from '../federation/relay';

const hex = z.string().regex(/^#[0-9a-f]{6}$/i).nullable();

/** Settings that need more than a type check. */
const settingsShapes = {
  status: z.enum(['online', 'idle', 'dnd', 'invisible']),
  theme: z.enum(['dark', 'light', 'ash', 'onyx', 'sync']),
  message_display: z.enum(['cozy', 'compact']),
  input_mode: z.enum(['vad', 'ptt']),
  user_overrides: z
    .record(
      z.string().regex(/^\d{1,20}$/),
      z.object({ volume: z.number().min(0).max(200).optional(), mute_voice: z.boolean().optional(), mute_messages: z.boolean().optional() }).strict(),
    )
    .refine((o) => Object.keys(o).length <= 2000, 'Too many entries'),
};

export function areFriends(ctx: Ctx, a: string, b: string) {
  return !!ctx.db.prepare('SELECT 1 FROM relationships WHERE user_id = ? AND other_id = ? AND type = 1').get(a, b);
}
export function isBlocked(ctx: Ctx, by: string, target: string) {
  return !!ctx.db.prepare('SELECT 1 FROM relationships WHERE user_id = ? AND other_id = ? AND type = 2').get(by, target);
}
export function mutualGuildIds(ctx: Ctx, a: string, b: string): string[] {
  return (
    ctx.db
      .prepare('SELECT m1.guild_id FROM members m1 JOIN members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = ? AND m2.user_id = ?')
      .all(a, b) as any[]
  ).map((r) => r.guild_id);
}

/** Finds or creates the 1:1 DM channel between two users. */
export function openDm(ctx: Ctx, a: string, b: string) {
  const { db, store, hub } = ctx;
  const existing = db
    .prepare(
      `SELECT c.id FROM channels c
       JOIN channel_recipients r1 ON r1.channel_id = c.id AND r1.user_id = ?
       JOIN channel_recipients r2 ON r2.channel_id = c.id AND r2.user_id = ?
       WHERE c.type = ?`,
    )
    .get(a, b, ChannelType.DM) as any;
  if (existing) {
    const reopened = db.prepare('UPDATE channel_recipients SET closed = 0 WHERE channel_id = ? AND user_id = ? AND closed = 1').run(existing.id, a);
    const ch = store.channel(store.channelRow(existing.id));
    if (reopened.changes) hub.toUsers([a], 'CHANNEL_CREATE', ch);
    return ch;
  }
  const id = snowflake();
  db.transaction(() => {
    db.prepare('INSERT INTO channels (id, type, created_at) VALUES (?,?,?)').run(id, ChannelType.DM, Date.now());
    db.prepare('INSERT INTO channel_recipients (channel_id, user_id) VALUES (?,?)').run(id, a);
    // The other side only sees it once a message arrives.
    db.prepare('INSERT INTO channel_recipients (channel_id, user_id, closed) VALUES (?,?,?)').run(id, b, a === b ? 0 : 1);
  })();
  const ch = store.channel(store.channelRow(id));
  hub.toUsers([a], 'CHANNEL_CREATE', ch);
  return ch;
}

/** Relationship rows and their gateway events (shared with the federation inbox). */
export function relationshipHelpers(ctx: Ctx) {
  const { db, store, hub } = ctx;
  const setStmt = db.prepare(
    `INSERT INTO relationships (user_id, other_id, type, since) VALUES (?,?,?,?)
     ON CONFLICT(user_id, other_id) DO UPDATE SET type = excluded.type, since = excluded.since`,
  );
  const delStmt = db.prepare('DELETE FROM relationships WHERE user_id = ? AND other_id = ?');
  const getStmt = db.prepare('SELECT type FROM relationships WHERE user_id = ? AND other_id = ?');
  const getRel = (a: string, b: string) => (getStmt.get(a, b) as any)?.type as number | undefined;
  return {
    setRel: (a: string, b: string, type: number) => void setStmt.run(a, b, type, Date.now()),
    delRel: (a: string, b: string) => void delStmt.run(a, b),
    getRel,
    emitRel(owner: string, other: string) {
      const type = getRel(owner, other);
      if (type === undefined) hub.toUsers([owner], 'RELATIONSHIP_REMOVE', { id: other, type: 0 });
      else hub.toUsers([owner], 'RELATIONSHIP_ADD', { id: other, type: type as any, user: store.user(other), nickname: null, since: Date.now() });
    },
    openDm: (a: string, b: string) => openDm(ctx, a, b),
  };
}

export default (ctx: Ctx) => async (app: FastifyInstance) => {
  const { db, store, hub, files, config } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  app.get('/users/@me', async (req) => store.selfUser(store.userRow(req.userId)!));

  app.patch('/users/@me', async (req) => {
    const body = parse(
      z.object({
        username: z.string().max(32).optional(),
        email: z.string().email().optional(),
        password: z.string().optional(),
        new_password: z.string().max(128).optional(),
        display_name: z.string().max(32).nullable().optional(),
        pronouns: z.string().max(40).optional(),
        bio: z.string().max(190).optional(),
        avatar: z.string().nullable().optional(),
        banner: z.string().nullable().optional(),
        banner_color: hex.optional(),
        accent_color: hex.optional(),
        theme_colors: z.tuple([z.string(), z.string()]).nullable().optional(),
        avatar_decoration: z.string().nullable().optional(),
        profile_effect: z.string().nullable().optional(),
        nameplate: z.string().nullable().optional(),
        display_name_style: z.object({ font: z.string().max(32), effect: z.string().max(32), colors: z.array(z.string()).max(2) }).nullable().optional(),
      }),
      req.body,
    );
    const user = store.userRow(req.userId)!;
    const sets: Record<string, unknown> = {};

    if (body.username !== undefined || body.email !== undefined || body.new_password !== undefined) {
      if (!body.password || !(await checkPassword(user.password_hash, body.password))) {
        throw badRequest('Invalid Form Body', { password: 'Password does not match.' });
      }
    }
    if (body.username !== undefined && body.username.toLowerCase() !== user.username) {
      const u = body.username.toLowerCase();
      const nameErr = usernameProblem(u);
      if (nameErr) throw badRequest('Invalid Form Body', { username: nameErr });
      if (!(await usernameAvailable(ctx, u, user.id))) throw badRequest('Invalid Form Body', { username: 'Username is unavailable' });
      sets.username = u;
      if (ctx.federation) {
        ctx.federation.publish('user', u, { id: user.id });
        ctx.federation.publish('user', user.username, { id: user.id }, true);
      }
    }
    if (body.email !== undefined && body.email.toLowerCase() !== user.email) {
      // Emails may be shared between a person's accounts, so no uniqueness check here.
      sets.email = body.email.toLowerCase();
    }
    if (body.new_password) {
      const pwErr = passwordProblem(body.new_password, { minLength: config.registration.min_password_length, username: (sets.username as string) ?? user.username });
      if (pwErr) throw badRequest('Invalid Form Body', { new_password: pwErr });
      sets.password_hash = await hashPassword(body.new_password);
    }
    for (const k of ['display_name', 'pronouns', 'bio', 'banner_color', 'accent_color'] as const) {
      if (body[k] !== undefined) sets[k] = typeof body[k] === 'string' ? (body[k] as string).trim() || (k === 'display_name' ? null : '') : body[k];
    }
    if (body.theme_colors !== undefined) sets.theme_colors = body.theme_colors ? JSON.stringify(body.theme_colors) : null;
    if (body.display_name_style !== undefined) sets.display_name_style = body.display_name_style ? JSON.stringify(body.display_name_style) : null;

    const maxAvatar = config.storage.max_avatar_mb * 1024 * 1024;
    for (const k of ['avatar', 'banner'] as const) {
      if (body[k] === undefined) continue;
      const value = body[k];
      // Banners can also be a claimed marketplace banner ("market:<item id>").
      if (k === 'banner' && value?.startsWith('market:')) {
        const itemId = value.slice(7);
        const item = db.prepare('SELECT category FROM marketplace_items WHERE id = ?').get(itemId) as any;
        const owned = db.prepare('SELECT 1 FROM marketplace_owned WHERE item_id = ? AND user_id = ?').get(itemId, req.userId);
        if (!item || !owned || item.category !== 'banner') throw badRequest('You do not own this item');
        if (!user.banner?.startsWith('market:')) files.remove(user.banner);
        sets.banner = value;
        continue;
      }
      sets[k] = files.updateImage(k + 's', user[k]?.startsWith('market:') ? null : user[k], value ?? null, maxAvatar);
    }
    // Cosmetics must be owned (claimed from the marketplace) before they can be equipped.
    for (const k of ['avatar_decoration', 'profile_effect', 'nameplate'] as const) {
      if (body[k] === undefined) continue;
      if (body[k]) {
        const item = db.prepare('SELECT category FROM marketplace_items WHERE id = ?').get(body[k]) as any;
        const owned = db.prepare('SELECT 1 FROM marketplace_owned WHERE item_id = ? AND user_id = ?').get(body[k], req.userId);
        if (!item || !owned || item.category !== k) throw badRequest('You do not own this item');
      }
      sets[k] = body[k];
    }

    if (Object.keys(sets).length) {
      const cols = Object.keys(sets).map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE users SET ${cols} WHERE id = @id`).run({ ...sets, id: req.userId });
    }
    if (sets.password_hash) {
      // Changing password signs out every other session.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.userId, req.sessionHash);
    }
    hub.broadcastUserUpdate(req.userId);
    return store.selfUser(store.userRow(req.userId)!);
  });

  app.patch('/users/@me/settings', async (req) => {
    const raw = parse(z.record(z.unknown()), req.body);
    const user = store.userRow(req.userId)!;
    const current = store.settings(user);
    const defaults = defaultUserSettings() as unknown as Record<string, unknown>;
    // Unknown keys are ignored; known ones must keep their type (and some their exact shape).
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!(k in defaults)) continue;
      const strict = settingsShapes[k as keyof typeof settingsShapes];
      if (strict) {
        const r = strict.safeParse(v);
        if (!r.success) throw badRequest('Invalid Form Body', { [k]: r.error.issues[0]?.message ?? 'Invalid value' });
        patch[k] = r.data;
        continue;
      }
      const d = defaults[k];
      const ok = d === null ? v === null || typeof v === 'object' : Array.isArray(d) ? Array.isArray(v) : typeof v === typeof d && v !== null;
      if (!ok) throw badRequest('Invalid Form Body', { [k]: `Expected ${Array.isArray(d) ? 'array' : d === null ? 'object or null' : typeof d}` });
      patch[k] = v;
    }
    const next = { ...current, ...patch } as Record<string, unknown>;
    const json = JSON.stringify(next);
    if (json.length > 64 * 1024) throw badRequest('Settings too large');
    db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(json, req.userId);
    hub.toUsers([req.userId], 'USER_SETTINGS_UPDATE', patch as Partial<UserSettings>);
    if ('custom_status' in patch || 'show_activity' in patch) hub.broadcastPresence(req.userId);
    if (typeof patch.status === 'string') hub.updatePresence(req.userId, { status: patch.status as UserSettings['status'] });
    return next;
  });

  app.get('/users/@me/sessions', async (req) => {
    return (db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_used DESC').all(req.userId) as any[]).map((s) => ({
      id: s.token_hash.slice(0, 16),
      current: s.token_hash === req.sessionHash,
      user_agent: s.user_agent,
      ip: s.ip,
      created_at: s.created_at,
      last_used: s.last_used,
    }));
  });

  app.delete('/users/@me/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ? AND token_hash != ?").run(req.userId, id, req.sessionHash);
    return { ok: true };
  });

  app.post('/users/@me/delete', async (req) => {
    const { password } = parse(z.object({ password: z.string() }), req.body);
    const user = store.userRow(req.userId)!;
    if (!(await checkPassword(user.password_hash, password))) throw badRequest('Invalid Form Body', { password: 'Password does not match.' });
    if (db.prepare('SELECT 1 FROM guilds WHERE owner_id = ?').get(req.userId)) {
      throw new ApiError(400, 'You must transfer ownership of or delete your servers before deleting your account.', 40011);
    }
    hub.kickUser(req.userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.userId);
    ctx.federation?.publish('user', user.username, { id: user.id }, true);
    return { ok: true };
  });

  app.get('/users/@me/data-export', async (req) => {
    const user = store.userRow(req.userId)!;
    const { password_hash, mfa_secret, ...safe } = user;
    return {
      user: safe,
      relationships: db.prepare('SELECT * FROM relationships WHERE user_id = ?').all(req.userId),
      connections: db.prepare('SELECT * FROM connections WHERE user_id = ?').all(req.userId),
      guilds: db.prepare('SELECT guild_id, nick, joined_at FROM members WHERE user_id = ?').all(req.userId),
      messages: db.prepare('SELECT id, channel_id, guild_id, content, attachments, created_at FROM messages WHERE author_id = ? ORDER BY id').all(req.userId),
      notes: db.prepare('SELECT * FROM notes WHERE user_id = ?').all(req.userId),
      inventory: db.prepare('SELECT * FROM marketplace_owned WHERE user_id = ?').all(req.userId),
    };
  });

  /* ── profiles ── */

  app.get('/users/:id/profile', async (req) => {
    const { id } = req.params as { id: string };
    const { guild_id } = req.query as { guild_id?: string };
    const row = store.userRow(id);
    if (!row) throw notFound('User');
    const mutualGuilds = mutualGuildIds(ctx, req.userId, id).map((gid) => {
      const m = db.prepare('SELECT nick FROM members WHERE guild_id = ? AND user_id = ?').get(gid, id) as any;
      return { id: gid, nick: m?.nick ?? null };
    });
    const mutualFriends = (
      db
        .prepare(
          `SELECT r1.other_id FROM relationships r1 JOIN relationships r2 ON r1.other_id = r2.other_id
           WHERE r1.user_id = ? AND r2.user_id = ? AND r1.type = 1 AND r2.type = 1`,
        )
        .all(req.userId, id) as any[]
    ).map((r) => store.user(r.other_id));
    const connections = store.connections(id, true).map((c) => (c.show_details ? c : { ...c, metadata: {} }));
    return {
      user: store.publicUser(row),
      connections,
      mutual_guilds: id === req.userId ? [] : mutualGuilds,
      mutual_friends: id === req.userId ? [] : mutualFriends,
      guild_member: guild_id && store.isMember(guild_id, req.userId) ? store.member(guild_id, id) : null,
    };
  });

  /* ── relationships ── */

  app.get('/users/@me/relationships', async (req) => hub.relationships(req.userId));

  const rel = relationshipHelpers(ctx);
  const setRel = { run: (a: string, b: string, type: number, _since?: number) => rel.setRel(a, b, type) };
  const delRel = { run: (a: string, b: string) => rel.delRel(a, b) };
  const { getRel, emitRel } = rel;

  function sendFriendRequest(me: string, targetId: string) {
    if (me === targetId) throw badRequest('You cannot add yourself as a friend.');
    const target = store.userRow(targetId);
    if (!target) throw notFound('User');
    const mine = getRel(me, targetId);
    const theirs = getRel(targetId, me);
    if (mine === RelationshipType.FRIEND) throw badRequest("You're already friends with that user!");
    if (theirs === RelationshipType.BLOCKED || mine === RelationshipType.BLOCKED) {
      throw new ApiError(400, "Hm, didn't work. Double check that the username is correct.", 80004);
    }
    const now = Date.now();
    // A user from another host: mirror the request to their home host. Their side decides
    // (privacy settings, blocks) and answers with friend_accept.
    if (isRemote(target as any)) {
      if (isRemote(store.userRow(me) as any)) throw badRequest('Add friends from your home server.');
      if (theirs === RelationshipType.OUTGOING) {
        setRel.run(me, targetId, RelationshipType.FRIEND, now);
        setRel.run(targetId, me, RelationshipType.FRIEND, now);
        sendToRemote(ctx, targetId, { type: 'friend_accept', from: profileOf(ctx, me) });
        openDm(ctx, me, targetId);
      } else {
        setRel.run(me, targetId, RelationshipType.OUTGOING, now);
        setRel.run(targetId, me, RelationshipType.INCOMING, now);
        sendToRemote(ctx, targetId, { type: 'friend_request', from: profileOf(ctx, me) });
      }
      emitRel(me, targetId);
      return;
    }
    if (theirs === RelationshipType.OUTGOING) {
      setRel.run(me, targetId, RelationshipType.FRIEND, now);
      setRel.run(targetId, me, RelationshipType.FRIEND, now);
    } else {
      const s = store.settings(target).friend_requests_from;
      const mutualGuild = mutualGuildIds(ctx, me, targetId).length > 0;
      const mutualFriend = !!db
        .prepare(
          `SELECT 1 FROM relationships r1 JOIN relationships r2 ON r1.other_id = r2.other_id
           WHERE r1.user_id = ? AND r2.user_id = ? AND r1.type = 1 AND r2.type = 1 LIMIT 1`,
        )
        .get(me, targetId);
      const allowed = s.everyone || (s.server_members && mutualGuild) || (s.friends_of_friends && mutualFriend);
      if (!allowed) throw new ApiError(400, 'This user is not accepting friend requests from you.', 80000);
      setRel.run(me, targetId, RelationshipType.OUTGOING, now);
      setRel.run(targetId, me, RelationshipType.INCOMING, now);
    }
    emitRel(me, targetId);
    emitRel(targetId, me);
    // New friends land in each other's DM list right away.
    if (getRel(me, targetId) === RelationshipType.FRIEND) {
      openDm(ctx, me, targetId);
      openDm(ctx, targetId, me);
    }
    hub.toUsers([me], 'PRESENCE_UPDATE', hub.presence(targetId));
    hub.toUsers([targetId], 'PRESENCE_UPDATE', hub.presence(me));
  }

  app.post('/users/@me/relationships', async (req) => {
    const { username } = parse(z.object({ username: z.string().min(1).max(32) }), req.body);
    const name = username.trim().replace(/^@/, '').toLowerCase();
    const local = name.includes('@') ? null : store.userByName(name);
    // "name@host", or a name that belongs to another host on the global network.
    const targetId = local?.id ?? (await resolveRemote(ctx, name).catch(() => null));
    if (!targetId) throw new ApiError(400, "Hm, didn't work. Double check that the username is correct.", 80004);
    sendFriendRequest(req.userId, targetId);
    return { ok: true };
  });

  app.put('/users/@me/relationships/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { type } = parse(z.object({ type: z.union([z.literal(1), z.literal(2)]).optional() }), req.body);
    if (type === RelationshipType.BLOCKED) {
      if (id === req.userId) throw badRequest('You cannot block yourself.');
      if (!store.userRow(id)) throw notFound('User');
      const wasLinked = getRel(req.userId, id) !== undefined;
      setRel.run(req.userId, id, RelationshipType.BLOCKED, Date.now());
      if (getRel(id, req.userId) !== RelationshipType.BLOCKED) delRel.run(id, req.userId);
      if (wasLinked && isRemote(store.userRow(id) as any)) sendToRemote(ctx, id, { type: 'friend_remove', from: profileOf(ctx, req.userId) });
      emitRel(req.userId, id);
      emitRel(id, req.userId);
      hub.onBlock(req.userId, id);
      return { ok: true };
    }
    sendFriendRequest(req.userId, id);
    return { ok: true };
  });

  app.delete('/users/@me/relationships/:id', async (req) => {
    const { id } = req.params as { id: string };
    const mine = getRel(req.userId, id);
    delRel.run(req.userId, id);
    if (mine !== undefined && mine !== RelationshipType.BLOCKED && isRemote(store.userRow(id) as any)) {
      sendToRemote(ctx, id, { type: 'friend_remove', from: profileOf(ctx, req.userId) });
    }
    // Unblocking leaves the other side untouched; anything else is symmetric.
    if (mine !== RelationshipType.BLOCKED && getRel(id, req.userId) !== RelationshipType.BLOCKED) delRel.run(id, req.userId);
    emitRel(req.userId, id);
    emitRel(id, req.userId);
    return { ok: true };
  });

  app.patch('/users/@me/relationships/:id', async (req) => {
    const { nickname } = parse(z.object({ nickname: z.string().max(32).nullable() }), req.body);
    db.prepare('UPDATE relationships SET nickname = ? WHERE user_id = ? AND other_id = ?').run(nickname || null, req.userId, (req.params as any).id);
    return { ok: true };
  });

  app.put('/users/@me/notes/:id', async (req) => {
    const { note } = parse(z.object({ note: z.string().max(256) }), req.body);
    const { id } = req.params as { id: string };
    if (note) db.prepare('INSERT INTO notes (user_id, target_id, note) VALUES (?,?,?) ON CONFLICT DO UPDATE SET note = excluded.note').run(req.userId, id, note);
    else db.prepare('DELETE FROM notes WHERE user_id = ? AND target_id = ?').run(req.userId, id);
    return { ok: true };
  });

  /* ── connections ── */

  app.put('/users/@me/connections/:type', async (req) => {
    const { type } = req.params as { type: string };
    const provider = CONNECTION_PROVIDERS.find((p) => p.id === type);
    if (!provider) throw badRequest('Unknown provider');
    const body = parse(z.object({ name: z.string().min(1).max(100), url: z.string().url().max(300).optional() }), req.body);
    const url = body.url ?? (provider.profileUrl ? provider.profileUrl.replace('{name}', encodeURIComponent(body.name)) : null);
    db.prepare(
      `INSERT INTO connections (user_id, type, name, url, verified, metadata) VALUES (?,?,?,?,0,'{}')
       ON CONFLICT(user_id, type, name) DO UPDATE SET url = excluded.url`,
    ).run(req.userId, type, body.name, url);
    hub.broadcastUserUpdate(req.userId);
    return store.connections(req.userId);
  });

  app.patch('/users/@me/connections/:type/:name', async (req) => {
    const { type, name } = req.params as { type: string; name: string };
    const body = parse(z.object({ visible: z.boolean().optional(), show_details: z.boolean().optional() }), req.body);
    if (body.visible !== undefined) db.prepare('UPDATE connections SET visible = ? WHERE user_id = ? AND type = ? AND name = ?').run(+body.visible, req.userId, type, name);
    if (body.show_details !== undefined)
      db.prepare('UPDATE connections SET show_details = ? WHERE user_id = ? AND type = ? AND name = ?').run(+body.show_details, req.userId, type, name);
    hub.broadcastUserUpdate(req.userId);
    return store.connections(req.userId);
  });

  app.delete('/users/@me/connections/:type/:name', async (req) => {
    const { type, name } = req.params as { type: string; name: string };
    db.prepare('DELETE FROM connections WHERE user_id = ? AND type = ? AND name = ?').run(req.userId, type, name);
    hub.broadcastUserUpdate(req.userId);
    return store.connections(req.userId);
  });

  /* ── private channels ── */

  app.post('/users/@me/channels', async (req) => {
    const body = parse(z.object({ recipient_id: z.string().optional(), recipients: z.array(z.string()).max(config.limits.max_group_dm_size - 1).optional() }), req.body);
    if (body.recipient_id) {
      if (!store.userRow(body.recipient_id)) throw notFound('User');
      return openDm(ctx, req.userId, body.recipient_id);
    }
    const others = [...new Set(body.recipients ?? [])].filter((r) => r !== req.userId);
    if (others.length === 1) return openDm(ctx, req.userId, others[0]);
    for (const r of others) if (!areFriends(ctx, req.userId, r)) throw forbidden('You can only add friends to a group DM.');
    const id = snowflake();
    db.transaction(() => {
      db.prepare('INSERT INTO channels (id, type, owner_id, created_at) VALUES (?,?,?,?)').run(id, ChannelType.GROUP_DM, req.userId, Date.now());
      for (const u of [req.userId, ...others]) db.prepare('INSERT INTO channel_recipients (channel_id, user_id) VALUES (?,?)').run(id, u);
    })();
    const ch = store.channel(store.channelRow(id));
    hub.toUsers([req.userId, ...others], 'CHANNEL_CREATE', ch);
    return ch;
  });

  app.delete('/users/@me/guilds/:id', async (req) => {
    const { id } = req.params as { id: string };
    const g = store.guildRow(id);
    if (!g || !store.isMember(id, req.userId)) throw notFound('Guild');
    if (g.owner_id === req.userId) throw badRequest('Transfer ownership before leaving your own server.');
    const user = store.user(req.userId);
    db.prepare('DELETE FROM members WHERE guild_id = ? AND user_id = ?').run(id, req.userId);
    if (hub.voiceStates.get(req.userId)?.guild_id === id) hub.leaveVoice(req.userId);
    hub.toUsers([req.userId], 'GUILD_DELETE', { id });
    hub.toGuild(id, 'GUILD_MEMBER_REMOVE', { guild_id: id, user });
    return { ok: true };
  });
};
