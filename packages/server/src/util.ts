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

/**
 * Counts attempts per key in a sliding window; `hit` throws a 429 once `max` is exceeded.
 * In memory, so limits reset on restart (fine for slowing down guessing and spam).
 */
export function rateLimiter(max: number, windowMs: number, message = 'Too many attempts. Try again in a few minutes.') {
  const hits = new Map<string, number[]>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, t] of hits) if (!t.some((x) => now - x < windowMs)) hits.delete(k);
  }, windowMs);
  sweep.unref?.();
  return {
    hit(key: string) {
      const now = Date.now();
      const t = (hits.get(key) ?? []).filter((x) => now - x < windowMs);
      t.push(now);
      hits.set(key, t);
      if (t.length > max) throw new ApiError(429, message, 0);
    },
    reset(key: string) {
      hits.delete(key);
    },
  };
}
