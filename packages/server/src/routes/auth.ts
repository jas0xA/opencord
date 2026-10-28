import type { FastifyInstance } from 'fastify';
import { hash, verify } from '@node-rs/argon2';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { defaultUserSettings, passwordProblem, usernameProblem, type InstanceInfo } from '@opencord/shared';
import { VERSION, androidApkPath, authenticate, parse, type Ctx } from '../app';
import { ApiError, badRequest, randomToken, rateLimiter, sha256, snowflake } from '../util';
import { joinGuild, resolveInvite } from './invites';

export function verifyTotp(secret: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 });
  return totp.validate({ token: code.replace(/\s/g, ''), window: 1 }) !== null;
}

export function createSession(ctx: Ctx, userId: string, ua = '', ip = ''): string {
  const token = randomToken(32);
  const now = Date.now();
  ctx.db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_used, user_agent, ip) VALUES (?,?,?,?,?,?)')
    .run(sha256(token), userId, now, now, ua.slice(0, 200), ip);
  return token;
}

/**
 * Whether a username is free: locally, and (when this server takes part in the global network)
 * on the global directory, so names are unique across every OpenCord host.
 */
export async function usernameAvailable(ctx: Ctx, username: string, exceptUserId?: string): Promise<boolean> {
  const row = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string } | undefined;
  if (row && row.id !== exceptUserId) return false;
  return ctx.federation ? ctx.federation.usernameAvailable(username, exceptUserId) : true;
}

/** Password check that treats unusable hashes (e.g. users from other hosts) as a mismatch instead of throwing. */
export async function checkPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await verify(hash, pw);
  } catch {
    return false;
  }
}

export function hashPassword(pw: string) {
  return hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export default (ctx: Ctx) => async (app: FastifyInstance) => {
  const auth = authenticate(ctx);
  const { config, db } = ctx;

  app.get('/instance', async (): Promise<InstanceInfo> => {
    const ice: InstanceInfo['voice']['ice_servers'] = [];
    if (config.voice.stun.length) ice.push({ urls: config.voice.stun });
    if (config.voice.turn_url) ice.push({ urls: config.voice.turn_url, username: config.voice.turn_user, credential: config.voice.turn_pass });
    return {
      name: config.instance.name,
      description: config.instance.description,
      version: VERSION,
      registration: config.registration.mode,
      require_email_verification: config.registration.require_email_verification && ctx.mailer.enabled,
      max_upload_mb: config.storage.max_upload_mb,
      community_marketplace: config.marketplace.community_enabled,
      connections: Object.entries(config.connections)
        .filter(([, v]) => v.client_id && v.client_secret)
        .map(([k]) => k),
      voice: { ice_servers: ice },
      web: { enabled: config.web.enabled, android_apk: !!androidApkPath(config) },
      network: !!ctx.federation,
    };
  });

  app.post('/auth/register', async (req) => {
    const body = parse(
      z.object({
        email: z.string().email().max(254),
        username: z.string().max(32),
        password: z.string().max(128),
        display_name: z.string().max(32).optional(),
        invite: z.string().max(64).optional(),
      }),
      req.body,
    );
    const mode = config.registration.mode;
    const email = body.email.trim().toLowerCase();
    const username = body.username.trim().toLowerCase();

    if (mode === 'closed') throw new ApiError(403, 'Registration is disabled on this server.', 40001);
    const nameErr = usernameProblem(username);
    if (nameErr) throw badRequest('Invalid Form Body', { username: nameErr });
    const pwErr = passwordProblem(body.password, { minLength: config.registration.min_password_length, username });
    if (pwErr) throw badRequest('Invalid Form Body', { password: pwErr });
    if (mode === 'allowlist') {
      const entry = db.prepare('SELECT * FROM allowlist WHERE email = ?').get(email) as any;
      // An approved email may add more accounts once it has one.
      const hasAccount = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
      if (!entry || (entry.used_at && !hasAccount)) {
        throw new ApiError(403, 'This server only allows registration for approved email addresses.', 40002, {
          email: 'This email is not on the allowlist',
        });
      }
    }
    let invite = null;
    if (body.invite) {
      invite = resolveInvite(ctx, body.invite);
      if (!invite) throw badRequest('Invalid Form Body', { invite: 'Invalid or expired invite' });
    } else if (mode === 'invite_only') {
      throw new ApiError(403, 'An invite is required to register on this server.', 40003, { invite: 'Invite required' });
    }
    // One email may own several accounts; usernames are what must be unique.
    const onEmail = (db.prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?').get(email) as { c: number }).c;
    if (onEmail >= config.registration.max_accounts_per_email) {
      throw badRequest('Invalid Form Body', { email: `This email already has the maximum of ${config.registration.max_accounts_per_email} accounts` });
    }
    if (!(await usernameAvailable(ctx, username))) throw badRequest('Invalid Form Body', { username: 'Username is unavailable' });

    const id = snowflake();
    const isFirst = !(db.prepare('SELECT 1 FROM users LIMIT 1').get());
    const isAdmin = isFirst || config.instance.admin_emails.map((e) => e.toLowerCase()).includes(email);
    const needsVerify = config.registration.require_email_verification && ctx.mailer.enabled;
    const pwHash = await hashPassword(body.password);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO users (id, username, email, password_hash, display_name, admin, email_verified, badges, settings, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, username, email, pwHash, body.display_name?.trim() || null, isAdmin ? 1 : 0, needsVerify ? 0 : 1,
        JSON.stringify(isFirst ? ['early_supporter'] : []), JSON.stringify(defaultUserSettings()), Date.now(),
      );
      if (mode === 'allowlist') db.prepare('UPDATE allowlist SET used_at = ? WHERE email = ?').run(Date.now(), email);
    })();

    if (needsVerify) {
      ctx.federation?.publish('user', username, { id });
      const token = randomToken(24);
      db.prepare('INSERT INTO email_tokens (token, user_id, kind, expires_at) VALUES (?,?,?,?)').run(token, id, 'verify', Date.now() + 86400_000);
      const base = config.server.public_url || `${req.protocol}://${req.host}`;
      await ctx.mailer.send(email, `Verify your ${config.instance.name} account`, `Verify your email: ${base}/api/v1/auth/verify?token=${token}`);
      return { verify_email: true };
    }
    ctx.federation?.publish('user', username, { id });
    if (invite) joinGuild(ctx, invite.guild_id, id, invite.code);
    return { token: createSession(ctx, id, req.headers['user-agent'] ?? '', req.ip) };
  });

  app.get('/auth/verify', async (req, reply) => {
    const { token } = req.query as { token?: string };
    const row = token ? (db.prepare("SELECT * FROM email_tokens WHERE token = ? AND kind = 'verify'").get(token) as any) : null;
    if (!row || row.expires_at < Date.now()) return reply.type('text/html').send('<p>This link is invalid or has expired.</p>');
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
    db.prepare('DELETE FROM email_tokens WHERE token = ?').run(token);
    return reply.type('text/html').send('<p>Email verified! You can now log in from the OpenCord app.</p>');
  });

  // Slow down password and two-factor guessing: per address, and per account name.
  const loginByIp = rateLimiter(100, 10 * 60_000); // generous: users behind one proxy can share an address
  const loginByName = rateLimiter(10, 10 * 60_000);
  const mfaByUser = rateLimiter(8, 10 * 60_000);
  const forgotByEmail = rateLimiter(3, 60 * 60_000, 'A reset email was sent recently. Check your inbox or try again later.');

  app.post('/auth/login', async (req) => {
    const body = parse(z.object({ login: z.string().min(1).max(254), password: z.string().min(1).max(128), code: z.string().max(12).optional(), account_id: z.string().max(32).optional() }), req.body);
    const login = body.login.trim().toLowerCase();
    loginByIp.hit(req.ip);
    loginByName.hit(login);
    const invalid = new ApiError(400, 'Login or password is invalid.', 50035, { login: 'Login or password is invalid.', password: 'Login or password is invalid.' });
    // An email can own several accounts: log into the one whose password matches. If more than one
    // does, the user has to pick by username (or `account_id` from the returned list).
    const candidates = db.prepare('SELECT * FROM users WHERE (username = ? OR email = ?) AND home_host IS NULL ORDER BY created_at').all(login, login) as any[];
    if (!candidates.length) {
      await hashPassword('timing-equaliser');
      throw invalid;
    }
    const matching: any[] = [];
    for (const c of candidates.slice(0, 10)) if (await checkPassword(c.password_hash, body.password)) matching.push(c);
    const user = body.account_id ? matching.find((m) => m.id === body.account_id) : matching.length === 1 ? matching[0] : null;
    if (!matching.length || (body.account_id && !user)) throw invalid;
    if (!user) return { choose_account: matching.map((m) => ({ id: m.id, username: m.username, display_name: m.display_name, avatar: m.avatar ? `/uploads/${m.avatar}` : null })) };
    if (user.disabled) throw new ApiError(403, 'This account has been disabled.', 20013);
    if (!user.email_verified) throw new ApiError(403, 'Please verify your email address first.', 40004);
    if (user.mfa_secret) {
      if (!body.code) return { mfa: true, account_id: user.id };
      mfaByUser.hit(user.id);
      if (!verifyTotp(user.mfa_secret, body.code)) throw badRequest('Invalid two-factor code', { code: 'Invalid two-factor code' });
      mfaByUser.reset(user.id);
    }
    loginByName.reset(login);
    return { token: createSession(ctx, user.id, req.headers['user-agent'] ?? '', req.ip) };
  });

  app.post('/auth/logout', { preHandler: auth }, async (req) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
    return { ok: true };
  });

  app.post('/auth/forgot', async (req) => {
    const { email } = parse(z.object({ email: z.string().email() }), req.body);
    forgotByEmail.hit(email.toLowerCase());
    const users = db.prepare('SELECT id, username FROM users WHERE email = ?').all(email.toLowerCase()) as any[];
    if (users.length && ctx.mailer.enabled) {
      const lines: string[] = [];
      for (const u of users) {
        const token = randomToken(24);
        db.prepare('INSERT INTO email_tokens (token, user_id, kind, expires_at) VALUES (?,?,?,?)').run(token, u.id, 'reset', Date.now() + 3600_000);
        lines.push(`@${u.username}: ${token}`);
      }
      await ctx.mailer.send(email, `Reset your ${config.instance.name} password`, `Your password reset code${users.length > 1 ? 's' : ''}:\n\n${lines.join('\n')}\n\nThey expire in one hour.`);
    }
    // Same answer whether or not the email exists.
    return { ok: true, smtp: ctx.mailer.enabled };
  });

  app.post('/auth/reset', async (req) => {
    const body = parse(z.object({ token: z.string(), password: z.string().max(128) }), req.body);
    const row = db.prepare("SELECT * FROM email_tokens WHERE token = ? AND kind = 'reset'").get(body.token) as any;
    if (!row || row.expires_at < Date.now()) throw badRequest('Invalid or expired reset code', { token: 'Invalid or expired reset code' });
    const pwErr = passwordProblem(body.password, { minLength: config.registration.min_password_length, username: ctx.store.userRow(row.user_id)?.username });
    if (pwErr) throw badRequest('Invalid Form Body', { password: pwErr });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.password), row.user_id);
    db.prepare('DELETE FROM email_tokens WHERE token = ?').run(body.token);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    ctx.hub.kickUser(row.user_id);
    return { ok: true };
  });

  /* ── more accounts on the same email ── */

  // Accounts that share the signed-in account's email (for the account switcher).
  app.get('/users/@me/siblings', { preHandler: auth }, async (req) => {
    const me = ctx.store.userRow(req.userId)!;
    if (!me.email) return [];
    return (db.prepare('SELECT * FROM users WHERE email = ? AND id != ? AND home_host IS NULL ORDER BY created_at').all(me.email, me.id) as any[]).map((r) => ctx.store.publicUser(r));
  });

  // Creates another account on the signed-in account's (already verified) email.
  app.post('/users/@me/siblings', { preHandler: auth }, async (req) => {
    const body = parse(z.object({ username: z.string().max(32), password: z.string().max(128), current_password: z.string().max(128), display_name: z.string().max(32).optional() }), req.body);
    const me = ctx.store.userRow(req.userId)! as any;
    if (me.home_host) throw badRequest('Create accounts on your home server.');
    if (!(await checkPassword(me.password_hash, body.current_password))) throw badRequest('Invalid Form Body', { current_password: 'Password does not match.' });
    if (config.registration.mode === 'closed') throw new ApiError(403, 'Registration is disabled on this server.', 40001);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?').get(me.email) as any).c;
    if (count >= config.registration.max_accounts_per_email) throw badRequest(`This email already has the maximum of ${config.registration.max_accounts_per_email} accounts`);
    const username = body.username.trim().toLowerCase();
    const nameErr = usernameProblem(username);
    if (nameErr) throw badRequest('Invalid Form Body', { username: nameErr });
    if (!(await usernameAvailable(ctx, username))) throw badRequest('Invalid Form Body', { username: 'Username is unavailable' });
    const pwErr = passwordProblem(body.password, { minLength: config.registration.min_password_length, username });
    if (pwErr) throw badRequest('Invalid Form Body', { password: pwErr });
    const id = snowflake();
    db.prepare(
      `INSERT INTO users (id, username, email, password_hash, display_name, email_verified, badges, settings, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, username, me.email, await hashPassword(body.password), body.display_name?.trim() || null, me.email_verified, '[]', JSON.stringify(defaultUserSettings()), Date.now());
    ctx.federation?.publish('user', username, { id });
    return { token: createSession(ctx, id, req.headers['user-agent'] ?? '', req.ip), user: ctx.store.publicUser(ctx.store.userRow(id)!) };
  });

  /* ── two-factor ── */

  app.get('/users/@me/mfa/totp/setup', { preHandler: auth }, async (req) => {
    const user = ctx.store.userRow(req.userId)!;
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({ issuer: config.instance.name, label: user.username, secret, digits: 6, period: 30 });
    return { secret: secret.base32, uri: totp.toString() };
  });

  app.post('/users/@me/mfa/totp/enable', { preHandler: auth }, async (req) => {
    const body = parse(z.object({ secret: z.string().min(16), code: z.string(), password: z.string() }), req.body);
    const user = ctx.store.userRow(req.userId)!;
    if (!(await checkPassword(user.password_hash, body.password))) throw badRequest('Invalid password', { password: 'Password does not match.' });
    if (!verifyTotp(body.secret, body.code)) throw badRequest('Invalid code', { code: 'Invalid two-factor code' });
    db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(body.secret, req.userId);
    ctx.hub.broadcastUserUpdate(req.userId);
    return { ok: true };
  });

  app.post('/users/@me/mfa/totp/disable', { preHandler: auth }, async (req) => {
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const user = ctx.store.userRow(req.userId)!;
    mfaByUser.hit(req.userId);
    if (!user.mfa_secret || !verifyTotp(user.mfa_secret, code)) throw badRequest('Invalid code', { code: 'Invalid two-factor code' });
    db.prepare('UPDATE users SET mfa_secret = NULL WHERE id = ?').run(req.userId);
    ctx.hub.broadcastUserUpdate(req.userId);
    return { ok: true };
  });
};
