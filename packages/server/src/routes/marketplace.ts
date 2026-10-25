import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, parse, type Ctx } from '../app';
import { createHash } from 'node:crypto';
import { ApiError, badRequest, forbidden, notFound, snowflake } from '../util';
import { fileUrl } from '../store';

const CATEGORIES = ['avatar_decoration', 'profile_effect', 'nameplate', 'banner', 'profile_theme'] as const;
const color = z.string().regex(/^#[0-9a-f]{6}$/i);

export default (ctx: Ctx) => async (app: FastifyInstance) => {
  const { db, store, hub, files, config } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const isAdmin = (uid: string) => !!store.userRow(uid)?.admin;
  const itemRow = (id: string) => db.prepare('SELECT * FROM marketplace_items WHERE id = ?').get(id) as any;

  /** Private items are only visible to their author (and admins). */
  const visibleTo = (row: any, uid: string) => row.visibility !== 'private' || row.author_id === uid || isAdmin(uid);

  function publishItem(id: string) {
    const fed = ctx.federation;
    const row = itemRow(id);
    if (!fed) return;
    if (!row || !row.global || row.visibility === 'private' || row.status !== 'approved') return fed.publish('item', id, {}, true);
    const abs = (p: string | null) => (p && !p.startsWith('builtin:') ? (/^https?:/.test(p) ? p : `${fed.origin}${fileUrl(p)}`) : p);
    const author = row.author_id ? store.userRow(row.author_id) : null;
    fed.publish('item', id, {
      id, category: row.category, name: row.name, description: row.description, asset: abs(row.asset), preview: abs(row.preview),
      colors: row.colors ? JSON.parse(row.colors) : null, tags: JSON.parse(row.tags ?? '[]'),
      author: author ? `${author.username}@${new URL(fed.origin).host}` : null, allow_copy: !!row.allow_copy,
    });
  }

  /** Approved items go to everyone; pending ones only to their author and admins. */
  function broadcastItem(id: string, event: 'MARKETPLACE_ITEM_CREATE' | 'MARKETPLACE_ITEM_UPDATE') {
    const row = itemRow(id);
    if (!row) return;
    const online = (db.prepare('SELECT id, admin FROM users').all() as any[]).filter((u) => hub.isOnline(u.id));
    for (const u of online) {
      if (!visibleTo(row, u.id)) continue;
      if (row.status === 'approved' || u.admin || u.id === row.author_id) hub.toUsers([u.id], event, store.marketplaceItem(row, u.id));
    }
  }

  app.get('/marketplace/items', async (req) => {
    const q = parse(
      z.object({
        tab: z.enum(['official', 'community', 'owned', 'mine']).default('official'),
        category: z.enum(CATEGORIES).optional(),
        q: z.string().max(100).optional(),
        sort: z.enum(['popular', 'new']).default('popular'),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const where: string[] = [];
    const args: Record<string, unknown> = { uid: req.userId };
    if (q.tab === 'official') where.push('official = 1');
    if (q.tab === 'community') {
      if (!config.marketplace.community_enabled) return { total: 0, items: [] };
      where.push("official = 0 AND status = 'approved' AND visibility = 'public'");
    }
    if (q.tab === 'owned') where.push('id IN (SELECT item_id FROM marketplace_owned WHERE user_id = @uid)');
    if (q.tab === 'mine') where.push('author_id = @uid');
    if (q.category) {
      where.push('category = @category');
      args.category = q.category;
    }
    if (q.q) {
      where.push("(name LIKE @q ESCAPE '\\' OR description LIKE @q ESCAPE '\\' OR tags LIKE @q ESCAPE '\\')");
      args.q = `%${q.q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order =
      q.sort === 'new'
        ? 'created_at DESC'
        : '(SELECT COUNT(*) FROM marketplace_likes l WHERE l.item_id = marketplace_items.id) + (SELECT COUNT(*) FROM marketplace_owned o WHERE o.item_id = marketplace_items.id) DESC, created_at DESC';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM marketplace_items ${w}`).get(args) as any).c;
    const rows = db.prepare(`SELECT * FROM marketplace_items ${w} ORDER BY ${order} LIMIT 60 OFFSET @offset`).all({ ...args, offset: q.offset }) as any[];
    return { total, items: rows.map((r) => store.marketplaceItem(r, req.userId)) };
  });

  app.get('/marketplace/items/:id', async (req) => {
    const row = itemRow((req.params as any).id);
    if (!row || !visibleTo(row, req.userId) || (row.status !== 'approved' && row.author_id !== req.userId && !isAdmin(req.userId))) throw notFound('Item');
    return store.marketplaceItem(row, req.userId);
  });

  app.post('/marketplace/items', async (req) => {
    if (!config.marketplace.community_enabled) throw new ApiError(403, 'Community items are disabled on this server.', 0);
    const body = parse(
      z.object({
        category: z.enum(CATEGORIES),
        name: z.string().min(2).max(40),
        description: z.string().max(200).default(''),
        asset: z.string().optional(), // data: URL
        colors: z.array(color).min(1).max(3).optional(),
        tags: z.array(z.string().max(20)).max(5).default([]),
        visibility: z.enum(['private', 'public']).default('public'),
        allow_copy: z.boolean().default(true),
        global: z.boolean().default(false),
      }),
      req.body,
    );
    const mine = (db.prepare("SELECT COUNT(*) AS c FROM marketplace_items WHERE author_id = ? AND created_at > ?").get(req.userId, Date.now() - 86400_000) as any).c;
    if (mine >= 20) throw new ApiError(429, 'You can publish at most 20 items per day.', 0);

    let asset: string;
    let assetHash: string | null = null;
    if (body.asset) {
      assetHash = createHash('sha256').update(body.asset.replace(/^data:[^,]*,/, '')).digest('hex');
      const taken = db.prepare('SELECT 1 FROM marketplace_items WHERE asset_hash = ? AND allow_copy = 0 AND author_id IS NOT ? LIMIT 1').get(assetHash, req.userId);
      if (taken) throw badRequest("This design belongs to someone else and its creator doesn't allow copies.", { asset: 'Not allowed to copy this design' });
      asset = files.saveDataUrl('marketplace', body.asset, config.marketplace.max_item_mb * 1024 * 1024, /^image\/(png|apng|gif|webp|jpeg)$/);
    } else if ((body.category === 'profile_theme' || body.category === 'nameplate' || body.category === 'banner') && body.colors) {
      asset = body.category === 'profile_theme' ? 'builtin:theme' : `builtin:gradient`;
    } else {
      throw badRequest('An image is required for this category', { asset: 'Upload an image' });
    }
    const id = snowflake();
    const status = config.marketplace.require_approval && !isAdmin(req.userId) ? 'pending' : 'approved';
    db.prepare(
      'INSERT INTO marketplace_items (id, category, name, description, asset, colors, official, author_id, status, tags, created_at, visibility, allow_copy, global, asset_hash) VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)',
    ).run(id, body.category, body.name.trim(), body.description.trim(), asset, body.colors ? JSON.stringify(body.colors) : null, req.userId, status,
      JSON.stringify(body.tags.map((t) => t.toLowerCase().trim()).filter(Boolean)), Date.now(), body.visibility, +body.allow_copy, +(body.global && body.visibility === 'public'), assetHash);
    // Authors automatically own what they make.
    db.prepare('INSERT OR IGNORE INTO marketplace_owned (item_id, user_id, claimed_at) VALUES (?,?,?)').run(id, req.userId, Date.now());
    broadcastItem(id, 'MARKETPLACE_ITEM_CREATE');
    hub.broadcastUserUpdate(req.userId);
    publishItem(id);
    return store.marketplaceItem(itemRow(id), req.userId);
  });

  app.patch('/marketplace/items/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = itemRow(id);
    if (!row) throw notFound('Item');
    if (row.author_id !== req.userId && !isAdmin(req.userId)) throw forbidden();
    if (row.official) throw forbidden('Official items cannot be edited');
    const body = parse(
      z.object({
        name: z.string().min(2).max(40).optional(), description: z.string().max(200).optional(), tags: z.array(z.string().max(20)).max(5).optional(),
        visibility: z.enum(['private', 'public']).optional(), allow_copy: z.boolean().optional(), global: z.boolean().optional(),
      }),
      req.body,
    );
    if (row.origin) throw forbidden('Imported items are managed by their home server');
    if (body.visibility) db.prepare('UPDATE marketplace_items SET visibility = ? WHERE id = ?').run(body.visibility, id);
    if (body.allow_copy !== undefined) db.prepare('UPDATE marketplace_items SET allow_copy = ? WHERE id = ?').run(+body.allow_copy, id);
    if (body.global !== undefined) {
      if (body.global && !ctx.federation) throw badRequest('This server is not part of the global OpenCord network.');
      db.prepare('UPDATE marketplace_items SET global = ? WHERE id = ?').run(+body.global, id);
    }
    if (itemRow(id).visibility === 'private') db.prepare('UPDATE marketplace_items SET global = 0 WHERE id = ?').run(id);
    if (body.name) db.prepare('UPDATE marketplace_items SET name = ? WHERE id = ?').run(body.name.trim(), id);
    if (body.description !== undefined) db.prepare('UPDATE marketplace_items SET description = ? WHERE id = ?').run(body.description.trim(), id);
    if (body.tags) db.prepare('UPDATE marketplace_items SET tags = ? WHERE id = ?').run(JSON.stringify(body.tags), id);
    broadcastItem(id, 'MARKETPLACE_ITEM_UPDATE');
    publishItem(id);
    return store.marketplaceItem(itemRow(id), req.userId);
  });

  function removeItem(id: string) {
    const row = itemRow(id);
    // Unequip it everywhere before deleting.
    const col = ['avatar_decoration', 'profile_effect', 'nameplate'].includes(row.category) ? row.category : null;
    const affected = col ? (db.prepare(`SELECT id FROM users WHERE ${col} = ?`).all(id) as any[]).map((r) => r.id) : [];
    if (col) db.prepare(`UPDATE users SET ${col} = NULL WHERE ${col} = ?`).run(id);
    if (row.category === 'banner') {
      affected.push(...(db.prepare('SELECT id FROM users WHERE banner = ?').all(`market:${id}`) as any[]).map((r) => r.id));
      db.prepare('UPDATE users SET banner = NULL WHERE banner = ?').run(`market:${id}`);
    }
    db.prepare('DELETE FROM marketplace_items WHERE id = ?').run(id);
    if (!row.asset.startsWith('builtin:')) files.remove(row.asset);
    if (row.global) ctx.federation?.publish('item', id, {}, true);
    for (const u of affected) hub.broadcastUserUpdate(u);
    const online = (db.prepare('SELECT id FROM users').all() as any[]).map((u) => u.id).filter((u) => hub.isOnline(u));
    hub.toUsers(online, 'MARKETPLACE_ITEM_DELETE', { id });
  }

  app.delete('/marketplace/items/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = itemRow(id);
    if (!row) throw notFound('Item');
    if (row.official) throw forbidden('Official items cannot be deleted');
    if (row.author_id !== req.userId && !isAdmin(req.userId)) throw forbidden();
    removeItem(id);
    return { ok: true };
  });

  for (const method of ['PUT', 'DELETE'] as const) {
    app.route({
      method,
      url: '/marketplace/items/:id/like',
      handler: async (req) => {
        const { id } = req.params as { id: string };
        const row = itemRow(id);
        if (!row || row.status !== 'approved') throw notFound('Item');
        if (method === 'PUT') db.prepare('INSERT OR IGNORE INTO marketplace_likes (item_id, user_id) VALUES (?,?)').run(id, req.userId);
        else db.prepare('DELETE FROM marketplace_likes WHERE item_id = ? AND user_id = ?').run(id, req.userId);
        broadcastItem(id, 'MARKETPLACE_ITEM_UPDATE');
        return store.marketplaceItem(itemRow(id), req.userId);
      },
    });

    app.route({
      method,
      url: '/marketplace/items/:id/claim',
      handler: async (req) => {
        const { id } = req.params as { id: string };
        const row = itemRow(id);
        if (!row || !visibleTo(row, req.userId) || (row.status !== 'approved' && row.author_id !== req.userId)) throw notFound('Item');
        if (method === 'PUT') {
          db.prepare('INSERT OR IGNORE INTO marketplace_owned (item_id, user_id, claimed_at) VALUES (?,?,?)').run(id, req.userId, Date.now());
        } else {
          db.prepare('DELETE FROM marketplace_owned WHERE item_id = ? AND user_id = ?').run(id, req.userId);
          for (const col of ['avatar_decoration', 'profile_effect', 'nameplate']) {
            db.prepare(`UPDATE users SET ${col} = NULL WHERE id = ? AND ${col} = ?`).run(req.userId, id);
          }
          db.prepare('UPDATE users SET banner = NULL WHERE id = ? AND banner = ?').run(req.userId, `market:${id}`);
        }
        hub.broadcastUserUpdate(req.userId);
        broadcastItem(id, 'MARKETPLACE_ITEM_UPDATE');
        return store.marketplaceItem(itemRow(id), req.userId);
      },
    });
  }

  /* ── global items from other hosts ── */

  // Brings a global item from another host into this host's catalog (assets stay on the origin) and claims it.
  app.post('/marketplace/global/claim', async (req) => {
    const fed = ctx.federation;
    if (!fed) throw badRequest('This server is not part of the global OpenCord network.');
    const { key } = parse(z.object({ key: z.string().max(400) }), req.body);
    const rec = fed.getRecord(key);
    if (!rec || rec.kind !== 'item' || rec.deleted) throw notFound('Item');
    const d = rec.data as any;
    if (!CATEGORIES.includes(d.category)) throw badRequest('Unsupported item');
    if (rec.host === fed.origin) {
      db.prepare('INSERT OR IGNORE INTO marketplace_owned (item_id, user_id, claimed_at) VALUES (?,?,?)').run(d.id, req.userId, Date.now());
      hub.broadcastUserUpdate(req.userId);
      return store.marketplaceItem(itemRow(d.id), req.userId);
    }
    const origin = `${rec.host}|${d.id}`;
    const safe = (u: unknown) => (typeof u === 'string' && (/^https:\/\//.test(u) || /^http:\/\//.test(u) || u.startsWith('builtin:')) ? u : null);
    let row = db.prepare('SELECT * FROM marketplace_items WHERE origin = ?').get(origin) as any;
    const fields = [
      d.category, String(d.name ?? 'Item').slice(0, 40), String(d.description ?? '').slice(0, 200), safe(d.asset) ?? 'builtin:gradient',
      safe(d.preview), Array.isArray(d.colors) ? JSON.stringify(d.colors.slice(0, 3)) : null, JSON.stringify(Array.isArray(d.tags) ? d.tags.slice(0, 5) : []),
    ];
    if (row) {
      db.prepare('UPDATE marketplace_items SET category = ?, name = ?, description = ?, asset = ?, preview = ?, colors = ?, tags = ? WHERE id = ?').run(...fields, row.id);
    } else {
      const id = snowflake();
      db.prepare(
        `INSERT INTO marketplace_items (id, category, name, description, asset, preview, colors, tags, official, author_id, status, created_at, visibility, allow_copy, global, origin)
         VALUES (?,?,?,?,?,?,?,?,0,NULL,'approved',?,'imported',?,0,?)`,
      ).run(id, ...fields, Date.now(), d.allow_copy === false ? 0 : 1, origin);
      row = itemRow(id);
    }
    db.prepare('INSERT OR IGNORE INTO marketplace_owned (item_id, user_id, claimed_at) VALUES (?,?,?)').run(row.id, req.userId, Date.now());
    hub.broadcastUserUpdate(req.userId);
    return store.marketplaceItem(itemRow(row.id), req.userId);
  });

  app.post('/marketplace/items/:id/report', async (req) => {
    const { id } = req.params as { id: string };
    if (!itemRow(id)) throw notFound('Item');
    const { reason } = parse(z.object({ reason: z.string().min(1).max(500) }), req.body);
    db.prepare('INSERT OR REPLACE INTO marketplace_reports (item_id, user_id, reason, created_at) VALUES (?,?,?,?)').run(id, req.userId, reason, Date.now());
    return { ok: true };
  });

  /* ── moderation (instance admins) ── */

  app.get('/admin/marketplace/queue', async (req) => {
    if (!isAdmin(req.userId)) throw forbidden();
    const pending = (db.prepare("SELECT * FROM marketplace_items WHERE status = 'pending' ORDER BY created_at").all() as any[]).map((r) =>
      store.marketplaceItem(r, req.userId),
    );
    const reports = (
      db.prepare('SELECT item_id, COUNT(*) AS c, GROUP_CONCAT(reason, \' | \') AS reasons FROM marketplace_reports GROUP BY item_id ORDER BY c DESC').all() as any[]
    )
      .filter((r) => itemRow(r.item_id))
      .map((r) => ({ item: store.marketplaceItem(itemRow(r.item_id), req.userId), count: r.c, reasons: r.reasons }));
    return { pending, reports };
  });

  app.post('/admin/marketplace/items/:id/status', async (req) => {
    if (!isAdmin(req.userId)) throw forbidden();
    const { id } = req.params as { id: string };
    const { status } = parse(z.object({ status: z.enum(['approved', 'rejected', 'removed', 'dismiss']) }), req.body);
    if (!itemRow(id)) throw notFound('Item');
    if (status === 'removed') {
      removeItem(id);
      return { ok: true };
    }
    if (status === 'dismiss') {
      db.prepare('DELETE FROM marketplace_reports WHERE item_id = ?').run(id);
      return { ok: true };
    }
    db.prepare('UPDATE marketplace_items SET status = ? WHERE id = ?').run(status, id);
    broadcastItem(id, status === 'approved' ? 'MARKETPLACE_ITEM_CREATE' : 'MARKETPLACE_ITEM_UPDATE');
    return { ok: true };
  });
};
