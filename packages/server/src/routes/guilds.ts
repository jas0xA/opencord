import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ALL_PERMISSIONS, ChannelType, DEFAULT_EVERYONE_PERMISSIONS, Permissions, hasPermission, type AutoModRule,
} from '@opencord/shared';
import { publishGuild } from './discovery';
import { authenticate, parse, type Ctx } from '../app';
import { ApiError, badRequest, forbidden, json, notFound, snowflake } from '../util';

const overwriteSchema = z.object({ id: z.string(), type: z.union([z.literal(0), z.literal(1)]), allow: z.string(), deny: z.string() });
export const channelCreateSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.number().int().default(0),
  topic: z.string().max(1024).nullable().optional(),
  parent_id: z.string().nullable().optional(),
  position: z.number().int().optional(),
  nsfw: z.boolean().optional(),
  rate_limit_per_user: z.number().int().min(0).max(21600).optional(),
  bitrate: z.number().int().min(8000).max(384000).optional(),
  user_limit: z.number().int().min(0).max(99).optional(),
  permission_overwrites: z.array(overwriteSchema).optional(),
});

export function normalizeChannelName(name: string, type: number) {
  if (type === ChannelType.GUILD_TEXT || type === ChannelType.GUILD_ANNOUNCEMENT || type === ChannelType.GUILD_FORUM) {
    return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 100) || 'channel';
  }
  return name.trim().slice(0, 100);
}

interface TemplateData {
  name: string;
  description: string;
  roles: { id: string; name: string; color: string | null; hoist: boolean; permissions: string; mentionable: boolean }[];
  channels: { id: string; type: number; name: string; topic: string | null; parent_id: string | null; position: number; nsfw: boolean; rate_limit_per_user: number; overwrites: any[] }[];
  system_channel_id: string | null;
}

export default (ctx: Ctx) => async (app: FastifyInstance) => {
  const { db, store, hub, files, config } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const P = Permissions;
  const params = (req: any) => req.params as { id: string; uid?: string; rid?: string; eid?: string };
  const guildOr404 = (id: string, userId: string) => {
    const g = store.guildRow(id);
    if (!g || !store.isMember(id, userId)) throw notFound('Guild');
    return g;
  };
  const broadcastGuildUpdate = (id: string) => {
    hub.toGuild(id, 'GUILD_UPDATE', store.guild(store.guildRow(id)));
    if (store.guildRow(id)?.global) publishGuild(ctx, id);
  };
  const maxEmoji = config.storage.max_emoji_kb * 1024;

  function insertChannel(guildId: string, c: z.infer<typeof channelCreateSchema>, idOverride?: string) {
    const id = idOverride ?? snowflake();
    const position =
      c.position ?? ((db.prepare('SELECT MAX(position) AS p FROM channels WHERE guild_id = ?').get(guildId) as any).p ?? -1) + 1;
    db.prepare(
      `INSERT INTO channels (id, type, guild_id, parent_id, name, topic, position, nsfw, rate_limit_per_user, bitrate, user_limit, overwrites, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, c.type, guildId, c.parent_id ?? null, normalizeChannelName(c.name, c.type), c.topic ?? null, position, c.nsfw ? 1 : 0,
      c.rate_limit_per_user ?? 0, c.bitrate ?? 64000, c.user_limit ?? 0, JSON.stringify(c.permission_overwrites ?? []), Date.now(),
    );
    return id;
  }

  /* ───────────── guild CRUD ───────────── */

  app.post('/guilds', async (req) => {
    const body = parse(z.object({ name: z.string().min(2).max(100), icon: z.string().nullable().optional(), template: z.string().optional() }), req.body);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM members WHERE user_id = ?').get(req.userId) as any).c;
    if (count >= config.limits.max_guilds_per_user) throw new ApiError(400, `You can only be in ${config.limits.max_guilds_per_user} servers.`, 30001);

    let template: TemplateData | null = null;
    if (body.template) {
      template = json<TemplateData | null>(body.template, null);
      if (!template?.channels) throw badRequest('Invalid template');
    }
    const id = snowflake();
    const now = Date.now();
    const icon = body.icon ? files.updateImage('icons', null, body.icon, config.storage.max_avatar_mb * 1024 * 1024) : null;

    db.transaction(() => {
      db.prepare('INSERT INTO guilds (id, name, icon, owner_id, description, created_at) VALUES (?,?,?,?,?,?)').run(
        id, body.name.trim(), icon, req.userId, template?.description ?? '', now,
      );
      const everyone = template?.roles.find((r) => r.name === '@everyone');
      db.prepare('INSERT INTO roles (id, guild_id, name, position, permissions) VALUES (?,?,?,?,?)').run(
        id, id, '@everyone', 0, everyone?.permissions ?? DEFAULT_EVERYONE_PERMISSIONS.toString(),
      );
      db.prepare('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?,?,?)').run(id, req.userId, now);

      if (template) {
        const idMap = new Map<string, string>([[template.roles.find((r) => r.name === '@everyone')?.id ?? '0', id]]);
        template.roles
          .filter((r) => r.name !== '@everyone')
          .forEach((r, i) => {
            const rid = snowflake();
            idMap.set(r.id, rid);
            db.prepare('INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable) VALUES (?,?,?,?,?,?,?,?)').run(
              rid, id, r.name, r.color, +r.hoist, i + 1, r.permissions, +r.mentionable,
            );
          });
        const sorted = [...template.channels].sort((a, b) => (a.type === 4 ? -1 : 0) - (b.type === 4 ? -1 : 0));
        for (const c of sorted) {
          const cid = snowflake();
          idMap.set(c.id, cid);
          const overwrites = (c.overwrites ?? []).map((o: any) => ({ ...o, id: idMap.get(o.id) ?? o.id }));
          insertChannel(id, { ...c, parent_id: c.parent_id ? idMap.get(c.parent_id) ?? null : null, permission_overwrites: overwrites }, cid);
        }
        if (template.system_channel_id && idMap.has(template.system_channel_id)) {
          db.prepare('UPDATE guilds SET system_channel_id = ? WHERE id = ?').run(idMap.get(template.system_channel_id), id);
        }
      } else {
        const textCat = insertChannel(id, { name: 'Text Channels', type: ChannelType.GUILD_CATEGORY, position: 0 });
        const voiceCat = insertChannel(id, { name: 'Voice Channels', type: ChannelType.GUILD_CATEGORY, position: 1 });
        const general = insertChannel(id, { name: 'general', type: ChannelType.GUILD_TEXT, parent_id: textCat, position: 0 });
        insertChannel(id, { name: 'General', type: ChannelType.GUILD_VOICE, parent_id: voiceCat, position: 0 });
        db.prepare('UPDATE guilds SET system_channel_id = ? WHERE id = ?').run(general, id);
      }
    })();

    const full = store.guildFull(id);
    hub.toUsers([req.userId], 'GUILD_CREATE', full);
    return full;
  });

  app.get('/guilds/:id', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    return store.guildFull(id);
  });

  app.patch('/guilds/:id', async (req) => {
    const { id } = params(req);
    const g = guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_GUILD);
    const body = parse(
      z.object({
        name: z.string().min(2).max(100).optional(),
        icon: z.string().nullable().optional(),
        banner: z.string().nullable().optional(),
        banner_preset: z.number().int().min(0).max(9).optional(),
        description: z.string().max(300).optional(),
        traits: z.array(z.object({ emoji: z.string().max(64).nullable(), label: z.string().max(24) })).max(5).optional(),
        tag: z.object({ text: z.string().min(2).max(4), badge: z.number().int().min(0).max(31), color: z.string() }).nullable().optional(),
        system_channel_id: z.string().nullable().optional(),
        rules_channel_id: z.string().nullable().optional(),
        afk_channel_id: z.string().nullable().optional(),
        afk_timeout: z.number().int().optional(),
        verification_level: z.number().int().min(0).max(4).optional(),
        explicit_content_filter: z.number().int().min(0).max(2).optional(),
        default_notifications: z.number().int().min(0).max(1).optional(),
        features: z.array(z.string()).optional(),
        vanity_code: z.string().regex(/^[a-z0-9-]{2,32}$/).nullable().optional(),
        owner_id: z.string().optional(),
      }),
      req.body,
    );
    const sets: Record<string, unknown> = {};
    const changes: { key: string; old?: unknown; new?: unknown }[] = [];
    const simple = ['name', 'banner_preset', 'description', 'system_channel_id', 'rules_channel_id', 'afk_channel_id', 'afk_timeout',
      'verification_level', 'explicit_content_filter', 'default_notifications', 'vanity_code'] as const;
    for (const k of simple) {
      if (body[k] !== undefined && body[k] !== g[k]) {
        sets[k] = body[k];
        changes.push({ key: k, old: g[k], new: body[k] });
      }
    }
    for (const k of ['traits', 'tag', 'features'] as const) {
      if (body[k] !== undefined) {
        sets[k] = body[k] === null ? null : JSON.stringify(body[k]);
        changes.push({ key: k, old: json(g[k], null), new: body[k] });
      }
    }
    for (const k of ['icon', 'banner'] as const) {
      if (body[k] === undefined) continue;
      sets[k] = files.updateImage(k + 's', g[k], body[k] ?? null, config.storage.max_avatar_mb * 1024 * 1024);
      changes.push({ key: k });
    }
    if (body.vanity_code && db.prepare('SELECT 1 FROM guilds WHERE vanity_code = ? AND id != ?').get(body.vanity_code, id)) {
      throw badRequest('Invalid Form Body', { vanity_code: 'Vanity URL is already taken' });
    }
    if (body.owner_id !== undefined && body.owner_id !== g.owner_id) {
      if (g.owner_id !== req.userId) throw forbidden('Only the owner can transfer ownership');
      if (!store.isMember(id, body.owner_id)) throw badRequest('New owner must be a member');
      sets.owner_id = body.owner_id;
      changes.push({ key: 'owner_id', old: g.owner_id, new: body.owner_id });
    }
    if (Object.keys(sets).length) {
      db.prepare(`UPDATE guilds SET ${Object.keys(sets).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...sets, id });
      store.audit(id, req.userId, 'GUILD_UPDATE', id, changes);
      broadcastGuildUpdate(id);
    }
    return store.guild(store.guildRow(id));
  });

  app.delete('/guilds/:id', async (req) => {
    const { id } = params(req);
    const g = guildOr404(id, req.userId);
    if (g.owner_id !== req.userId) throw forbidden('Only the owner can delete the server');
    const members = store.guildMemberIds(id);
    for (const [uid, v] of hub.voiceStates) if (v.guild_id === id) hub.leaveVoice(uid);
    db.prepare('DELETE FROM guilds WHERE id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE guild_id = ?').run(id);
    hub.toUsers(members, 'GUILD_DELETE', { id });
    if (g.global) ctx.federation?.publish('guild', id, {}, true);
    return { ok: true };
  });

  app.get('/guilds/:id/template', async (req) => {
    const { id } = params(req);
    const g = guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_GUILD);
    const data: TemplateData = {
      name: g.name,
      description: g.description,
      roles: store.roles(id).map((r) => ({ id: r.id, name: r.name, color: r.color, hoist: r.hoist, permissions: r.permissions, mentionable: r.mentionable })),
      channels: store.guildChannels(id).map((c) => ({
        id: c.id, type: c.type, name: c.name ?? '', topic: c.topic, parent_id: c.parent_id, position: c.position, nsfw: c.nsfw,
        rate_limit_per_user: c.rate_limit_per_user, overwrites: c.permission_overwrites,
      })),
      system_channel_id: g.system_channel_id,
    };
    return data;
  });

  /* ───────────── channels ───────────── */

  app.post('/guilds/:id/channels', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_CHANNELS);
    const body = parse(channelCreateSchema, req.body);
    const allowed: number[] = [ChannelType.GUILD_TEXT, ChannelType.GUILD_VOICE, ChannelType.GUILD_CATEGORY, ChannelType.GUILD_ANNOUNCEMENT, ChannelType.GUILD_STAGE, ChannelType.GUILD_FORUM];
    if (!allowed.includes(body.type)) throw badRequest('Invalid channel type');
    if (body.parent_id) {
      const parent = store.channelRow(body.parent_id);
      if (!parent || parent.guild_id !== id || parent.type !== ChannelType.GUILD_CATEGORY) throw badRequest('Invalid parent');
      if (!body.permission_overwrites) body.permission_overwrites = json(parent.overwrites, []);
    }
    const cid = insertChannel(id, body);
    const ch = store.channel(store.channelRow(cid));
    store.audit(id, req.userId, 'CHANNEL_CREATE', cid, [{ key: 'name', new: ch.name }, { key: 'type', new: ch.type }]);
    hub.toGuild(id, 'CHANNEL_CREATE', ch);
    return ch;
  });

  app.patch('/guilds/:id/channels', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_CHANNELS);
    const body = parse(z.array(z.object({ id: z.string(), position: z.number().int(), parent_id: z.string().nullable().optional() })).max(500), req.body);
    const upd = db.prepare('UPDATE channels SET position = ?, parent_id = COALESCE(?, parent_id) WHERE id = ? AND guild_id = ?');
    const clearParent = db.prepare('UPDATE channels SET parent_id = NULL WHERE id = ? AND guild_id = ?');
    db.transaction(() => {
      for (const c of body) {
        upd.run(c.position, c.parent_id ?? null, c.id, id);
        if (c.parent_id === null) clearParent.run(c.id, id);
      }
    })();
    for (const c of body) {
      const row = store.channelRow(c.id);
      if (row) hub.toGuild(id, 'CHANNEL_UPDATE', store.channel(row));
    }
    return { ok: true };
  });

  /* ───────────── members ───────────── */

  app.get('/guilds/:id/members', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    const { query } = req.query as { query?: string };
    let members = store.members(id);
    if (query) {
      const q = query.toLowerCase();
      members = members.filter(
        (m) => m.user.username.includes(q) || m.user.display_name?.toLowerCase().includes(q) || m.nick?.toLowerCase().includes(q),
      );
    }
    return members;
  });

  app.patch('/guilds/:id/members/:uid', async (req) => {
    const { id } = params(req);
    let uid = params(req).uid!;
    if (uid === '@me') uid = req.userId;
    guildOr404(id, req.userId);
    const target = db.prepare('SELECT * FROM members WHERE guild_id = ? AND user_id = ?').get(id, uid) as any;
    if (!target) throw notFound('Member');
    const body = parse(
      z.object({
        nick: z.string().max(32).nullable().optional(),
        roles: z.array(z.string()).optional(),
        communication_disabled_until: z.number().nullable().optional(),
        mute: z.boolean().optional(),
        deaf: z.boolean().optional(),
        channel_id: z.string().nullable().optional(),
        reason: z.string().max(512).optional(),
      }),
      req.body,
    );
    const perms = store.guildPermissions(id, req.userId);
    const self = uid === req.userId;
    const changes: any[] = [];

    if (body.nick !== undefined) {
      const need = self ? P.CHANGE_NICKNAME : P.MANAGE_NICKNAMES;
      if (!hasPermission(perms, need)) throw forbidden();
      if (!self) store.requireAbove(id, req.userId, uid);
      db.prepare('UPDATE members SET nick = ? WHERE guild_id = ? AND user_id = ?').run(body.nick?.trim() || null, id, uid);
      changes.push({ key: 'nick', old: target.nick, new: body.nick });
    }
    if (body.roles !== undefined) {
      if (!hasPermission(perms, P.MANAGE_ROLES)) throw forbidden();
      const myTop = store.highestRole(id, req.userId);
      const current = new Set(store.memberRoleIds(id, uid));
      const next = new Set(body.roles.filter((r) => r !== id));
      const all = new Map(store.roles(id).map((r) => [r.id, r]));
      for (const r of new Set([...current, ...next])) {
        if (current.has(r) === next.has(r)) continue;
        const role = all.get(r);
        if (!role) throw badRequest(`Unknown role ${r}`);
        if (role.position >= myTop) throw forbidden(`You cannot assign the role ${role.name}`);
        if (role.managed) throw forbidden('Managed roles cannot be assigned');
      }
      db.transaction(() => {
        db.prepare('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?').run(id, uid);
        for (const r of next) db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?,?,?)').run(id, uid, r);
      })();
      const added = [...next].filter((r) => !current.has(r));
      const removed = [...current].filter((r) => !next.has(r));
      store.audit(id, req.userId, 'MEMBER_ROLE_UPDATE', uid, [
        ...(added.length ? [{ key: '$add', new: added.map((r) => ({ id: r, name: all.get(r)?.name })) }] : []),
        ...(removed.length ? [{ key: '$remove', new: removed.map((r) => ({ id: r, name: all.get(r)?.name })) }] : []),
      ], body.reason ?? null);
    }
    if (body.communication_disabled_until !== undefined) {
      if (!hasPermission(perms, P.MODERATE_MEMBERS)) throw forbidden();
      store.requireAbove(id, req.userId, uid);
      const until = body.communication_disabled_until;
      if (until && until > Date.now() + 28 * 86400_000) throw badRequest('Timeouts can be at most 28 days');
      db.prepare('UPDATE members SET timeout_until = ? WHERE guild_id = ? AND user_id = ?').run(until, id, uid);
      store.audit(id, req.userId, 'MEMBER_TIMEOUT', uid, [{ key: 'communication_disabled_until', old: target.timeout_until, new: until }], body.reason ?? null);
    }
    for (const k of ['mute', 'deaf'] as const) {
      if (body[k] === undefined) continue;
      if (!hasPermission(perms, k === 'mute' ? P.MUTE_MEMBERS : P.DEAFEN_MEMBERS)) throw forbidden();
      db.prepare(`UPDATE members SET ${k} = ? WHERE guild_id = ? AND user_id = ?`).run(+body[k]!, id, uid);
      changes.push({ key: k, old: !!target[k], new: body[k] });
    }
    if (body.channel_id !== undefined) {
      const vs = hub.voiceStates.get(uid);
      if (!self && !hasPermission(perms, P.MOVE_MEMBERS)) throw forbidden();
      if (vs?.guild_id === id) {
        if (body.channel_id === null) hub.leaveVoice(uid);
        else hub.updateVoiceState(uid, { channel_id: body.channel_id });
      }
    }
    if (changes.length) store.audit(id, req.userId, 'MEMBER_UPDATE', uid, changes, body.reason ?? null);
    if (body.mute !== undefined || body.deaf !== undefined) hub.refreshVoiceState(uid);
    const member = store.member(id, uid)!;
    hub.toGuild(id, 'GUILD_MEMBER_UPDATE', member);
    return member;
  });

  app.delete('/guilds/:id/members/:uid', async (req) => {
    const { id, uid } = params(req) as { id: string; uid: string };
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.KICK_MEMBERS);
    if (!store.isMember(id, uid)) throw notFound('Member');
    store.requireAbove(id, req.userId, uid);
    const { reason } = (req.query ?? {}) as { reason?: string };
    removeMember(id, uid);
    store.audit(id, req.userId, 'MEMBER_KICK', uid, [], reason ?? null);
    return { ok: true };
  });

  function removeMember(guildId: string, uid: string) {
    const user = store.user(uid);
    db.prepare('DELETE FROM members WHERE guild_id = ? AND user_id = ?').run(guildId, uid);
    if (hub.voiceStates.get(uid)?.guild_id === guildId) hub.leaveVoice(uid);
    hub.toUsers([uid], 'GUILD_DELETE', { id: guildId });
    hub.toGuild(guildId, 'GUILD_MEMBER_REMOVE', { guild_id: guildId, user });
  }

  /* ───────────── bans ───────────── */

  app.get('/guilds/:id/bans', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.BAN_MEMBERS);
    return (db.prepare('SELECT * FROM bans WHERE guild_id = ? ORDER BY created_at DESC').all(id) as any[]).map((b) => ({
      user: store.user(b.user_id),
      reason: b.reason,
      created_at: b.created_at,
    }));
  });

  app.put('/guilds/:id/bans/:uid', async (req) => {
    const { id, uid } = params(req) as { id: string; uid: string };
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.BAN_MEMBERS);
    if (!store.userRow(uid)) throw notFound('User');
    if (store.isMember(id, uid)) store.requireAbove(id, req.userId, uid);
    const body = parse(z.object({ reason: z.string().max(512).optional(), delete_message_seconds: z.number().int().min(0).max(604800).optional() }), req.body);
    db.prepare('INSERT OR REPLACE INTO bans (guild_id, user_id, reason, moderator_id, created_at) VALUES (?,?,?,?,?)').run(
      id, uid, body.reason ?? null, req.userId, Date.now(),
    );
    if (store.isMember(id, uid)) removeMember(id, uid);
    if (body.delete_message_seconds) {
      const since = Date.now() - body.delete_message_seconds * 1000;
      const msgs = db.prepare('SELECT id, channel_id FROM messages WHERE guild_id = ? AND author_id = ? AND created_at >= ?').all(id, uid, since) as any[];
      db.prepare('DELETE FROM messages WHERE guild_id = ? AND author_id = ? AND created_at >= ?').run(id, uid, since);
      const byChannel = new Map<string, string[]>();
      for (const m of msgs) byChannel.set(m.channel_id, [...(byChannel.get(m.channel_id) ?? []), m.id]);
      for (const [cid, ids] of byChannel) hub.toGuild(id, 'MESSAGE_DELETE_BULK', { ids, channel_id: cid, guild_id: id });
    }
    store.audit(id, req.userId, 'MEMBER_BAN_ADD', uid, [], body.reason ?? null);
    hub.toGuild(id, 'GUILD_BAN_ADD', { guild_id: id, user: store.user(uid) });
    return { ok: true };
  });

  app.delete('/guilds/:id/bans/:uid', async (req) => {
    const { id, uid } = params(req) as { id: string; uid: string };
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.BAN_MEMBERS);
    db.prepare('DELETE FROM bans WHERE guild_id = ? AND user_id = ?').run(id, uid);
    store.audit(id, req.userId, 'MEMBER_BAN_REMOVE', uid);
    hub.toGuild(id, 'GUILD_BAN_REMOVE', { guild_id: id, user: store.user(uid) });
    return { ok: true };
  });

  /* ───────────── roles ───────────── */

  const roleSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
    hoist: z.boolean().optional(),
    icon: z.string().nullable().optional(),
    permissions: z.string().regex(/^\d+$/).optional(),
    mentionable: z.boolean().optional(),
  });

  function checkRolePerms(guildId: string, userId: string, permissions?: string) {
    if (permissions === undefined) return;
    const mine = store.guildPermissions(guildId, userId);
    const want = BigInt(permissions) & ALL_PERMISSIONS;
    // You cannot grant permissions you don't have yourself.
    if (mine !== ALL_PERMISSIONS && (want & ~mine) !== 0n) throw forbidden('You cannot grant permissions you do not have');
  }

  app.post('/guilds/:id/roles', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_ROLES);
    const body = parse(roleSchema, req.body);
    checkRolePerms(id, req.userId, body.permissions);
    const rid = snowflake();
    db.transaction(() => {
      db.prepare('UPDATE roles SET position = position + 1 WHERE guild_id = ? AND position >= 1').run(id);
      db.prepare('INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable) VALUES (?,?,?,?,?,?,?,?)').run(
        rid, id, body.name ?? 'new role', body.color ?? null, +(body.hoist ?? false), 1, body.permissions ?? '0', +(body.mentionable ?? false),
      );
    })();
    const role = store.role(db.prepare('SELECT * FROM roles WHERE id = ?').get(rid));
    store.audit(id, req.userId, 'ROLE_CREATE', rid, [{ key: 'name', new: role.name }]);
    for (const r of store.roles(id)) hub.toGuild(id, r.id === rid ? 'GUILD_ROLE_CREATE' : 'GUILD_ROLE_UPDATE', { guild_id: id, role: r });
    return role;
  });

  app.patch('/guilds/:id/roles', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_ROLES);
    const body = parse(z.array(z.object({ id: z.string(), position: z.number().int().min(1) })), req.body);
    const myTop = store.highestRole(id, req.userId);
    const current = new Map(store.roles(id).map((r) => [r.id, r]));
    for (const b of body) {
      const r = current.get(b.id);
      if (!r || r.id === id) throw badRequest('Invalid role');
      if ((r.position >= myTop || b.position >= myTop) && r.position !== b.position) throw forbidden('You can only move roles below your highest role');
    }
    db.transaction(() => {
      for (const b of body) db.prepare('UPDATE roles SET position = ? WHERE id = ? AND guild_id = ?').run(b.position, b.id, id);
    })();
    const roles = store.roles(id);
    for (const r of roles) hub.toGuild(id, 'GUILD_ROLE_UPDATE', { guild_id: id, role: r });
    return roles;
  });

  app.patch('/guilds/:id/roles/:rid', async (req) => {
    const { id, rid } = params(req) as { id: string; rid: string };
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_ROLES);
    const row = db.prepare('SELECT * FROM roles WHERE id = ? AND guild_id = ?').get(rid, id) as any;
    if (!row) throw notFound('Role');
    if (rid !== id && row.position >= store.highestRole(id, req.userId)) throw forbidden('You can only edit roles below your highest role');
    const body = parse(roleSchema, req.body);
    checkRolePerms(id, req.userId, body.permissions);
    if (rid === id && body.name) delete body.name; // @everyone cannot be renamed
    const sets: Record<string, unknown> = {};
    const changes: any[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === 'icon') {
        files.remove(row.icon);
        sets.icon = v ? files.saveDataUrl('role-icons', v as string, 256 * 1024) : null;
      } else sets[k] = typeof v === 'boolean' ? +v : v;
      changes.push({ key: k, old: row[k], new: v });
    }
    if (Object.keys(sets).length) {
      db.prepare(`UPDATE roles SET ${Object.keys(sets).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @rid`).run({ ...sets, rid });
      store.audit(id, req.userId, 'ROLE_UPDATE', rid, changes);
    }
    const role = store.role(db.prepare('SELECT * FROM roles WHERE id = ?').get(rid));
    hub.toGuild(id, 'GUILD_ROLE_UPDATE', { guild_id: id, role });
    return role;
  });

  app.delete('/guilds/:id/roles/:rid', async (req) => {
    const { id, rid } = params(req) as { id: string; rid: string };
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_ROLES);
    if (rid === id) throw badRequest('Cannot delete @everyone');
    const row = db.prepare('SELECT * FROM roles WHERE id = ? AND guild_id = ?').get(rid, id) as any;
    if (!row) throw notFound('Role');
    if (row.position >= store.highestRole(id, req.userId)) throw forbidden();
    db.prepare('DELETE FROM roles WHERE id = ?').run(rid);
    store.audit(id, req.userId, 'ROLE_DELETE', rid, [{ key: 'name', old: row.name }]);
    hub.toGuild(id, 'GUILD_ROLE_DELETE', { guild_id: id, role_id: rid });
    return { ok: true };
  });

  /* ───────────── invites / audit log / webhooks ───────────── */

  app.get('/guilds/:id/invites', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_GUILD);
    const { serializeInvite } = await import('./invites');
    return (db.prepare('SELECT * FROM invites WHERE guild_id = ? ORDER BY created_at DESC').all(id) as any[]).map((i) => serializeInvite(ctx, i));
  });

  app.get('/guilds/:id/audit-logs', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.VIEW_AUDIT_LOG);
    const q = req.query as { user_id?: string; action?: string; before?: string; limit?: string };
    const where = ['guild_id = @id'];
    if (q.user_id) where.push('user_id = @user_id');
    if (q.action) where.push('action = @action');
    if (q.before) where.push('id < @before');
    const limit = Math.min(Number(q.limit) || 50, 100);
    const entries = (db.prepare(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`).all({ id, ...q }) as any[]).map(
      (e) => ({ ...e, changes: json(e.changes, []) }),
    );
    const userIds = new Set<string>();
    for (const e of entries) {
      userIds.add(e.user_id);
      if (e.target_id) userIds.add(e.target_id);
    }
    return {
      entries,
      users: [...userIds].filter((u) => store.userRow(u)).map((u) => store.user(u)),
    };
  });

  app.get('/guilds/:id/webhooks', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_WEBHOOKS);
    return (db.prepare('SELECT * FROM webhooks WHERE guild_id = ?').all(id) as any[]).map((w) => ({
      id: w.id, guild_id: w.guild_id, channel_id: w.channel_id, name: w.name, avatar: w.avatar ? `/uploads/${w.avatar}` : null,
      token: w.token, creator: w.creator_id ? store.user(w.creator_id) : null, created_at: w.created_at,
    }));
  });

  /* ───────────── automod ───────────── */

  const ruleSchema = z.object({
    name: z.string().min(1).max(100),
    enabled: z.boolean().default(true),
    trigger: z.enum(['keyword', 'spam', 'mention_spam', 'link']),
    keywords: z.array(z.string().max(60)).max(1000).default([]),
    allow_list: z.array(z.string().max(60)).max(100).default([]),
    mention_limit: z.number().int().min(1).max(50).default(5),
    actions: z
      .array(z.object({ type: z.enum(['block', 'alert', 'timeout']), channel_id: z.string().optional(), duration: z.number().int().optional(), message: z.string().max(150).optional() }))
      .min(1),
    exempt_roles: z.array(z.string()).default([]),
    exempt_channels: z.array(z.string()).default([]),
  });

  app.get('/guilds/:id/auto-moderation/rules', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_GUILD);
    return (db.prepare('SELECT * FROM automod_rules WHERE guild_id = ?').all(id) as any[]).map((r) => ({ id: r.id, guild_id: id, ...JSON.parse(r.data) }));
  });

  app.post('/guilds/:id/auto-moderation/rules', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_GUILD);
    const body = parse(ruleSchema, req.body);
    const rid = snowflake();
    db.prepare('INSERT INTO automod_rules (id, guild_id, data) VALUES (?,?,?)').run(rid, id, JSON.stringify(body));
    store.audit(id, req.userId, 'AUTOMOD_RULE_CREATE', rid, [{ key: 'name', new: body.name }]);
    return { id: rid, guild_id: id, ...body } satisfies AutoModRule;
  });

  app.patch('/guilds/:id/auto-moderation/rules/:rid', async (req) => {
    const { id, rid } = params(req) as { id: string; rid: string };
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_GUILD);
    const row = db.prepare('SELECT * FROM automod_rules WHERE id = ? AND guild_id = ?').get(rid, id) as any;
    if (!row) throw notFound('Rule');
    const next = parse(ruleSchema, { ...JSON.parse(row.data), ...(req.body as object) });
    db.prepare('UPDATE automod_rules SET data = ? WHERE id = ?').run(JSON.stringify(next), rid);
    store.audit(id, req.userId, 'AUTOMOD_RULE_UPDATE', rid, [{ key: 'name', new: next.name }]);
    return { id: rid, guild_id: id, ...next };
  });

  app.delete('/guilds/:id/auto-moderation/rules/:rid', async (req) => {
    const { id, rid } = params(req) as { id: string; rid: string };
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_GUILD);
    db.prepare('DELETE FROM automod_rules WHERE id = ? AND guild_id = ?').run(rid, id);
    store.audit(id, req.userId, 'AUTOMOD_RULE_DELETE', rid);
    return { ok: true };
  });

  /* ───────────── expressions: emoji, stickers, sounds ───────────── */

  const exprName = z.string().regex(/^[\w]{2,32}$/, 'Names must be 2-32 letters, numbers or underscores');

  app.post('/guilds/:id/emojis', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_EXPRESSIONS);
    const body = parse(z.object({ name: exprName, image: z.string() }), req.body);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM emojis WHERE guild_id = ?').get(id) as any).c;
    if (count >= 250) throw badRequest('Maximum number of emojis reached (250)');
    const file = files.saveDataUrl('emojis', body.image, maxEmoji);
    const eid = snowflake();
    db.prepare('INSERT INTO emojis (id, guild_id, name, animated, file, creator_id) VALUES (?,?,?,?,?,?)').run(
      eid, id, body.name, +body.image.startsWith('data:image/gif'), file, req.userId,
    );
    store.audit(id, req.userId, 'EMOJI_CREATE', eid, [{ key: 'name', new: body.name }]);
    hub.toGuild(id, 'GUILD_EMOJIS_UPDATE', { guild_id: id, emojis: store.emojis(id) });
    return store.emojis(id).find((e) => e.id === eid);
  });

  app.patch('/guilds/:id/emojis/:eid', async (req) => {
    const { id, eid } = params(req) as { id: string; eid: string };
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_EXPRESSIONS);
    const { name } = parse(z.object({ name: exprName }), req.body);
    db.prepare('UPDATE emojis SET name = ? WHERE id = ? AND guild_id = ?').run(name, eid, id);
    hub.toGuild(id, 'GUILD_EMOJIS_UPDATE', { guild_id: id, emojis: store.emojis(id) });
    return { ok: true };
  });

  app.delete('/guilds/:id/emojis/:eid', async (req) => {
    const { id, eid } = params(req) as { id: string; eid: string };
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_EXPRESSIONS);
    const row = db.prepare('SELECT * FROM emojis WHERE id = ? AND guild_id = ?').get(eid, id) as any;
    if (!row) throw notFound('Emoji');
    db.prepare('DELETE FROM emojis WHERE id = ?').run(eid);
    files.remove(row.file);
    store.audit(id, req.userId, 'EMOJI_DELETE', eid, [{ key: 'name', old: row.name }]);
    hub.toGuild(id, 'GUILD_EMOJIS_UPDATE', { guild_id: id, emojis: store.emojis(id) });
    return { ok: true };
  });

  app.post('/guilds/:id/stickers', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_EXPRESSIONS);
    const body = parse(z.object({ name: z.string().min(2).max(30), description: z.string().max(100).default(''), tags: z.string().max(200).default(''), image: z.string() }), req.body);
    const file = files.saveDataUrl('stickers', body.image, 512 * 1024);
    const format = file.endsWith('.gif') ? 'gif' : file.endsWith('.webp') ? 'webp' : 'png';
    const sid = snowflake();
    db.prepare('INSERT INTO stickers (id, guild_id, name, description, tags, file, format) VALUES (?,?,?,?,?,?,?)').run(sid, id, body.name, body.description, body.tags, file, format);
    store.audit(id, req.userId, 'STICKER_CREATE', sid, [{ key: 'name', new: body.name }]);
    hub.toGuild(id, 'GUILD_STICKERS_UPDATE', { guild_id: id, stickers: store.stickers(id) });
    return { ok: true };
  });

  app.delete('/guilds/:id/stickers/:eid', async (req) => {
    const { id, eid } = params(req) as { id: string; eid: string };
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_EXPRESSIONS);
    const row = db.prepare('SELECT * FROM stickers WHERE id = ? AND guild_id = ?').get(eid, id) as any;
    if (!row) throw notFound('Sticker');
    db.prepare('DELETE FROM stickers WHERE id = ?').run(eid);
    files.remove(row.file);
    store.audit(id, req.userId, 'STICKER_DELETE', eid, [{ key: 'name', old: row.name }]);
    hub.toGuild(id, 'GUILD_STICKERS_UPDATE', { guild_id: id, stickers: store.stickers(id) });
    return { ok: true };
  });

  app.post('/guilds/:id/soundboard-sounds', async (req) => {
    const { id } = params(req);
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_EXPRESSIONS);
    const body = parse(z.object({ name: z.string().min(2).max(32), emoji: z.string().max(64).nullable().default(null), volume: z.number().min(0).max(1).default(1), sound: z.string() }), req.body);
    const file = files.saveDataUrl('sounds', body.sound, 512 * 1024, /^audio\//);
    const sid = snowflake();
    db.prepare('INSERT INTO sounds (id, guild_id, name, emoji, volume, file) VALUES (?,?,?,?,?,?)').run(sid, id, body.name, body.emoji, body.volume, file);
    store.audit(id, req.userId, 'SOUND_CREATE', sid, [{ key: 'name', new: body.name }]);
    hub.toGuild(id, 'GUILD_SOUNDBOARD_UPDATE', { guild_id: id, sounds: store.sounds(id) });
    return { ok: true };
  });

  app.delete('/guilds/:id/soundboard-sounds/:eid', async (req) => {
    const { id, eid } = params(req) as { id: string; eid: string };
    guildOr404(id, req.userId);
    store.requireGuildPerm(id, req.userId, P.MANAGE_EXPRESSIONS);
    const row = db.prepare('SELECT * FROM sounds WHERE id = ? AND guild_id = ?').get(eid, id) as any;
    if (!row) throw notFound('Sound');
    db.prepare('DELETE FROM sounds WHERE id = ?').run(eid);
    files.remove(row.file);
    store.audit(id, req.userId, 'SOUND_DELETE', eid, [{ key: 'name', old: row.name }]);
    hub.toGuild(id, 'GUILD_SOUNDBOARD_UPDATE', { guild_id: id, sounds: store.sounds(id) });
    return { ok: true };
  });

  app.post('/guilds/:id/soundboard-sounds/:eid/play', async (req) => {
    const { id, eid } = params(req) as { id: string; eid: string };
    guildOr404(id, req.userId);
    const vs = hub.voiceStates.get(req.userId);
    if (!vs?.channel_id || vs.guild_id !== id) throw badRequest('You must be in a voice channel');
    store.requireChannelPerm(vs.channel_id, req.userId, P.USE_SOUNDBOARD);
    const listeners = [...hub.voiceStates.values()].filter((v) => v.channel_id === vs.channel_id).map((v) => v.user_id);
    hub.toUsers(listeners, 'SOUNDBOARD_PLAY', { guild_id: id, channel_id: vs.channel_id, user_id: req.userId, sound_id: eid });
    return { ok: true };
  });
};
