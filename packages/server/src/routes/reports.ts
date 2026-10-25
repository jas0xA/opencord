import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Permissions as P } from '@opencord/shared';
import { authenticate, parse, type Ctx } from '../app';
import { forbidden, json, notFound } from '../util';

/**
 * Message report queue. Guild moderators (Manage Messages) see reports from their guild; instance
 * admins see every report, including ones from DMs.
 */
export default (ctx: Ctx) => async (app: FastifyInstance) => {
  const { db, store, hub } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const isAdmin = (userId: string) => !!store.userRow(userId)?.admin;

  function serialize(r: any) {
    const reporter = store.userRow(r.reporter_id) ? store.user(r.reporter_id) : null;
    const live = store.messageRow(r.message_id);
    return {
      id: r.id,
      message_id: r.message_id,
      channel_id: r.channel_id,
      guild_id: r.guild_id,
      reason: r.reason,
      details: r.details,
      status: r.status,
      created_at: r.created_at,
      resolved_at: r.resolved_at,
      reporter,
      message: json(r.snapshot, {}),
      message_deleted: !live,
      // Other people who reported the same message.
      report_count: (db.prepare('SELECT COUNT(*) AS c FROM message_reports WHERE message_id = ?').get(r.message_id) as any).c,
    };
  }

  function canModerate(r: any, userId: string) {
    if (isAdmin(userId)) return true;
    if (!r.guild_id || !store.isMember(r.guild_id, userId)) return false;
    try {
      store.requireGuildPerm(r.guild_id, userId, P.MANAGE_MESSAGES);
      return true;
    } catch {
      return false;
    }
  }

  app.get('/guilds/:id/reports', async (req) => {
    const { id } = req.params as { id: string };
    const { status = 'open' } = req.query as { status?: string };
    if (!store.isMember(id, req.userId)) throw notFound('Guild');
    store.requireGuildPerm(id, req.userId, P.MANAGE_MESSAGES);
    const rows = db.prepare('SELECT * FROM message_reports WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200').all(id, status);
    return rows.map(serialize);
  });

  app.get('/admin/reports', async (req) => {
    if (!isAdmin(req.userId)) throw forbidden('Instance admins only');
    const { status = 'open' } = req.query as { status?: string };
    const rows = db.prepare('SELECT * FROM message_reports WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status);
    return rows.map(serialize);
  });

  app.post('/reports/:id/resolve', async (req) => {
    const { id } = req.params as { id: string };
    const { action } = parse(z.object({ action: z.enum(['dismiss', 'delete_message', 'resolve']) }), req.body);
    const r = db.prepare('SELECT * FROM message_reports WHERE id = ?').get(id) as any;
    if (!r || !canModerate(r, req.userId)) throw notFound('Report');
    if (action === 'delete_message') {
      const msg = store.messageRow(r.message_id);
      if (msg) {
        for (const a of json<{ url: string }[]>(msg.attachments, [])) ctx.files.remove(a.url.replace(/^\/uploads\//, ''));
        db.prepare('DELETE FROM messages WHERE id = ?').run(r.message_id);
        if (r.guild_id) store.audit(r.guild_id, req.userId, 'MESSAGE_DELETE', msg.author_id, [{ key: 'channel_id', new: r.channel_id }]);
        hub.toChannel(r.channel_id, 'MESSAGE_DELETE', { id: r.message_id, channel_id: r.channel_id, guild_id: r.guild_id });
      }
    }
    // Resolving one report resolves every open report about the same message.
    db.prepare('UPDATE message_reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE message_id = ? AND status = ?').run(
      action === 'dismiss' ? 'dismissed' : 'resolved', req.userId, Date.now(), r.message_id, 'open',
    );
    return { ok: true };
  });
};
