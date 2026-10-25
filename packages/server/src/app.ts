import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, type ZodTypeAny } from 'zod';
import { API_PREFIX, GATEWAY_PATH, MAX_UPLOAD_MB_CAP } from '@opencord/shared';
import type { Config } from './config';
import type { DB } from './db';
import { FileStore } from './files';
import { Hub } from './gateway/hub';
import { Mailer } from './mailer';
import { Sfu } from './sfu';
import { Store } from './store';
import { StorageManager } from './storage';
import { ApiError, sha256 } from './util';
import { seedMarketplace } from './marketplace-seed';
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import guildRoutes from './routes/guilds';
import channelRoutes from './routes/channels';
import inviteRoutes from './routes/invites';
import marketplaceRoutes from './routes/marketplace';
import adminRoutes from './routes/admin';
import reportRoutes from './routes/reports';
import federationRoutes from './routes/federation';
import discoveryRoutes, { publishGuild } from './routes/discovery';
import themeRoutes from './routes/themes';
import { Federation } from './federation';
import { makeInboxHandler } from './federation/relay';
import { CallBridge } from './federation/callbridge';
import { UpdateChecker } from './updates';
import { relationshipHelpers } from './routes/users';

export const VERSION = process.env.OPENCORD_VERSION ?? '0.1.0';

export interface Ctx {
  config: Config;
  db: DB;
  store: Store;
  hub: Hub;
  sfu: Sfu;
  files: FileStore;
  /** Disk usage against [storage].max_storage_gb, and cleanup of old messages near the limit. */
  storage: StorageManager;
  mailer: Mailer;
  /** Global OpenCord network (directory of hosts, usernames and public servers); absent when disabled. */
  federation?: Federation;
  /** Bridges DM calls with users on other hosts (present when the federation is). */
  callBridge?: CallBridge;
  updates: UpdateChecker;
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    sessionHash: string;
  }
}

/** Parses a body/query with zod, turning failures into a 400 with field errors. */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const errors: Record<string, string> = {};
    for (const i of r.error.issues) errors[i.path.join('.') || '_'] = i.message;
    throw new ApiError(400, 'Invalid Form Body', 50035, errors);
  }
  return r.data;
}

/** preHandler that requires a valid session token. */
export function authenticate(ctx: Ctx) {
  const stmt = ctx.db.prepare(
    'SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.disabled = 0',
  );
  const touch = ctx.db.prepare('UPDATE sessions SET last_used = ? WHERE token_hash = ?');
  return async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : header;
    if (!token) throw new ApiError(401, 'Unauthorized', 0);
    const hash = sha256(token);
    const row = stmt.get(hash) as { user_id: string } | undefined;
    if (!row) throw new ApiError(401, 'Unauthorized', 0);
    req.userId = row.user_id;
    req.sessionHash = hash;
    touch.run(Date.now(), hash);
  };
}

export async function buildApp(config: Config, db: DB, opts: { logger?: boolean; fetch?: typeof fetch } = {}): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const httpsOpts =
    config.tls.enabled && config.tls.cert && config.tls.key
      ? { https: { cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) } }
      : {};
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logging.level },
    trustProxy: config.server.trust_proxy,
    // JSON bodies carry images as data: URLs (avatars, emoji, marketplace items). Message
    // attachments are multipart and stream to disk, limited per request below.
    bodyLimit: Math.max(config.storage.max_avatar_mb, config.marketplace.max_item_mb, 10) * 1024 * 1024 * 1.4,
    ...(httpsOpts as object),
  }) as unknown as FastifyInstance;

  const store = new Store(db);
  const sfu = new Sfu();
  const announcedIp =
    config.sfu.announced_ip ||
    (() => {
      try {
        return config.server.public_url ? new URL(config.server.public_url).hostname : undefined;
      } catch {
        return undefined;
      }
    })();
  await sfu.start({
    listenIp: config.sfu.listen_ip,
    announcedIp: announcedIp || undefined,
    rtcMinPort: config.sfu.rtc_min_port,
    rtcMaxPort: config.sfu.rtc_max_port,
  });
  const hub = new Hub(store, sfu);
  const files = new FileStore(path.join(config.dataDir, 'uploads'));
  const ctx: Ctx = {
    config,
    db,
    store,
    hub,
    sfu,
    files,
    storage: new StorageManager(db, files, config, hub, store),
    mailer: new Mailer(config),
    updates: new UpdateChecker(config, VERSION),
  };
  ctx.updates.start();
  seedMarketplace(db);

  if (config.federation.enabled) {
    if (!config.server.public_url) {
      console.warn('[federation] disabled: set [server].public_url so other hosts can reach this server');
    } else {
      const fed = new Federation(db, config, config.federation, opts.fetch);
      ctx.federation = fed;
      fed.onInbox(makeInboxHandler(ctx, relationshipHelpers(ctx)));
      const bridge = new CallBridge(ctx);
      ctx.callBridge = bridge;
      ctx.hub.onPrivateVoice = (userId, channelId, state) => bridge.onLocalVoice(userId, channelId, state);
      // Claim every local username that isn't in the directory yet (first start / after enabling).
      for (const u of db.prepare('SELECT id, username FROM users WHERE home_host IS NULL').all() as { id: string; username: string }[]) {
        const rec = fed.getRecord(`user:${u.username}`);
        if (!rec || (rec.deleted && rec.host === fed.origin)) fed.publish('user', u.username, { id: u.id });
      }
      fed.start();
      // Keep global server listings (member counts, names, icons) fresh.
      const refresh = setInterval(() => {
        for (const g of db.prepare('SELECT id FROM guilds WHERE global = 1').all() as { id: string }[]) publishGuild(ctx, g.id);
      }, 30 * 60_000);
      refresh.unref?.();
      app.addHook('onClose', async () => clearInterval(refresh));
    }
  }

  // The library default only allows GET/HEAD/POST, which makes browsers block PATCH/PUT/DELETE preflights.
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400,
  });
  // The hard ceiling; the admin-set max_upload_mb (changeable at runtime) is applied per request.
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_MB_CAP * 1024 * 1024, files: 10 } });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  await app.register(fastifyStatic, {
    root: ctx.files.root,
    prefix: '/uploads/',
    maxAge: '30d',
    immutable: true,
    setHeaders: (res) => res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'"),
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ message: err.message, code: err.code, errors: err.errors });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ message: err.message, code: 0 });
    }
    app.log.error(err);
    return reply.status(500).send({ message: 'Internal Server Error', code: 0 });
  });

  app.get(GATEWAY_PATH, { websocket: true }, (socket, req) => ctx.hub.attach(socket as any, req.hostname));

  await app.register(
    async (api) => {
      await api.register(authRoutes(ctx));
      await api.register(userRoutes(ctx));
      await api.register(guildRoutes(ctx));
      await api.register(channelRoutes(ctx));
      await api.register(inviteRoutes(ctx));
      await api.register(marketplaceRoutes(ctx));
      await api.register(adminRoutes(ctx));
      await api.register(reportRoutes(ctx));
      await api.register(federationRoutes(ctx));
      await api.register(discoveryRoutes(ctx));
      await api.register(themeRoutes(ctx));
    },
    { prefix: API_PREFIX },
  );

  // The web app (phones and browsers), or friendly landing pages when it's off or not built.
  const webDir = config.web.enabled ? findWebDir() : null;
  if (webDir) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      decorateReply: false,
      index: ['index.html'],
      // index.html and the service worker must revalidate so updates reach installed apps.
      setHeaders: (res, file) => {
        if (/\/assets\//.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send(landingPage(config.instance.name, 'This is an OpenCord server. Add it in the OpenCord app using this address.')),
    );
  }
  app.get('/invite/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    if (webDir) return reply.redirect(`/?invite=${encodeURIComponent(code)}`);
    return reply
      .type('text/html')
      .send(landingPage(config.instance.name, `You've been invited! Open OpenCord, connect to this server and use invite code <b>${escapeHtml(code)}</b>.`));
  });
  // Digital Asset Links: lets the Android app (a Trusted Web Activity) open this site full-screen.
  app.get('/.well-known/assetlinks.json', async (_req, reply) => {
    const fingerprints = config.web.android_sha256.split(',').map((s) => s.trim()).filter(Boolean);
    if (!fingerprints.length) return reply.status(404).send([]);
    return [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: config.web.android_package, sha256_cert_fingerprints: fingerprints } }];
  });
  // Android app download (an APK the host provides, e.g. built with scripts/build-android.sh).
  app.get('/download/android', async (_req, reply) => {
    const apk = androidApkPath(config);
    if (!apk) return reply.status(404).type('text/html').send(landingPage(config.instance.name, 'No Android app is available on this server. Use the web app instead.'));
    reply.header('Content-Disposition', 'attachment; filename="OpenCord.apk"');
    return reply.type('application/vnd.android.package-archive').send(fs.createReadStream(apk));
  });

  app.addHook('onClose', async () => {
    ctx.updates.stop();
    ctx.federation?.stop();
    ctx.hub.close();
    await ctx.sfu.close();
  });
  return { app, ctx };
}

/** Built web client: next to the bundled server (release), $OPENCORD_WEB_DIR, or the client build in the repo (dev). */
function findWebDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.OPENCORD_WEB_DIR,
    process.argv[1] ? path.join(path.dirname(path.resolve(process.argv[1])), 'web') : undefined,
    path.join(here, 'web'),
    path.resolve(here, '../../client/out/renderer'),
  ].filter(Boolean) as string[];
  return candidates.find((d) => fs.existsSync(path.join(d, 'index.html'))) ?? null;
}

export function androidApkPath(config: Config): string | null {
  if (!config.web.android_apk) return null;
  const p = path.resolve(path.dirname(config.configPath), config.web.android_apk);
  return fs.existsSync(p) ? p : null;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function landingPage(title: string, body: string) {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#313338;color:#dbdee1;font-family:system-ui,sans-serif">
<div style="background:#2b2d31;padding:32px 40px;border-radius:8px;max-width:420px;text-align:center">
<h1 style="color:#f2f3f5;font-size:24px;margin:0 0 12px">${escapeHtml(title)}</h1><p style="line-height:1.5">${body}</p></div></body>`;
}
