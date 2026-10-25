// Host identity for the global OpenCord network. Every host has an Ed25519 key pair; directory
// records, server-to-server requests and login assertions are signed with it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface HostKey {
  privateKey: crypto.KeyObject;
  /** Base64 of the raw 32-byte public key (what other hosts pin). */
  publicKey: string;
}

export function loadOrCreateHostKey(dataDir: string): HostKey {
  const file = path.join(dataDir, 'host-key.pem');
  let privateKey: crypto.KeyObject;
  if (fs.existsSync(file)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(file));
  } else {
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  // The raw key is the last 32 bytes of the SPKI encoding.
  return { privateKey, publicKey: spki.subarray(spki.length - 32).toString('base64') };
}

function publicKeyObject(raw: string): crypto.KeyObject {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({ key: Buffer.concat([prefix, Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' });
}

/** JSON with sorted keys, so signer and verifier serialise identically. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

export function sign(key: HostKey, message: string): string {
  return crypto.sign(null, Buffer.from(message), key.privateKey).toString('base64');
}

export function verify(publicKey: string, message: string, signature: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(message), publicKeyObject(publicKey), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export const sha256b64 = (s: string) => crypto.createHash('sha256').update(s).digest('base64');

/** Compact signed token (header-less): base64url(payload).base64url(signature). */
export function signToken(key: HostKey, payload: Record<string, unknown>): string {
  const body = Buffer.from(canonical(payload)).toString('base64url');
  return `${body}.${Buffer.from(sign(key, body), 'base64').toString('base64url')}`;
}

export function readToken(token: string): { body: string; payload: any; signature: string } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    return { body, payload: JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), signature: Buffer.from(sig, 'base64url').toString('base64') };
  } catch {
    return null;
  }
}
