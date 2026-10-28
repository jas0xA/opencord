import type { FastifyInstance } from 'fastify';
import { MessageType, Permissions, type Invite } from '@opencord/shared';
import { authenticate, type Ctx } from '../app';
import { ApiError, forbidden, notFound, snowflake } from '../util';

export function resolveInvite(ctx: Ctx, code: string): any | null {
  const inv = ctx.db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as any;
  if (inv) {
    const expired = inv.max_age > 0 && inv.created_at + inv.max_age * 1000 < Date.now();
    const usedUp = inv.max_uses > 0 && inv.uses >= inv.max_uses;
    if (expired || usedUp) {
      ctx.db.prepare('DELETE FROM invites WHERE code = ?').run(code);
      return null;
    }
    const g = ctx.store.guildRow(inv.guild_id);
    if (json(g?.features).includes('INVITES_DISABLED')) return null;
    return inv;
  }
  // Vanity URLs act as a never-expiring invite to the first text channel.
  const g = ctx.db.prepare('SELECT * FROM guilds WHERE vanity_code = ?').get(code) as any;
  if (!g || json(g.features).includes('INVITES_DISABLED')) return null;
  const ch = ctx.db.prepare('SELECT id FROM channels WHERE guild_id = ? AND type = 0 ORDER BY position LIMIT 1').get(g.id) as any;
  return { code, guild_id: g.id, channel_id: ch?.id ?? g.id, inviter_id: null, uses: 0, max_uses: 0, max_age: 0, temporary: 0, created_at: g.created_at, vanity: true };
}

function json(s: string | undefined): string[] {
  try {
    return JSON.parse(s ?? '[]');
  } catch {
    return [];
  }
}

export function serializeInvite(ctx: Ctx, inv: any): Invite {
  const g = ctx.store.guild(ctx.store.guildRow(inv.guild_id));
  const ch = ctx.store.channelRow(inv.channel_id);
  const online = ctx.store.guildMemberIds(inv.guild_id).filter((id) => ctx.hub.publicStatus(id) !== 'offline').length;
  return {
    code: inv.code,
    guild: {
      id: g.id, name: g.name, icon: g.icon, banner: g.banner, banner_preset: g.banner_preset, description: g.description,
      created_at: g.created_at, member_count: g.member_count, online_count: online,
    },
    channel: { id: inv.channel_id, name: ch?.name ?? null, type: ch?.type ?? 0 },
    inviter: inv.inviter_id ? ctx.store.user(inv.inviter_id) : null,
    uses: inv.uses,
    max_uses: inv.max_uses,
    max_age: inv.max_age,
    temporary: !!inv.temporary,
    created_at: inv.created_at,
    expires_at: inv.max_age > 0 ? inv.created_at + inv.max_age * 1000 : null,
  };
}

/** Adds a user to a guild (idempotent) and broadcasts the result. Throws if banned / full. */
export function joinGuild(ctx: Ctx, guildId: string, userId: string, inviteCode?: string) {
  const { db, store, hub, config } = ctx;
  if (store.isMember(guildId, userId)) return;
  if (db.prepare('SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?').get(guildId, userId)) {
    throw new ApiError(403, 'You are banned from this server.', 40007);
  }
  const count = (db.prepare('SELECT COUNT(*) AS c FROM members WHERE user_id = ?').get(userId) as any).c;
  if (count >= config.limits.max_guilds_per_user) throw new ApiError(400, `You can only be in ${config.limits.max_guilds_per_user} servers.`, 30001);
  if (config.limits.max_members_per_guild > 0 && store.guildMemberIds(guildId).length >= config.limits.max_members_per_guild) {
    throw new ApiError(400, 'This server is full.', 30019);
  }
  const now = Date.now();
  db.transaction(() => {
    db.prepare('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?,?,?)').run(guildId, userId, now);
    if (inviteCode) db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(inviteCode);
  })();
  const member = store.member(guildId, userId)!;
  hub.toGuild(guildId, 'GUILD_MEMBER_ADD', member);
  const full = store.guildFull(guildId);
  full.voice_states = [...hub.voiceStates.values()].filter((v) => v.guild_id === guildId);
  hub.toUsers([userId], 'GUILD_CREATE', full);
  for (const m of full.members) {
    const p = hub.presence(m.user.id);
    if (p.status !== 'offline') hub.toUsers([userId], 'PRESENCE_UPDATE', p);
  }
  hub.broadcastPresence(userId);

  // Welcome message in the system channel.
  const g = store.guildRow(guildId);
  if (g.system_channel_id && store.channelRow(g.system_channel_id)) {
    const id = snowflake();
    db.prepare('INSERT INTO messages (id, channel_id, guild_id, author_id, type, created_at) VALUES (?,?,?,?,?,?)').run(
      id, g.system_channel_id, guildId, userId, MessageType.GUILD_MEMBER_JOIN, now,
    );
    db.prepare('UPDATE channels SET last_message_id = ? WHERE id = ?').run(id, g.system_channel_id);
    hub.toChannel(g.system_channel_id, 'MESSAGE_CREATE', (uid) => store.message(store.messageRow(id), uid));
  }
}

export default (ctx: Ctx) => async (app: FastifyInstance) => {
  const auth = authenticate(ctx);

  app.get('/invites/:code', { preHandler: auth }, async (req) => {
    const inv = resolveInvite(ctx, (req.params as any).code);
    if (!inv) throw notFound('Invite');
    return serializeInvite(ctx, inv);
  });

  app.post('/invites/:code', { preHandler: auth }, async (req) => {
    const inv = resolveInvite(ctx, (req.params as any).code);
    if (!inv) throw notFound('Invite');
    joinGuild(ctx, inv.guild_id, req.userId, inv.vanity ? undefined : inv.code);
    return { guild_id: inv.guild_id, channel_id: inv.channel_id };
  });

  app.delete('/invites/:code', { preHandler: auth }, async (req) => {
    const inv = ctx.db.prepare('SELECT * FROM invites WHERE code = ?').get((req.params as any).code) as any;
    if (!inv) throw notFound('Invite');
    if (inv.inviter_id !== req.userId) {
      const perms = ctx.store.guildPermissions(inv.guild_id, req.userId);
      if ((perms & (Permissions.MANAGE_GUILD | Permissions.ADMINISTRATOR)) === 0n) throw forbidden();
    }
    ctx.db.prepare('DELETE FROM invites WHERE code = ?').run(inv.code);
    ctx.store.audit(inv.guild_id, req.userId, 'INVITE_DELETE', null, [{ key: 'code', old: inv.code }]);
    return { ok: true };
  });
};
