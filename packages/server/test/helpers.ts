import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openMemoryDatabase } from '../src/db';

/**
 * In-process "network" for multi-host tests: hosts register by origin and their outgoing
 * federation requests are routed to each other's Fastify instance with inject().
 */
export function makeNetwork() {
  const hosts = new Map<string, Awaited<ReturnType<typeof makeServer>>['app']>();
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const app = hosts.get(url.origin);
    if (!app) throw new Error(`host unreachable: ${url.origin}`);
    const res = await app.inject({
      method: (init.method ?? 'GET') as any,
      url: url.pathname + url.search,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      payload: init.body as string | undefined,
    });
    return { ok: res.statusCode < 400, status: res.statusCode, json: async () => (res.body ? JSON.parse(res.body) : null) } as Response;
  }) as typeof fetch;
  return {
    fetch: fetcher,
    async host(origin: string, overrides: (c: ReturnType<typeof loadConfig>) => void = () => {}) {
      const s = await makeServer((c) => {
        c.server.public_url = origin;
        c.federation.enabled = true;
        c.federation.sync_interval_s = 3600; // tests drive syncOnce() by hand
        overrides(c);
      }, { fetch: fetcher });
      hosts.set(origin, s.app);
      return s;
    },
  };
}

export async function makeServer(overrides: (c: ReturnType<typeof loadConfig>) => void = () => {}, opts: { fetch?: typeof fetch } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencord-test-'));
  const config = loadConfig(path.join(dir, 'config.toml'));
  config.embeds.enabled = false;
  config.federation.enabled = false;
  config.updates.check = false;
  overrides(config);
  const db = openMemoryDatabase();
  const { app, ctx } = await buildApp(config, db, { logger: false, fetch: opts.fetch });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port as number;

  async function api(method: string, url: string, token?: string, body?: unknown) {
    const res = await app.inject({
      method: method as any,
      url: `/api/v1${url}`,
      headers: token ? { authorization: token } : {},
      payload: body as any,
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  let n = 0;
  async function user(name?: string) {
    const username = name ?? `user${++n}`;
    const r = await api('POST', '/auth/register', undefined, { email: `${username}@test.dev`, username, password: 'sturdy-pass-42' });
    if (!r.body.token) throw new Error(JSON.stringify(r.body));
    const me = await api('GET', '/users/@me', r.body.token);
    return { token: r.body.token as string, id: me.body.id as string, username };
  }

  function gateway(token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`);
    const events: { t: string; d: any }[] = [];
    const waiters: { t: string; pred: (d: any) => boolean; resolve: (d: any) => void }[] = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.op === 10) ws.send(JSON.stringify({ op: 2, d: { token } }));
      if (msg.op === 0) {
        events.push({ t: msg.t, d: msg.d });
        for (const w of [...waiters]) {
          if (w.t === msg.t && w.pred(msg.d)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(msg.d);
          }
        }
      }
    });
    return {
      ws,
      events,
      wait(t: string, pred: (d: any) => boolean = () => true, timeout = 3000): Promise<any> {
        const found = events.find((e) => e.t === t && pred(e.d));
        if (found) return Promise.resolve(found.d);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeout);
          waiters.push({ t, pred, resolve: (d) => (clearTimeout(timer), resolve(d)) });
        });
      },
      send(op: number, d: unknown) {
        ws.send(JSON.stringify({ op, d }));
      },
      close: () => ws.close(),
    };
  }

  return { app, ctx, config, api, user, gateway, close: () => app.close() };
}
