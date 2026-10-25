import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, parse, type Ctx } from '../app';
import { setTomlValue } from '../config-edit';
import { badRequest, forbidden, notFound } from '../util';

/** Instance-level administration (not guild moderation). */
export default (ctx: Ctx) => async (app: FastifyInstance) => {
  const { db, store, hub, config } = ctx;
  app.addHook('preHandler', authenticate(ctx));
  app.addHook('preHandler', async (req) => {
    if (req.url.includes('/admin/marketplace')) return; // handled in marketplace routes
    if (req.url.includes('/admin/') && !store.userRow(req.userId)?.admin) throw forbidden('Instance admins only');
  });

  app.get('/admin/stats', async () => {
    const count = (sql: string) => (db.prepare(sql).get() as any).c as number;
    return {
      users: count('SELECT COUNT(*) AS c FROM users'),
      guilds: count('SELECT COUNT(*) AS c FROM guilds'),
      messages: count('SELECT COUNT(*) AS c FROM messages'),
      marketplace_items: count('SELECT COUNT(*) AS c FROM marketplace_items WHERE official = 0'),
      online: (db.prepare('SELECT id FROM users').all() as any[]).filter((u) => hub.isOnline(u.id)).length,
      registration: config.registration.mode,
      community_marketplace: config.marketplace.community_enabled,
      require_approval: config.marketplace.require_approval,
    };
  });

  app.patch('/admin/settings', async (req) => {
    const body = parse(
      z.object({
        registration: z.enum(['open', 'invite_only', 'allowlist', 'closed']).optional(),
        community_marketplace: z.boolean().optional(),
        require_approval: z.boolean().optional(),
      }),
      req.body,
    );
    // Persist to config.toml so the change survives restarts.
    if (body.registration) {
      setTomlValue(config.configPath, 'registration', 'mode', body.registration);
      config.registration.mode = body.registration;
    }
    if (body.community_marketplace !== undefined) {
      setTomlValue(config.configPath, 'marketplace', 'community_enabled', body.community_marketplace);
      config.marketplace.community_enabled = body.community_marketplace;
    }
    if (body.require_approval !== undefined) {
      setTomlValue(config.configPath, 'marketplace', 'require_approval', body.require_approval);
      config.marketplace.require_approval = body.require_approval;
    }
    return { ok: true };
  });

  /* ── updates ── */

  app.get('/admin/updates', async (req) => {
    const { refresh } = req.query as { refresh?: string };
    return refresh ? await ctx.updates.check().catch(() => ctx.updates.status) : ctx.updates.status;
  });

  /* ── global network ── */

  app.get('/admin/federation', async () => {
    const f = ctx.federation;
    return {
      configured: config.federation.enabled,
      running: !!f,
      public_url: config.server.public_url,
      help_host: f?.helpsHost ?? config.federation.help_host,
      seeds: config.federation.seeds,
      origin: f?.origin ?? null,
      pubkey: f?.key.publicKey ?? null,
      peers: f?.peerList() ?? [],
      counts: f
        ? Object.fromEntries((db.prepare('SELECT kind, COUNT(*) AS c FROM federation_records WHERE deleted = 0 GROUP BY kind').all() as any[]).map((r) => [r.kind, r.c]))
        : {},
      outbox: f ? (db.prepare('SELECT COUNT(*) AS c FROM federation_outbox').get() as any).c : 0,
    };
  });

  app.patch('/admin/federation', async (req) => {
    const body = parse(
      z.object({
        enabled: z.boolean().optional(),
        help_host: z.boolean().optional(),
        seeds: z.array(z.string().max(300)).max(50).optional(),
        public_url: z.string().max(300).optional(),
        sync_now: z.boolean().optional(),
        reset_pin: z.string().max(300).optional(),
      }),
      req.body,
    );
    let restart = false;
    if (body.enabled !== undefined) {
      setTomlValue(config.configPath, 'federation', 'enabled', body.enabled);
      restart ||= body.enabled !== !!ctx.federation;
      config.federation.enabled = body.enabled;
    }
    if (body.public_url !== undefined) {
      setTomlValue(config.configPath, 'server', 'public_url', body.public_url.trim());
      restart ||= body.public_url.trim() !== config.server.public_url;
    }
    if (body.help_host !== undefined) {
      setTomlValue(config.configPath, 'federation', 'help_host', body.help_host);
      config.federation.help_host = body.help_host;
      ctx.federation?.setHelpHost(body.help_host);
    }
    if (body.seeds) {
      const seeds = body.seeds.map((s) => s.trim()).filter(Boolean);
      setTomlValue(config.configPath, 'federation', 'seeds', seeds);
      config.federation.seeds = seeds;
      for (const s of seeds) {
        try {
          ctx.federation?.addPeer(s);
        } catch {
          throw badRequest(`Invalid address: ${s}`);
        }
      }
    }
    if (body.reset_pin) ctx.federation?.resetPin(body.reset_pin);
    if (body.sync_now && ctx.federation) await ctx.federation.syncOnce();
    return { ok: true, restart_required: restart };
  });

  app.get('/admin/users', async (req) => {
    const { q } = req.query as { q?: string };
    const rows = q
      ? (db.prepare('SELECT * FROM users WHERE username LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT 100').all(`%${q}%`, `%${q}%`) as any[])
      : (db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 100').all() as any[]);
    return rows.map((r) => ({ ...store.publicUser(r), email: r.email, admin: !!r.admin, disabled: !!r.disabled, online: hub.isOnline(r.id) }));
  });

  app.patch('/admin/users/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!store.userRow(id)) throw notFound('User');
    const body = parse(z.object({ disabled: z.boolean().optional(), admin: z.boolean().optional() }), req.body);
    if (id === req.userId && (body.disabled || body.admin === false)) throw badRequest('You cannot demote or disable yourself');
    if (body.disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(+body.disabled, id);
      if (body.disabled) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        hub.kickUser(id);
      }
    }
    if (body.admin !== undefined) db.prepare('UPDATE users SET admin = ? WHERE id = ?').run(+body.admin, id);
    hub.broadcastUserUpdate(id);
    return { ok: true };
  });

  app.get('/admin/allowlist', async () => db.prepare('SELECT * FROM allowlist ORDER BY added_at DESC').all());

  app.post('/admin/allowlist', async (req) => {
    const { email, note } = parse(z.object({ email: z.string().email(), note: z.string().max(200).default('') }), req.body);
    db.prepare('INSERT INTO allowlist (email, note, added_at) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET used_at = NULL, note = excluded.note').run(
      email.toLowerCase(), note, Date.now(),
    );
    return db.prepare('SELECT * FROM allowlist ORDER BY added_at DESC').all();
  });

  app.delete('/admin/allowlist/:email', async (req) => {
    db.prepare('DELETE FROM allowlist WHERE email = ?').run(decodeURIComponent((req.params as any).email).toLowerCase());
    return db.prepare('SELECT * FROM allowlist ORDER BY added_at DESC').all();
  });
};
