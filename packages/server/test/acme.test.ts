import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { CertManager, createCsr, identifierFor } from '../src/acme';
import { mockCa } from './acme-mock';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe('automatic HTTPS (ACME)', () => {
  it('gets a short-lived certificate for a bare IP address and serves http-01 + redirects', async () => {
    const ca = await mockCa();
    cleanup.push(ca.close);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-data-'));
    const logs: string[] = [];
    const certs = new CertManager({ dataDir, publicUrl: 'https://127.0.0.1', email: 'admin@example.com', directory: ca.directory, httpPort: 0, host: '127.0.0.1', log: (m) => logs.push(m) });
    cleanup.push(() => certs.close());
    await certs.listen();
    ca.state.httpPort = certs.httpPort;

    expect(certs.needsRenewal()).toBe(true);
    await certs.ensure();

    const order = ca.state.orders[0];
    expect(order.identifiers).toEqual([{ type: 'ip', value: '127.0.0.1' }]);
    expect(order.profile).toBe('shortlived');
    expect(ca.state.badNonceOnce).toBe(false); // the client retried after badNonce
    const cert = new crypto.X509Certificate(fs.readFileSync(certs.files.cert));
    expect(cert.subjectAltName).toBe('IP Address:127.0.0.1');
    // The key and certificate belong together and load into a TLS server.
    expect(() => tls.createSecureContext({ cert: fs.readFileSync(certs.files.cert), key: fs.readFileSync(certs.files.key) })).not.toThrow();
    expect(certs.needsRenewal()).toBe(false);
    expect((fs.statSync(certs.files.key).mode & 0o077) === 0).toBe(true);

    // A second start reuses the stored certificate instead of asking the CA again.
    await certs.ensure();
    expect(ca.state.orders).toHaveLength(1);

    // Plain HTTP redirects to HTTPS on the public address.
    const res = await fetch(`http://127.0.0.1:${certs.httpPort}/invite/abc?x=1`, { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://127.0.0.1/invite/abc?x=1');
  });

  it('builds CSRs that openssl reads, for IPv6 and domain names', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-csr-'));
    const text = (id: ReturnType<typeof identifierFor>) => {
      const f = path.join(dir, `${id.value.replace(/\W/g, '_')}.der`);
      fs.writeFileSync(f, createCsr(privateKey, id));
      return execFileSync('openssl', ['req', '-inform', 'DER', '-in', f, '-verify', '-noout', '-text'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    };
    expect(identifierFor('https://[2001:db8::1]:8443')).toEqual({ type: 'ip', value: '2001:db8::1' });
    expect(text(identifierFor('https://[2001:db8::1]'))).toContain('IP Address:2001:DB8:0:0:0:0:0:1');
    expect(identifierFor('https://Chat.Example.com')).toEqual({ type: 'dns', value: 'chat.example.com' });
    expect(text(identifierFor('https://chat.example.com'))).toContain('DNS:chat.example.com');
  });
});
