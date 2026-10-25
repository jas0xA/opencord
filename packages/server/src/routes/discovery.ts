import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ChannelType, Permissions as P } from '@opencord/shared';
import { authenticate, parse, type Ctx } from '../app';
import { fileUrl } from '../store';
import { ApiError, inviteCode, notFound } from '../util';
import { joinGuild } from './invites';

/**
 * Server browser. "Discoverable" servers are listed for everyone on this host and can be joined
 * without an invite; "global" servers are also published to the global network so people on other
 * hosts can find them and join by signing in here with their home account.
 */
export function publishGuild(ctx: Ctx, guildId: string) {
  const fed = ctx.federation;
  if (!fed) return;
  const g = ctx.store.guildRow(guildId);
  if (!g) return fed.publish('guild', guildId, {}, true);
  if (!g.global) return fed.publish('guild', guildId, { name: g.name }, true);
  const abs = (p: string | null) => {
    const u = fileUrl(p);
    return u ? (/^https?:/.test(u) ? u : `${fed.origin}${u}`) : null;
  };
  fed.publish('guild', guildId, {
    id: g.id,
    name: g.name,
    description: g.description,
    icon: abs(g.icon),
    banner: abs(g.banner),
    banner_preset: g.banner_preset,
    member_count: ctx.store.guildMemberIds(guildId).length,
    invite: g.discovery_invite,
    host_name: ctx.config.instance.name,
  });
}

export default (ctx: Ctx) => async (app: FastifyInstance) => {
  const { db, store } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  function serialize(g: any, viewer: string) {
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      icon: fileUrl(g.icon),
      banner: fileUrl(g.banner),
      banner_preset: g.banner_preset,
      member_count: store.guildMemberIds(g.id).length,
      online_count: store.guildMemberIds(g.id).filter((u) => ctx.hub.isOnline(u)).length,
      discoverable: !!g.discoverable,
      global: !!g.global,
      joined: store.isMember(g.id, viewer),
    };
  }

  app.get('/discovery/guilds', async (req) => {
    const q = parse(z.object({ q: z.string().max(100).optional(), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    const args: unknown[] = [];
    let where = '(discoverable = 1 OR global = 1)';
    if (q.q) {
      where += " AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')";
      const like = `%${q.q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      args.push(like, like);
    }
    const rows = db.prepare(`SELECT * FROM guilds WHERE ${where} ORDER BY created_at DESC LIMIT 60 OFFSET ?`).all(...args, q.offset) as any[];
    return rows.map((g) => serialize(g, req.userId)).sort((a, b) => b.member_count - a.member_count);
  });

  app.post('/discovery/guilds/:id/join', async (req) => {
    const g = store.guildRow((req.params as { id: string }).id);
    if (!g || !(g.discoverable || g.global)) throw notFound('Guild');
    joinGuild(ctx, g.id, req.userId, g.discovery_invite ?? undefined);
    publishGuild(ctx, g.id);
    return { ok: true, guild_id: g.id };
  });

  app.put('/guilds/:id/discovery', async (req) => {
    const { id } = req.params as { id: string };
    const g = store.guildRow(id);
    if (!g || !store.isMember(id, req.userId)) throw notFound('Guild');
    store.requireGuildPerm(id, req.userId, P.MANAGE_GUILD);
    const body = parse(z.object({ discoverable: z.boolean().optional(), global: z.boolean().optional() }), req.body);
    if (body.global && !ctx.federation) throw new ApiError(400, 'This server is not part of the global OpenCord network. Ask the host to enable [federation] in config.toml.', 0);
    const discoverable = body.discoverable ?? !!g.discoverable;
    const global = body.global ?? !!g.global;
    let invite = g.discovery_invite as string | null;
    // Listed servers get a permanent invite so people from the browser (or other hosts) can join.
    if ((discoverable || global) && (!invite || !db.prepare('SELECT 1 FROM invites WHERE code = ?').get(invite))) {
      const channel = db.prepare('SELECT id FROM channels WHERE guild_id = ? AND type = ? ORDER BY position LIMIT 1').get(id, ChannelType.GUILD_TEXT) as { id: string } | undefined;
      if (!channel) throw new ApiError(400, 'Create a text channel first.', 0);
      invite = inviteCode();
      db.prepare('INSERT INTO invites (code, guild_id, channel_id, inviter_id, max_uses, max_age, temporary, created_at) VALUES (?,?,?,?,0,0,0,?)').run(invite, id, channel.id, req.userId, Date.now());
    }
    db.prepare('UPDATE guilds SET discoverable = ?, global = ?, discovery_invite = ? WHERE id = ?').run(+discoverable, +global, invite, id);
    store.audit(id, req.userId, 'GUILD_UPDATE', id, [{ key: 'discovery', new: { discoverable, global } }]);
    publishGuild(ctx, id);
    return { discoverable, global, invite };
  });

  app.get('/guilds/:id/discovery', async (req) => {
    const { id } = req.params as { id: string };
    const g = store.guildRow(id);
    if (!g || !store.isMember(id, req.userId)) throw notFound('Guild');
    return { discoverable: !!g.discoverable, global: !!g.global, invite: g.discovery_invite, network: !!ctx.federation };
  });
};
