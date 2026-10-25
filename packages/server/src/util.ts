import crypto from 'node:crypto';

const EPOCH = 1767225600000n; // 2026-01-01T00:00:00Z
let lastTs = 0n;
let seq = 0n;

export function snowflake(): string {
  let ts = BigInt(Date.now()) - EPOCH;
  if (ts === lastTs) {
    seq = (seq + 1n) & 0xfffn;
    if (seq === 0n) ts += 1n;
  } else {
    seq = 0n;
  }
  lastTs = ts;
  return ((ts << 22n) | (1n << 17n) | seq).toString();
}

export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + EPOCH);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(8)) out += alphabet[b % alphabet.length];
  return out;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 0, public errors?: Record<string, string>) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new ApiError(404, `Unknown ${what}`);
export const forbidden = (msg = 'Missing Permissions') => new ApiError(403, msg, 50013);
export const badRequest = (msg: string, errors?: Record<string, string>) => new ApiError(400, msg, 50035, errors);

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
