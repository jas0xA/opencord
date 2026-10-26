import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * A small ACME CA (RFC 8555 subset) that checks what a real one checks: JWS signatures and
 * nonces, the http-01 response fetched from the client's port, and a CSR that openssl accepts.
 */
export async function mockCa() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-ca-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=Mock CA', '-days', '2',
    '-keyout', path.join(dir, 'ca.key'), '-out', path.join(dir, 'ca.pem')], { stdio: 'ignore' });
  const nonces = new Set<string>();
  const accounts = new Map<string, crypto.JsonWebKey>();
  const state = { badNonceOnce: true, orders: [] as any[], validations: 0, httpPort: 0 };
  let base = '';
  const nonce = () => {
    const n = crypto.randomBytes(12).toString('base64url');
    nonces.add(n);
    return n;
  };
  const thumb = (jwk: any) => b64u(crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'application/pem-certificate-chain' : 'application/json', 'replay-nonce': nonce(), ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const problem = (res: http.ServerResponse, status: number, type: string, detail: string) =>
    send(res, status, { type: `urn:ietf:params:acme:error:${type}`, detail }, { 'content-type': 'application/problem+json' });

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    if (url === '/dir') return send(res, 200, { newNonce: `${base}/nonce`, newAccount: `${base}/acct`, newOrder: `${base}/order`, meta: { profiles: { classic: '', shortlived: '' } } });
    if (url === '/nonce') return send(res, 200, {});
    let raw = '';
    for await (const c of req) raw += c;
    const jws = JSON.parse(raw);
    const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString());
    if (header.url !== `${base}${url}`) return problem(res, 400, 'malformed', 'url mismatch');
    if (!nonces.delete(header.nonce)) return problem(res, 400, 'badNonce', 'unknown nonce');
    if (state.badNonceOnce) {
      state.badNonceOnce = false;
      return problem(res, 400, 'badNonce', 'stale nonce (test)');
    }
    const jwk = header.jwk ?? accounts.get(header.kid);
    if (!jwk) return problem(res, 400, 'accountDoesNotExist', 'no account');
    const ok = crypto.verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(jws.signature, 'base64url'));
    if (!ok) return problem(res, 400, 'malformed', 'bad signature');
    const payload = jws.payload ? JSON.parse(Buffer.from(jws.payload, 'base64url').toString()) : undefined;

    if (url === '/acct') {
      accounts.set(`${base}/acct/1`, jwk);
      return send(res, 201, { status: 'valid' }, { location: `${base}/acct/1` });
    }
    if (url === '/order') {
      const order = { id: state.orders.length, identifiers: payload.identifiers, profile: payload.profile, status: 'pending', authz: 'pending', token: crypto.randomBytes(16).toString('base64url'), jwk, cert: '' };
      state.orders.push(order);
      return send(res, 201, { status: 'pending', authorizations: [`${base}/authz/${order.id}`], finalize: `${base}/finalize/${order.id}` }, { location: `${base}/orders/${order.id}` });
    }
    const m = /^\/(\w+)\/(\d+)$/.exec(url);
    const order = m && state.orders[Number(m[2])];
    if (!order) return problem(res, 404, 'malformed', 'not found');
    const challenge = { type: 'http-01', url: `${base}/chall/${order.id}`, token: order.token, status: order.authz };
    switch (m![1]) {
      case 'authz':
        return send(res, 200, { status: order.authz, identifier: order.identifiers[0], challenges: [challenge] });
      case 'chall': {
        send(res, 200, { ...challenge, status: 'processing' });
        state.validations++;
        // Like Let's Encrypt: fetch http://<identifier>:<port>/.well-known/acme-challenge/<token>.
        const got = await fetch(`http://${order.identifiers[0].value}:${state.httpPort}/.well-known/acme-challenge/${order.token}`).then((r) => r.text()).catch(() => '');
        order.authz = got === `${order.token}.${thumb(order.jwk)}` ? 'valid' : 'invalid';
        return;
      }
      case 'finalize': {
        if (order.authz !== 'valid') return problem(res, 403, 'orderNotReady', 'authorization not valid');
        const csr = path.join(dir, `csr-${order.id}.der`);
        fs.writeFileSync(csr, Buffer.from(payload.csr, 'base64url'));
        execFileSync('openssl', ['req', '-inform', 'DER', '-in', csr, '-verify', '-noout'], { stdio: 'ignore' }); // throws on a bad signature
        order.cert = execFileSync('openssl', ['x509', '-req', '-inform', 'DER', '-in', csr, '-CA', path.join(dir, 'ca.pem'), '-CAkey', path.join(dir, 'ca.key'),
          '-days', '6', '-copy_extensions', 'copy'], { encoding: 'utf8' }) + fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8');
        order.status = 'valid';
        return send(res, 200, { status: 'processing' });
      }
      case 'orders':
        return send(res, 200, { status: order.status, certificate: `${base}/cert/${order.id}` });
      case 'cert':
        return send(res, 200, order.cert);
    }
    return problem(res, 404, 'malformed', 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  return { directory: `${base}/dir`, state, close: () => server.close() };
}

