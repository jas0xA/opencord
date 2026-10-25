import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, parse, type Ctx } from '../app';
import { fileUrl } from '../store';
import { ApiError, badRequest, notFound } from '../util';
import { toOrigin, type RecordKind } from '../federation';
import { ensureRemoteUser } from '../federation/relay';
import { createSession } from './auth';

/**
 * Global network API. Host-to-host endpoints are public (requests that change anything are
 * signed by the sending host); the /federation/client/* endpoints are for signed-in users.
 */
export default (ctx: Ctx) => async (app: FastifyInstance) => {
  const { db, store } = ctx;
  const auth = authenticate(ctx);
  const fed = () => {
    if (!ctx.federation) throw new ApiError(404, 'This server is not part of the global OpenCord network.', 0);
    return ctx.federation;
  };

  // Keep the raw body: signatures cover the exact bytes that were sent.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  /* ───────────── host ↔ host ───────────── */

  app.get('/federation/key', async () => ({ origin: fed().origin, pubkey: fed().key.publicKey }));

  // Hosts that don't help host only serve their own records (so others still learn about them).
  app.get('/federation/records', async (req) => {
    const f = fed();
    const since = Number((req.query as any).since) || 0;
    const page = f.recordsSince(since);
    return f.helpsHost ? page : { records: page.records.filter((r) => r.host === f.origin), cursor: page.cursor };
  });

  app.get('/federation/records/:key', async (req) => {
    const f = fed();
    const r = f.getRecord((req.params as { key: string }).key);
    if (!r || (!f.helpsHost && r.host !== f.origin)) throw notFound('Record');
    return r;
  });

  app.get('/federation/users/:username', async (req) => {
    const f = fed();
    const row = db.prepare('SELECT * FROM users WHERE username = ? AND home_host IS NULL AND disabled = 0').get((req.params as any).username.toLowerCase()) as any;
    if (!row) throw notFound('User');
    const avatar = fileUrl(row.avatar);
    return { id: row.id, username: row.username, display_name: row.display_name, avatar: avatar ? (/^https?:/.test(avatar) ? avatar : `${f.origin}${avatar}`) : null };
  });

  app.post('/federation/inbox', async (req) => {
    const f = fed();
    const from = await f.verifyRequest(req.headers as any, '/api/v1/federation/inbox', (req as any).rawBody ?? '');
    if (!from) throw new ApiError(401, 'Bad host signature', 0);
    return f.handleInbox(from, req.body);
  });

  // Sign in with an account from another host (assertion issued by the user's home host).
  app.post('/federation/login', async (req) => {
    const f = fed();
    const { assertion } = parse(z.object({ assertion: z.string().max(4096) }), req.body);
    const claims = await f.checkAssertion(assertion);
    if (!claims) throw new ApiError(401, 'That sign-in link is invalid or expired.', 0);
    if (ctx.config.registration.mode === 'closed' && !db.prepare('SELECT 1 FROM users WHERE home_host = ? AND home_id = ?').get(claims.iss, claims.sub)) {
      throw new ApiError(403, 'This server is not accepting new members.', 40001);
    }
    const id = ensureRemoteUser(ctx, claims.iss, { id: claims.sub, username: claims.username, display_name: claims.display_name, avatar: claims.avatar });
    if (store.userRow(id)?.disabled) throw new ApiError(403, 'This account has been disabled.', 20013);
    return { token: createSession(ctx, id, req.headers['user-agent'] ?? '', req.ip) };
  });

  // Public theme source for global themes (fetched by other hosts' clients when installing).
  app.get('/federation/themes/:id', async (req) => {
    const row = db.prepare("SELECT * FROM themes WHERE id = ? AND visibility = 'global'").get((req.params as any).id) as any;
    if (!row) throw notFound('Theme');
    return { id: row.id, name: row.name, description: row.description, css: row.css, js: row.js, allow_copy: !!row.allow_copy, updated_at: row.updated_at };
  });

  /* ───────────── client ───────────── */

  app.get('/federation/client/status', { preHandler: auth }, async () => {
    if (!ctx.federation) return { enabled: false };
    const f = ctx.federation;
    const count = (sql: string) => (db.prepare(sql).get() as any).c as number;
    return {
      enabled: true,
      origin: f.origin,
      help_host: f.helpsHost,
      hosts: count("SELECT COUNT(*) AS c FROM federation_records WHERE kind = 'host' AND deleted = 0"),
      records: count('SELECT COUNT(*) AS c FROM federation_records'),
      peers: count('SELECT COUNT(*) AS c FROM federation_peers WHERE failures < 20'),
    };
  });

  // Short-lived proof of identity the client hands to another host to sign in there.
  app.post('/federation/client/assertion', { preHandler: auth }, async (req) => {
    const f = fed();
    const { audience } = parse(z.object({ audience: z.string().max(300) }), req.body);
    const me = store.userRow(req.userId)! as any;
    if (me.home_host) throw badRequest('Sign in on your home server to visit other servers.');
    let aud: string;
    try {
      aud = toOrigin(audience);
    } catch {
      throw badRequest('Invalid server address');
    }
    return { assertion: f.issueAssertion({ id: me.id, username: me.username, display_name: me.display_name, avatar: fileUrl(me.avatar) }, aud), origin: f.origin };
  });

  app.get('/federation/client/directory/:kind', { preHandler: auth }, async (req) => {
    const f = fed();
    const kind = (req.params as { kind: string }).kind as RecordKind;
    if (!['host', 'guild', 'item', 'theme'].includes(kind)) throw badRequest('Unknown directory');
    const q = parse(z.object({ q: z.string().max(100).optional(), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    return f.list(kind, { q: q.q, offset: q.offset, limit: 60 }).map((r) => ({ key: r.key, host: r.host, local: r.host === f.origin, ts: r.ts, ...r.data }));
  });
};
