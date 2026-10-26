// Automatic HTTPS: gets and renews a certificate from Let's Encrypt (or another ACME CA) for the
// host in [server].public_url, which may be a domain or a bare IP address. Let's Encrypt issues IP
// certificates only with its "shortlived" profile (about 6 days), so they are renewed every couple
// of days without a restart. Validation uses the http-01 challenge, so port 80 must reach
// [tls].http_port (RFC 8555; IP identifiers per RFC 8738).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export const LETSENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ───────────── minimal DER encoding for the CSR ───────────── */

function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a * 40 + b];
  for (const v of rest) {
    const chunk = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}
const seq = (...c: Buffer[]) => der(0x30, ...c);

function ipBytes(ip: string): Buffer {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  // Expand IPv6 (incl. "::" and an embedded IPv4 tail) to 16 bytes.
  let [head, tail] = ip.includes('::') ? ip.split('::') : [ip, ''];
  const parts = (s: string) => (s ? s.split(':') : []).flatMap((p) => (p.includes('.') ? [((+p.split('.')[0] << 8) | +p.split('.')[1]).toString(16), ((+p.split('.')[2] << 8) | +p.split('.')[3]).toString(16)] : [p]));
  const h = parts(head);
  const t = parts(tail);
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return Buffer.from(groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]));
}

/** PKCS#10 request with an empty subject and the identifier as the only subjectAltName. */
export function createCsr(key: crypto.KeyObject, identifier: Identifier): Buffer {
  const san = identifier.type === 'ip' ? der(0x87, ipBytes(identifier.value)) : der(0x82, Buffer.from(identifier.value, 'ascii'));
  const extensions = seq(seq(oid('2.5.29.17'), der(0x04, seq(san))));
  const info = seq(
    der(0x02, Buffer.from([0])), // version 0
    seq(), // empty subject: the name is in subjectAltName
    crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }) as Buffer,
    der(0xa0, seq(oid('1.2.840.113549.1.9.14'), der(0x31, extensions))), // extensionRequest
  );
  const sig = crypto.sign('sha256', info, { key, dsaEncoding: 'der' });
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), der(0x03, Buffer.from([0]), sig)); // ecdsa-with-SHA256
}

/* ───────────── ACME client ───────────── */

export interface Identifier {
  type: 'ip' | 'dns';
  value: string;
}

export function identifierFor(publicUrl: string): Identifier {
  const host = new URL(publicUrl).hostname.replace(/^\[|\]$/g, '');
  return net.isIP(host) ? { type: 'ip', value: host } : { type: 'dns', value: host.toLowerCase() };
}

class AcmeError extends Error {
  constructor(public type: string, message: string, public status: number) {
    super(message);
  }
}

class AcmeClient {
  private dir!: { newNonce: string; newAccount: string; newOrder: string; meta?: { profiles?: Record<string, string>; termsOfService?: string } };
  private nonce: string | null = null;
  private kid: string | null = null;
  private jwk: Record<string, string>;

  constructor(private directoryUrl: string, private accountKey: crypto.KeyObject, private fetcher: typeof fetch) {
    const j = accountKey.export({ format: 'jwk' }) as Record<string, string>;
    this.jwk = { crv: j.crv, kty: j.kty, x: j.x, y: j.y };
  }

  /** RFC 7638 thumbprint, used in the http-01 key authorization. */
  thumbprint() {
    const { crv, kty, x, y } = this.jwk;
    return b64u(crypto.createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest());
  }

  async init() {
    const res = await this.fetcher(this.directoryUrl);
    if (!res.ok) throw new Error(`ACME directory ${this.directoryUrl} returned ${res.status}`);
    this.dir = (await res.json()) as any;
  }

  get profiles() {
    return Object.keys(this.dir.meta?.profiles ?? {});
  }

  private async newNonce() {
    const res = await this.fetcher(this.dir.newNonce, { method: 'HEAD' });
    const n = res.headers.get('replay-nonce');
    if (!n) throw new Error('ACME server sent no nonce');
    return n;
  }

  /** Signed POST (payload undefined = POST-as-GET). Retries once on badNonce. */
  async post(url: string, payload?: unknown, accept?: string): Promise<{ res: Response; body: any }> {
    for (let attempt = 0; ; attempt++) {
      const nonce = this.nonce ?? (await this.newNonce());
      this.nonce = null;
      const header: Record<string, unknown> = { alg: 'ES256', nonce, url };
      if (this.kid) header.kid = this.kid;
      else header.jwk = this.jwk;
      const protectedB64 = b64u(JSON.stringify(header));
      const payloadB64 = payload === undefined ? '' : b64u(JSON.stringify(payload));
      const signature = b64u(crypto.sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`), { key: this.accountKey, dsaEncoding: 'ieee-p1363' }));
      const res = await this.fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/jose+json', ...(accept ? { accept } : {}) },
        body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature }),
      });
      this.nonce = res.headers.get('replay-nonce');
      const text = await res.text();
      const isJson = (res.headers.get('content-type') ?? '').includes('json');
      const body = isJson && text ? JSON.parse(text) : text;
      if (res.ok) return { res, body };
      const type = String(body?.type ?? '');
      if (type.endsWith(':badNonce') && attempt < 3) continue;
      throw new AcmeError(type, describe(body) || `ACME request failed (${res.status})`, res.status);
    }
  }

  async account(email: string) {
    const { res } = await this.post(this.dir.newAccount, { termsOfServiceAgreed: true, ...(email ? { contact: [`mailto:${email}`] } : {}) });
    this.kid = res.headers.get('location');
    if (!this.kid) throw new Error('ACME server sent no account URL');
  }

  newOrder(identifier: Identifier, profile?: string) {
    return this.post(this.dir.newOrder, { identifiers: [identifier], ...(profile ? { profile } : {}) });
  }

  /** Polls a URL (POST-as-GET) until its status leaves pending/processing. */
  async poll(url: string, timeoutMs = 90_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { res, body } = await this.post(url);
      if (!['pending', 'processing'].includes(body.status)) return body;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the ACME server (${body.status})`);
      const after = Number(res.headers.get('retry-after'));
      await sleep(Math.min(Math.max(Number.isFinite(after) && after > 0 ? after * 1000 : 1500, 500), 10_000));
    }
  }
}

function describe(problem: any): string {
  if (!problem || typeof problem !== 'object') return '';
  const sub = Array.isArray(problem.subproblems) ? problem.subproblems.map((s: any) => s.detail).filter(Boolean).join('; ') : '';
  return [problem.detail, sub].filter(Boolean).join(': ');
}

/* ───────────── certificate manager ───────────── */

export interface AcmeOptions {
  dataDir: string;
  publicUrl: string;
  email: string;
  directory: string;
  /** Port the http-01 responder (and the http → https redirect) listens on. */
  httpPort: number;
  host: string;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

export interface CertFiles {
  cert: string;
  key: string;
}

/**
 * Owns the certificate for the public address: serves http-01 challenges and redirects plain HTTP
 * to HTTPS, obtains a certificate before the HTTPS server starts, and renews it in the background.
 */
export class CertManager {
  readonly identifier: Identifier;
  readonly files: CertFiles;
  private dir: string;
  private challenges = new Map<string, string>();
  private server: http.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private log: (msg: string) => void;
  private fetcher: typeof fetch;

  constructor(private opts: AcmeOptions) {
    this.identifier = identifierFor(opts.publicUrl);
    this.dir = path.join(opts.dataDir, 'tls');
    fs.mkdirSync(this.dir, { recursive: true });
    this.files = { cert: path.join(this.dir, 'cert.pem'), key: path.join(this.dir, 'key.pem') };
    this.log = opts.log ?? ((m) => console.log(`[tls] ${m}`));
    this.fetcher = opts.fetch ?? fetch;
  }

  /** Port the plain-HTTP side is listening on (useful when `httpPort` is 0). */
  get httpPort() {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : this.opts.httpPort;
  }

  /** The plain-HTTP side: ACME challenges, and a redirect to HTTPS for everything else. */
  async listen() {
    const target = new URL(this.opts.publicUrl);
    this.server = http.createServer((req, res) => {
      const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '');
      if (m) {
        const auth = this.challenges.get(m[1]);
        res.writeHead(auth ? 200 : 404, { 'content-type': 'text/plain' });
        return res.end(auth ?? 'Not found');
      }
      res.writeHead(308, { location: `https://${target.host}${req.url ?? '/'}` });
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', (e: any) =>
        reject(e.code === 'EACCES' ? new Error(`No permission to listen on port ${this.opts.httpPort}. Run with CAP_NET_BIND_SERVICE, or set [tls].http_port to a high port and forward port 80 to it.`) : e),
      );
      this.server!.listen(this.opts.httpPort, this.opts.host, () => resolve());
    });
  }

  /** Days of validity left on the stored certificate, or null when there's no usable one. */
  current(): { notAfter: number; lifetime: number } | null {
    try {
      const pem = fs.readFileSync(this.files.cert, 'utf8');
      fs.accessSync(this.files.key);
      const c = new crypto.X509Certificate(pem);
      const san = c.subjectAltName ?? '';
      const want = this.identifier.type === 'ip' ? `IP Address:${this.identifier.value}` : `DNS:${this.identifier.value}`;
      if (!san.split(', ').some((s) => s.toLowerCase() === want.toLowerCase())) return null;
      const notAfter = Date.parse(c.validTo);
      return { notAfter, lifetime: notAfter - Date.parse(c.validFrom) };
    } catch {
      return null;
    }
  }

  /** Renew once less than a third of the lifetime is left (about 2 days for 6-day certificates). */
  needsRenewal() {
    const c = this.current();
    return !c || c.notAfter - Date.now() < c.lifetime / 3;
  }

  /** Obtains a fresh certificate and writes it to `files`. */
  async issue() {
    const accountFile = path.join(this.dir, 'account-key.pem');
    if (!fs.existsSync(accountFile)) {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      fs.writeFileSync(accountFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    const client = new AcmeClient(this.opts.directory, crypto.createPrivateKey(fs.readFileSync(accountFile)), this.fetcher);
    await client.init();
    await client.account(this.opts.email);
    // IP certificates are only issued as short-lived ones (Let's Encrypt: the "shortlived" profile).
    const profile = this.identifier.type === 'ip' && client.profiles.includes('shortlived') ? 'shortlived' : undefined;
    const { res, body: order } = await client.newOrder(this.identifier, profile);
    const orderUrl = res.headers.get('location')!;

    for (const authzUrl of order.authorizations as string[]) {
      const { body: authz } = await client.post(authzUrl);
      if (authz.status === 'valid') continue;
      const ch = (authz.challenges as any[]).find((c) => c.type === 'http-01');
      if (!ch) throw new Error('The ACME server offered no http-01 challenge');
      this.challenges.set(ch.token, `${ch.token}.${client.thumbprint()}`);
      try {
        await client.post(ch.url, {});
        const done = await client.poll(authzUrl);
        if (done.status !== 'valid') {
          const why = describe((done.challenges as any[]).find((c) => c.type === 'http-01')?.error) || done.status;
          throw new Error(`Validation failed: ${why}. Port 80 on ${this.identifier.value} must reach this server's port ${this.httpPort}.`);
        }
      } finally {
        this.challenges.delete(ch.token);
      }
    }

    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await client.post(order.finalize, { csr: b64u(createCsr(privateKey, this.identifier)) });
    const final = await client.poll(orderUrl);
    if (final.status !== 'valid') throw new Error(`The certificate order ended as "${final.status}"`);
    const { body: chain } = await client.post(final.certificate, undefined, 'application/pem-certificate-chain');

    // Key first, then the certificate, each atomically, so a crash never pairs a cert with the wrong key.
    const write = (file: string, data: string, mode?: number) => {
      fs.writeFileSync(file + '.tmp', data, mode ? { mode } : undefined);
      fs.renameSync(file + '.tmp', file);
    };
    write(this.files.key, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 0o600);
    write(this.files.cert, String(chain));
    const c = this.current();
    this.log(`certificate for ${this.identifier.value} issued, valid until ${c ? new Date(c.notAfter).toISOString() : '?'}${profile ? ` (${profile})` : ''}`);
  }

  /** Makes sure a valid certificate exists, retrying with backoff (never returns without one). */
  async ensure() {
    if (!this.needsRenewal()) return;
    const usable = this.current() && this.current()!.notAfter > Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        this.log(`requesting a certificate for ${this.identifier.value} from ${new URL(this.opts.directory).host}…`);
        await this.issue();
        return;
      } catch (e) {
        this.log(`could not get a certificate: ${(e as Error).message}`);
        if (usable) return; // keep serving the current one; the renewal timer retries
        // Backoff keeps us well inside Let's Encrypt's failed-validation limits.
        const wait = [60, 120, 300, 600, 1800][Math.min(attempt, 4)];
        this.log(`retrying in ${wait / 60} minute(s)`);
        await sleep(wait * 1000);
      }
    }
  }

  /** Checks hourly and calls `onRenew` after a new certificate is written. */
  startRenewal(onRenew: (files: CertFiles) => void) {
    this.timer = setInterval(async () => {
      if (!this.needsRenewal()) return;
      try {
        await this.issue();
        onRenew(this.files);
      } catch (e) {
        this.log(`renewal failed (will retry): ${(e as Error).message}`);
      }
    }, 60 * 60_000);
    this.timer.unref?.();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
