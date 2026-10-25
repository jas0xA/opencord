// The global OpenCord network.
//
// Hosts that opt in share a *directory*: a set of small records, each signed by the host that wrote
// it, describing hosts, claimed usernames, public ("global") servers and global cosmetics. Every
// host that helps host the network stores the whole directory and serves it; the others only read
// it. Hosts pull new records from a few random helping peers on an interval (gossip), so the
// directory survives any single host going away and nobody owns it.
//
// On top of that, hosts talk to each other with signed requests (see `request` / `verifyRequest`):
// friend requests and DMs between users on different hosts are relayed through an outbox with
// retries, and users can sign in to another host with an assertion signed by their home host.
import type { Config } from '../config';
import type { DB } from '../db';
import { canonical, loadOrCreateHostKey, sha256b64, sign, signToken, readToken, verify, type HostKey } from './crypto';

export type RecordKind = 'host' | 'user' | 'guild' | 'item' | 'theme';

export interface DirRecord {
  key: string;
  kind: RecordKind;
  host: string;
  data: Record<string, unknown>;
  ts: number;
  deleted: boolean;
  sig: string;
}

export interface FederationConfig {
  enabled: boolean;
  help_host: boolean;
  seeds: string[];
  sync_interval_s: number;
}

const SKEW_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;

/** Normalises a URL or host to an origin ("https://chat.example.com"). */
export function toOrigin(input: string): string {
  const raw = /^https?:\/\//.test(input) ? input : `https://${input}`;
  const u = new URL(raw);
  return u.origin;
}

export const hostnameOf = (origin: string) => new URL(origin).host;

export type InboxHandler = (from: string, event: { type: string; [k: string]: unknown }) => Promise<unknown> | unknown;

export class Federation {
  readonly origin: string;
  readonly key: HostKey;
  private timer: NodeJS.Timeout | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private inbox: InboxHandler = () => undefined;
  private keyCache = new Map<string, string>();

  constructor(
    private db: DB,
    private config: Config,
    private fed: FederationConfig,
    /** Overridable for tests (in-process hosts). */
    private fetcher: typeof fetch = fetch,
  ) {
    if (!config.server.public_url) throw new Error('[federation] server.public_url must be set to join the global network');
    this.origin = toOrigin(config.server.public_url);
    this.key = loadOrCreateHostKey(config.dataDir);
  }

  get helpsHost() {
    return this.fed.help_host;
  }

  /** Live toggle for helping host the directory (re-announced on the next sync). */
  setHelpHost(on: boolean) {
    this.fed.help_host = on;
    this.publishHost();
  }

  addPeer(origin: string) {
    const o = toOrigin(origin);
    if (o !== this.origin) this.db.prepare('INSERT INTO federation_peers (origin) VALUES (?) ON CONFLICT(origin) DO UPDATE SET failures = 0').run(o);
    return o;
  }

  peerList() {
    return this.db.prepare('SELECT origin, last_ok, failures, pubkey IS NOT NULL AS pinned FROM federation_peers ORDER BY last_ok DESC').all() as {
      origin: string; last_ok: number | null; failures: number; pinned: number;
    }[];
  }

  onInbox(handler: InboxHandler) {
    this.inbox = handler;
  }

  /* ───────────── lifecycle ───────────── */

  start() {
    this.publishHost();
    for (const seed of this.fed.seeds) {
      try {
        const o = toOrigin(seed);
        if (o !== this.origin) this.db.prepare('INSERT OR IGNORE INTO federation_peers (origin) VALUES (?)').run(o);
      } catch {
        console.warn(`[federation] ignoring invalid seed ${seed}`);
      }
    }
    const tick = () => void this.syncOnce().catch((e) => console.warn('[federation] sync failed:', (e as Error).message));
    setTimeout(tick, 1_000).unref?.();
    this.timer = setInterval(tick, this.fed.sync_interval_s * 1000);
    this.timer.unref?.();
    this.outboxTimer = setInterval(() => void this.flushOutbox(), 5_000);
    this.outboxTimer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    this.timer = this.outboxTimer = null;
  }

  /* ───────────── records ───────────── */

  private signRecord(r: Omit<DirRecord, 'sig'>): DirRecord {
    return { ...r, sig: sign(this.key, canonical({ key: r.key, kind: r.kind, host: r.host, data: r.data, ts: r.ts, deleted: r.deleted })) };
  }

  /**
   * Writes (or tombstones) one of this host's own records. `ts` is the record version; for
   * usernames, `data.claimed_at` is when the name was claimed and decides competing claims.
   */
  publish(kind: RecordKind, id: string, data: Record<string, unknown>, deleted = false) {
    const key = kind === 'user' ? `user:${id}` : kind === 'host' ? `host:${this.origin}` : `${kind}:${this.origin}|${id}`;
    const existing = this.getRecord(key);
    // Usernames are first-come: never overwrite another host's live claim.
    if (existing && existing.host !== this.origin && !existing.deleted) return false;
    const payload = kind === 'user'
      ? { ...data, claimed_at: existing && existing.host === this.origin && !existing.deleted ? existing.data.claimed_at ?? existing.ts : Date.now() }
      : data;
    const ts = Math.max(Date.now(), (existing?.ts ?? 0) + 1);
    this.store(this.signRecord({ key, kind, host: this.origin, data: payload, ts, deleted }));
    return true;
  }

  private publishHost() {
    this.publish('host', this.origin, {
      name: this.config.instance.name,
      description: this.config.instance.description,
      pubkey: this.key.publicKey,
      help_host: this.fed.help_host,
      registration: this.config.registration.mode,
      version: 1,
    });
  }

  private store(r: DirRecord) {
    this.db
      .prepare(
        `INSERT INTO federation_records (key, kind, host, data, ts, deleted, sig, received_at) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, host = excluded.host, data = excluded.data, ts = excluded.ts,
           deleted = excluded.deleted, sig = excluded.sig, received_at = excluded.received_at`,
      )
      .run(r.key, r.kind, r.host, JSON.stringify(r.data), r.ts, +r.deleted, r.sig, this.nextReceived());
  }

  private lastReceived = 0;
  /** Strictly increasing local sequence used as the sync cursor peers send back. */
  private nextReceived() {
    const max = (this.db.prepare('SELECT MAX(received_at) AS m FROM federation_records').get() as { m: number | null }).m ?? 0;
    this.lastReceived = Math.max(Date.now(), max + 1, this.lastReceived + 1);
    return this.lastReceived;
  }

  getRecord(key: string): DirRecord | null {
    const r = this.db.prepare('SELECT * FROM federation_records WHERE key = ?').get(key) as any;
    return r ? this.rowToRecord(r) : null;
  }

  private rowToRecord(r: any): DirRecord {
    return { key: r.key, kind: r.kind, host: r.host, data: JSON.parse(r.data), ts: r.ts, deleted: !!r.deleted, sig: r.sig };
  }

  /** Records changed after a cursor, for peers syncing from us. */
  recordsSince(since: number, limit = 500): { records: DirRecord[]; cursor: number } {
    const rows = this.db.prepare('SELECT * FROM federation_records WHERE received_at > ? ORDER BY received_at LIMIT ?').all(since, limit) as any[];
    return { records: rows.map((r) => this.rowToRecord(r)), cursor: rows.length ? rows[rows.length - 1].received_at : since };
  }

  list(kind: RecordKind, opts: { q?: string; limit?: number; offset?: number } = {}): DirRecord[] {
    const args: unknown[] = [kind];
    let where = 'kind = ? AND deleted = 0';
    if (opts.q) {
      where += ' AND data LIKE ?';
      args.push(`%${opts.q.replace(/[%_]/g, '')}%`);
    }
    const rows = this.db.prepare(`SELECT * FROM federation_records WHERE ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...args, opts.limit ?? 100, opts.offset ?? 0) as any[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /** Validates a record from a peer and merges it. Returns whether it was accepted. */
  async ingest(r: DirRecord): Promise<boolean> {
    if (!r || typeof r.key !== 'string' || typeof r.host !== 'string' || typeof r.sig !== 'string' || typeof r.ts !== 'number') return false;
    if (!['host', 'user', 'guild', 'item', 'theme'].includes(r.kind)) return false;
    let host: string;
    try {
      host = toOrigin(r.host);
    } catch {
      return false;
    }
    if (host !== r.host) return false;
    if (r.host === this.origin) return false; // we are the authority for our own records
    if (r.ts > Date.now() + SKEW_MS) return false;
    // Keys of host/guild/item records embed the author, so nobody can write another host's records.
    if (r.kind === 'host' && r.key !== `host:${r.host}`) return false;
    if ((r.kind === 'guild' || r.kind === 'item' || r.kind === 'theme') && !r.key.startsWith(`${r.kind}:${r.host}|`)) return false;
    // Directory records are small summaries; content (assets, theme code) is fetched from the host.
    if (JSON.stringify(r.data ?? {}).length > 8192) return false;
    if (r.kind === 'user' && !/^user:[a-z0-9_.]{3,32}$/.test(r.key)) return false;

    const pubkey = r.kind === 'host' ? (r.data?.pubkey as string) : await this.hostKey(r.host);
    if (!pubkey) return false;
    if (r.kind === 'host') {
      // Pin the first key we see for a host; a different key needs an admin to reset the pin.
      const pinned = this.pinnedKey(r.host);
      if (pinned && pinned !== pubkey) return false;
    }
    const msg = canonical({ key: r.key, kind: r.kind, host: r.host, data: r.data, ts: r.ts, deleted: r.deleted });
    if (!verify(pubkey, msg, r.sig)) return false;

    const existing = this.getRecord(r.key);
    if (existing) {
      if (existing.host !== r.host) {
        // Competing username claims: the earliest claim wins (ties broken by origin), unless the
        // earlier claim was released.
        if (r.kind !== 'user') return false;
        const claim = (x: DirRecord) => Number(x.data?.claimed_at ?? x.ts);
        const existingWins = !existing.deleted && (claim(existing) < claim(r) || (claim(existing) === claim(r) && existing.host < r.host));
        if (existingWins) return false;
      } else if (r.ts <= existing.ts) return false;
    }
    if (r.kind === 'host') {
      this.pinKey(r.host, pubkey);
      if (r.data?.help_host) this.db.prepare('INSERT OR IGNORE INTO federation_peers (origin) VALUES (?)').run(r.host);
    }
    this.store(r);
    return true;
  }

  /* ───────────── host keys ───────────── */

  private pinnedKey(origin: string): string | null {
    if (this.keyCache.has(origin)) return this.keyCache.get(origin)!;
    const row = this.db.prepare('SELECT pubkey FROM federation_peers WHERE origin = ?').get(origin) as { pubkey: string | null } | undefined;
    if (row?.pubkey) this.keyCache.set(origin, row.pubkey);
    return row?.pubkey ?? null;
  }

  private pinKey(origin: string, pubkey: string) {
    this.db.prepare('INSERT INTO federation_peers (origin, pubkey) VALUES (?,?) ON CONFLICT(origin) DO UPDATE SET pubkey = COALESCE(federation_peers.pubkey, excluded.pubkey)').run(origin, pubkey);
    this.keyCache.set(origin, this.pinnedKey(origin) ?? pubkey);
  }

  /** A host's public key: pinned, from its directory record, or fetched from the host itself (then pinned). */
  async hostKey(origin: string): Promise<string | null> {
    if (origin === this.origin) return this.key.publicKey;
    const pinned = this.pinnedKey(origin);
    if (pinned) return pinned;
    try {
      const res = await this.getJson(`${origin}/api/v1/federation/key`);
      if (res?.origin === origin && typeof res.pubkey === 'string') {
        this.pinKey(origin, res.pubkey);
        return this.pinnedKey(origin);
      }
    } catch {
      /* unreachable */
    }
    return null;
  }

  /** Forget a host's pinned key (admin action after a legitimate key rotation). */
  resetPin(origin: string) {
    this.db.prepare('UPDATE federation_peers SET pubkey = NULL WHERE origin = ?').run(origin);
    this.keyCache.delete(origin);
  }

  /* ───────────── gossip ───────────── */

  private peers(): string[] {
    const rows = this.db.prepare('SELECT origin FROM federation_peers WHERE origin != ? AND failures < 20 ORDER BY RANDOM() LIMIT 3').all(this.origin) as { origin: string }[];
    return rows.map((r) => r.origin);
  }

  async syncOnce(): Promise<number> {
    this.publishHost();
    let accepted = 0;
    for (const peer of this.peers()) {
      const cursorRow = this.db.prepare('SELECT cursor FROM federation_peers WHERE origin = ?').get(peer) as { cursor: number } | undefined;
      let cursor = cursorRow?.cursor ?? 0;
      try {
        for (let page = 0; page < 20; page++) {
          const res = await this.getJson(`${peer}/api/v1/federation/records?since=${cursor}`);
          if (!res || !Array.isArray(res.records)) break;
          // Host records first, so the keys for the rest are known.
          const sorted = [...res.records].sort((a: DirRecord, b: DirRecord) => +(b.kind === 'host') - +(a.kind === 'host'));
          for (const r of sorted) if (await this.ingest(r)) accepted++;
          if (typeof res.cursor !== 'number' || res.cursor <= cursor) break;
          cursor = res.cursor;
          if (res.records.length < 500) break;
        }
        this.db.prepare('UPDATE federation_peers SET cursor = ?, last_ok = ?, failures = 0 WHERE origin = ?').run(cursor, Date.now(), peer);
      } catch {
        this.db.prepare('UPDATE federation_peers SET failures = failures + 1 WHERE origin = ?').run(peer);
      }
    }
    return accepted;
  }

  /* ───────────── usernames ───────────── */

  /** Host that holds a username globally (null = free). Asks a few peers live so fresh claims count. */
  async usernameOwner(username: string): Promise<string | null> {
    const local = this.getRecord(`user:${username}`);
    if (local && !local.deleted) return local.host;
    await Promise.all(
      this.peers().map(async (p) => {
        try {
          const r = await this.getJson(`${p}/api/v1/federation/records/user:${encodeURIComponent(username)}`);
          if (r?.key) await this.ingest(r);
        } catch {
          /* offline peer */
        }
      }),
    );
    const fresh = this.getRecord(`user:${username}`);
    return fresh && !fresh.deleted ? fresh.host : null;
  }

  async usernameAvailable(username: string, _exceptUserId?: string): Promise<boolean> {
    const owner = await this.usernameOwner(username);
    return !owner || owner === this.origin;
  }

  /* ───────────── server-to-server requests ───────────── */

  /** GET JSON from another host (null on non-2xx). */
  async getJson(url: string): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetcher(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  /** Signs and sends a request to another host's federation API. */
  async request(origin: string, path: string, body: unknown): Promise<any> {
    const text = JSON.stringify(body ?? {});
    const date = String(Date.now());
    const sig = sign(this.key, `POST\n${path}\n${date}\n${sha256b64(text)}`);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS * 2);
    try {
      const res = await this.fetcher(`${origin}${path}`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-opencord-host': this.origin, 'x-opencord-date': date, 'x-opencord-signature': sig },
        body: text,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  /** Checks a signed request from another host. Returns the sender's origin or null. */
  async verifyRequest(headers: Record<string, unknown>, path: string, rawBody: string): Promise<string | null> {
    const host = headers['x-opencord-host'];
    const date = headers['x-opencord-date'];
    const sig = headers['x-opencord-signature'];
    if (typeof host !== 'string' || typeof date !== 'string' || typeof sig !== 'string') return null;
    if (Math.abs(Date.now() - Number(date)) > SKEW_MS) return null;
    let origin: string;
    try {
      origin = toOrigin(host);
    } catch {
      return null;
    }
    const key = await this.hostKey(origin);
    if (!key) return null;
    return verify(key, `POST\n${path}\n${date}\n${sha256b64(rawBody)}`, sig) ? origin : null;
  }

  async handleInbox(from: string, event: any) {
    return this.inbox(from, event);
  }

  /* ───────────── outbox (reliable delivery with retries) ───────────── */

  enqueue(target: string, event: Record<string, unknown>) {
    this.db.prepare('INSERT INTO federation_outbox (target, body, attempts, next_at, created_at) VALUES (?,?,0,?,?)').run(target, JSON.stringify(event), Date.now(), Date.now());
    void this.flushOutbox();
  }

  private flushing: Promise<void> | null = null;
  /** Delivers due outbox jobs. Concurrent callers wait for the running pass, then run another. */
  async flushOutbox(): Promise<void> {
    while (this.flushing) await this.flushing;
    this.flushing = this.deliverDue().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async deliverDue() {
    const due = this.db.prepare('SELECT * FROM federation_outbox WHERE next_at <= ? ORDER BY id LIMIT 50').all(Date.now()) as any[];
    for (const job of due) {
      try {
        await this.request(job.target, '/api/v1/federation/inbox', JSON.parse(job.body));
        this.db.prepare('DELETE FROM federation_outbox WHERE id = ?').run(job.id);
      } catch {
        const attempts = job.attempts + 1;
        // Give up after ~2 days of exponential backoff (capped at 1h between tries).
        if (attempts > 60) this.db.prepare('DELETE FROM federation_outbox WHERE id = ?').run(job.id);
        else this.db.prepare('UPDATE federation_outbox SET attempts = ?, next_at = ? WHERE id = ?').run(attempts, Date.now() + Math.min(3600_000, 2 ** attempts * 1000), job.id);
      }
    }
  }

  /* ───────────── cross-host sign-in ───────────── */

  /** Short-lived assertion that `user` (on this host) is signing in to `audience`. */
  issueAssertion(user: { id: string; username: string; display_name: string | null; avatar: string | null }, audience: string): string {
    return signToken(this.key, {
      iss: this.origin,
      aud: toOrigin(audience),
      sub: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar: user.avatar ? new URL(user.avatar.replace(/#.*$/, ''), this.origin).href + (user.avatar.match(/#.*$/)?.[0] ?? '') : null,
      exp: Date.now() + 120_000,
    });
  }

  /** Verifies an assertion addressed to this host. */
  async checkAssertion(token: string): Promise<{ iss: string; sub: string; username: string; display_name: string | null; avatar: string | null } | null> {
    const t = readToken(token);
    if (!t) return null;
    const p = t.payload;
    if (typeof p?.iss !== 'string' || p.aud !== this.origin || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    if (typeof p.sub !== 'string' || typeof p.username !== 'string' || !/^[a-z0-9_.]{2,32}$/.test(p.username)) return null;
    let iss: string;
    try {
      iss = toOrigin(p.iss);
    } catch {
      return null;
    }
    if (iss !== p.iss || iss === this.origin) return null;
    const key = await this.hostKey(iss);
    if (!key || !verify(key, t.body, t.signature)) return null;
    return { iss, sub: p.sub, username: p.username, display_name: p.display_name ?? null, avatar: typeof p.avatar === 'string' && /^https?:\/\//.test(p.avatar) ? p.avatar : null };
  }

  /** Fetches a user's public profile from their home host. */
  async lookupRemoteUser(origin: string, username: string): Promise<{ id: string; username: string; display_name: string | null; avatar: string | null } | null> {
    try {
      const r = await this.getJson(`${origin}/api/v1/federation/users/${encodeURIComponent(username)}`);
      return r && typeof r.id === 'string' ? r : null;
    } catch {
      return null;
    }
  }
}
