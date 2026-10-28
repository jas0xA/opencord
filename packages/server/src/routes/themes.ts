import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authenticate, parse, type Ctx } from '../app';
import { badRequest, forbidden, notFound, snowflake } from '../util';

const MAX_CODE = 100_000;

/**
 * User themes: CSS plus optional JavaScript that the client runs in a sandboxed worker. A theme is
 * private (author only), public (everyone on this host) or global (also listed on the network).
 * `allow_copy = false` hides the source in the editor and blocks re-publishing identical code; the
 * client still has to receive the code to apply it, so this deters copying rather than preventing it.
 */
export default (ctx: Ctx) => async (app: FastifyInstance) => {
  const { db, store } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const row = (id: string) => db.prepare('SELECT * FROM themes WHERE id = ?').get(id) as any;
  const codeHash = (css: string, js: string) => createHash('sha256').update(`${css.trim()}\u0000${js.trim()}`).digest('hex');
  const visible = (t: any, uid: string) => t.visibility !== 'private' || t.author_id === uid;

  function serialize(t: any, uid: string, withCode: boolean) {
    const mine = t.author_id === uid;
    const showSource = mine || !!t.allow_copy;
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      visibility: t.visibility,
      allow_copy: !!t.allow_copy,
      author: t.author_id && store.userRow(t.author_id) ? store.user(t.author_id) : null,
      origin: t.origin,
      installs: t.installs,
      mine,
      can_view_source: showSource,
      created_at: t.created_at,
      updated_at: t.updated_at,
      ...(withCode ? { css: t.css, js: t.js } : {}),
    };
  }

  /** Publishes a global theme to the network, or withdraws it when it stopped being global. */
  function publish(id: string, wasGlobal = false) {
    const fed = ctx.federation;
    if (!fed) return;
    const t = row(id);
    if (!t || t.visibility !== 'global') {
      if (wasGlobal) fed.publish('theme', id, {}, true);
      return;
    }
    const author = t.author_id ? store.userRow(t.author_id) : null;
    fed.publish('theme', id, {
      id, name: t.name, description: t.description, allow_copy: !!t.allow_copy, has_js: !!t.js.trim(),
      author: author ? `${author.username}@${new URL(fed.origin).host}` : null,
      source: `${fed.origin}/api/v1/federation/themes/${id}`, updated_at: t.updated_at,
    });
  }

  app.get('/themes', async (req) => {
    const q = parse(z.object({ tab: z.enum(['mine', 'public', 'installed']).default('public'), q: z.string().max(100).optional() }), req.query);
    const args: unknown[] = [];
    let where = q.tab === 'mine' ? 'author_id = ?' : "visibility IN ('public', 'global') AND origin IS NULL";
    if (q.tab === 'mine') args.push(req.userId);
    if (q.tab === 'installed') {
      where = 'origin IS NOT NULL AND author_id IS NULL';
    }
    if (q.q) {
      where += ' AND (name LIKE ? OR description LIKE ?)';
      args.push(`%${q.q}%`, `%${q.q}%`);
    }
    const rows = db.prepare(`SELECT * FROM themes WHERE ${where} ORDER BY ${q.tab === 'public' ? 'installs DESC,' : ''} updated_at DESC LIMIT 100`).all(...args) as any[];
    return rows.map((t) => serialize(t, req.userId, false));
  });

  app.get('/themes/:id', async (req) => {
    const t = row((req.params as { id: string }).id);
    if (!t || !visible(t, req.userId)) throw notFound('Theme');
    // Code is always returned (the client needs it to apply the theme); the editor hides it when copying isn't allowed.
    return serialize(t, req.userId, true);
  });

  const themeBody = z.object({
    name: z.string().min(1).max(60),
    description: z.string().max(300).default(''),
    css: z.string().max(MAX_CODE).default(''),
    js: z.string().max(MAX_CODE).default(''),
    visibility: z.enum(['private', 'public', 'global']).default('private'),
    allow_copy: z.boolean().default(true),
  });

  function checkCopy(css: string, js: string, uid: string, exceptId?: string) {
    if (!css.trim() && !js.trim()) return;
    const h = codeHash(css, js);
    const others = db.prepare('SELECT id, css, js FROM themes WHERE allow_copy = 0 AND (author_id IS NOT ? OR author_id IS NULL) AND id IS NOT ?').all(uid, exceptId ?? null) as any[];
    if (others.some((o) => codeHash(o.css, o.js) === h)) throw badRequest("This theme's code belongs to someone who doesn't allow copies.");
  }

  app.post('/themes', async (req) => {
    const body = parse(themeBody, req.body);
    if (body.visibility === 'global' && !ctx.federation) throw badRequest('This server is not part of the global OpenCord network.');
    const count = (db.prepare('SELECT COUNT(*) AS c FROM themes WHERE author_id = ?').get(req.userId) as any).c;
    if (count >= 50) throw badRequest('You can have at most 50 themes.');
    checkCopy(body.css, body.js, req.userId);
    const id = snowflake();
    const now = Date.now();
    db.prepare('INSERT INTO themes (id, author_id, name, description, css, js, visibility, allow_copy, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      id, req.userId, body.name.trim(), body.description.trim(), body.css, body.js, body.visibility, +body.allow_copy, now, now,
    );
    publish(id);
    return serialize(row(id), req.userId, true);
  });

  app.patch('/themes/:id', async (req) => {
    const t = row((req.params as { id: string }).id);
    if (!t) throw notFound('Theme');
    if (t.author_id !== req.userId) throw forbidden();
    const body = parse(themeBody.partial(), req.body);
    if (body.visibility === 'global' && !ctx.federation) throw badRequest('This server is not part of the global OpenCord network.');
    const next = { ...t, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
    checkCopy(next.css, next.js, req.userId, t.id);
    db.prepare('UPDATE themes SET name = ?, description = ?, css = ?, js = ?, visibility = ?, allow_copy = ?, updated_at = ? WHERE id = ?').run(
      String(next.name).trim(), String(next.description).trim(), next.css, next.js, next.visibility, +!!next.allow_copy, Date.now(), t.id,
    );
    publish(t.id, t.visibility === 'global');
    return serialize(row(t.id), req.userId, true);
  });

  app.delete('/themes/:id', async (req) => {
    const t = row((req.params as { id: string }).id);
    if (!t) throw notFound('Theme');
    if (t.author_id !== req.userId && !store.userRow(req.userId)?.admin) throw forbidden();
    db.prepare('DELETE FROM themes WHERE id = ?').run(t.id);
    if (t.visibility === 'global') ctx.federation?.publish('theme', t.id, {}, true);
    return { ok: true };
  });

  // Counts an install (for sorting) and returns the code to apply.
  app.post('/themes/:id/install', async (req) => {
    const t = row((req.params as { id: string }).id);
    if (!t || !visible(t, req.userId)) throw notFound('Theme');
    db.prepare('UPDATE themes SET installs = installs + 1 WHERE id = ?').run(t.id);
    return serialize(row(t.id), req.userId, true);
  });

  // Duplicate a theme into your own (only when its author allows copies).
  app.post('/themes/:id/fork', async (req) => {
    const t = row((req.params as { id: string }).id);
    if (!t || !visible(t, req.userId)) throw notFound('Theme');
    if (!t.allow_copy && t.author_id !== req.userId) throw forbidden("This theme's author doesn't allow copies.");
    const id = snowflake();
    const now = Date.now();
    db.prepare('INSERT INTO themes (id, author_id, name, description, css, js, visibility, allow_copy, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)').run(
      id, req.userId, `${t.name} (copy)`.slice(0, 60), t.description, t.css, t.js, 'private', now, now,
    );
    return serialize(row(id), req.userId, true);
  });

  // Install a global theme from another host: fetch its source from the origin and keep a local copy.
  app.post('/themes/global/install', async (req) => {
    const fed = ctx.federation;
    if (!fed) throw badRequest('This server is not part of the global OpenCord network.');
    const { key } = parse(z.object({ key: z.string().max(400) }), req.body);
    const rec = fed.getRecord(key);
    if (!rec || rec.kind !== 'theme' || rec.deleted) throw notFound('Theme');
    const d = rec.data as any;
    if (rec.host === fed.origin) {
      const local = row(String(d.id));
      if (!local) throw notFound('Theme');
      return serialize(local, req.userId, true);
    }
    const source = String(d.source ?? '');
    if (!source.startsWith(`${rec.host}/`)) throw badRequest('Bad theme source');
    const t = (await fed.getJson(source).catch(() => null)) as any;
    if (!t || typeof t.css !== 'string' || typeof t.js !== 'string' || t.css.length > MAX_CODE || t.js.length > MAX_CODE) throw badRequest('Could not download that theme.');
    const origin = rec.host;
    const existing = db.prepare('SELECT id FROM themes WHERE origin = ? AND remote_id = ?').get(origin, String(d.id)) as { id: string } | undefined;
    const now = Date.now();
    let id = existing?.id;
    if (id) {
      db.prepare('UPDATE themes SET name = ?, description = ?, css = ?, js = ?, allow_copy = ?, updated_at = ? WHERE id = ?').run(
        String(t.name ?? d.name).slice(0, 60), String(t.description ?? '').slice(0, 300), t.css, t.js, t.allow_copy === false ? 0 : 1, now, id,
      );
    } else {
      id = snowflake();
      db.prepare(
        "INSERT INTO themes (id, author_id, name, description, css, js, visibility, allow_copy, origin, remote_id, created_at, updated_at) VALUES (?,NULL,?,?,?,?,'public',?,?,?,?,?)",
      ).run(id, String(t.name ?? d.name).slice(0, 60), String(t.description ?? '').slice(0, 300), t.css, t.js, t.allow_copy === false ? 0 : 1, origin, String(d.id), now, now);
    }
    return { ...serialize(row(id), req.userId, true), author_label: d.author ?? null };
  });
};
