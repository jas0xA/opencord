import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeServer } from './helpers';

const MB = 1024 * 1024;
const servers: Awaited<ReturnType<typeof makeServer>>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function setup() {
  const s = await makeServer();
  servers.push(s);
  const admin = await s.user('admin'); // first account is the instance admin
  const g = await s.api('POST', '/guilds', admin.token, { name: 'Media' });
  const channel = g.body.channels.find((c: any) => c.type === 0).id as string;
  const port = (s.app.server.address() as any).port as number;
  async function send(content: string, bytes = 0, name = 'file.bin') {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content }));
    if (bytes) form.append('files[0]', new Blob([Buffer.alloc(bytes, 7)]), name);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/channels/${channel}/messages`, { method: 'POST', headers: { authorization: admin.token }, body: form });
    return { status: res.status, body: await res.json() };
  }
  const onDisk = (url: string) => fs.existsSync(path.join(s.ctx.files.root, url.replace(/^\/uploads\//, '')));
  return { ...s, admin, guildId: g.body.id as string, channel, send, onDisk };
}

describe('uploads', () => {
  it('streams files to disk and applies an admin-set size limit without a restart', async () => {
    const s = await setup();
    const before = s.ctx.files.used;
    const ok = await s.send('here', 2 * MB);
    expect(ok.status).toBe(200);
    expect(ok.body.attachments[0].size).toBe(2 * MB);
    expect(s.onDisk(ok.body.attachments[0].url)).toBe(true);
    expect(s.ctx.files.used - before).toBe(2 * MB);

    expect((await s.api('PATCH', '/admin/settings', s.admin.token, { max_upload_mb: 1 })).status).toBe(200);
    expect(fs.readFileSync(s.config.configPath, 'utf8')).toMatch(/max_upload_mb = 1\b/);
    expect((await s.api('GET', '/instance')).body.max_upload_mb).toBe(1);
    const tooBig = await s.send('again', 2 * MB);
    expect(tooBig.status).toBe(413);
    // Nothing from the rejected upload is left behind.
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readdirSync(s.ctx.files.tmpDir)).toEqual([]);

    expect((await s.api('PATCH', '/admin/settings', s.admin.token, { max_upload_mb: 501 })).status).toBe(400);
  });

  it('only admins can see storage or change limits', async () => {
    const s = await setup();
    const other = await s.user('someone');
    expect((await s.api('GET', '/admin/storage', other.token)).status).toBe(403);
    expect((await s.api('PATCH', '/admin/settings', other.token, { max_storage_gb: 1 })).status).toBe(403);
    const st = await s.api('GET', '/admin/storage', s.admin.token);
    expect(st.body).toMatchObject({ limit: 0, max_upload_mb: 500, max_upload_mb_cap: 500, max_storage_gb: 0 });
    expect(st.body.total).toBe(st.body.files + st.body.database);
  });
});

describe('storage limit', () => {
  it('deletes the oldest media first, then old messages, and never accounts or servers', async () => {
    const s = await setup();
    const first = await s.send('keep my text', 1 * MB);
    const second = await s.send('', 1 * MB);
    const third = await s.send('newest', 1 * MB);
    for (const m of [first, second, third]) expect(m.status).toBe(200);

    // Room for about one more megabyte before the limit.
    const limit = s.ctx.storage.usage().total + 1.2 * MB;
    await s.api('PATCH', '/admin/settings', s.admin.token, { max_storage_gb: limit / 1024 ** 3 });
    expect(s.ctx.storage.usage().limit).toBeGreaterThan(0);

    const fourth = await s.send('incoming', 1 * MB);
    expect(fourth.status).toBe(200);
    // The oldest files went; the first message keeps its text, the file-only one is gone entirely.
    expect(s.onDisk(first.body.attachments[0].url)).toBe(false);
    expect(s.onDisk(second.body.attachments[0].url)).toBe(false);
    expect(s.onDisk(fourth.body.attachments[0].url)).toBe(true);
    const msgs = (await s.api('GET', `/channels/${s.channel}/messages`, s.admin.token)).body as any[];
    const kept = msgs.find((m) => m.id === first.body.id);
    expect(kept.content).toBe('keep my text');
    expect(kept.attachments).toEqual([]);
    expect(msgs.some((m) => m.id === second.body.id)).toBe(false);
    expect(s.ctx.storage.usage().total).toBeLessThanOrEqual(limit);

    // A limit below what accounts and servers need: messages go, then the server refuses.
    await s.api('PATCH', '/admin/settings', s.admin.token, { max_storage_gb: 0.000001 });
    const refused = await s.send('no room', 1024);
    expect(refused.status).toBe(507);
    expect(s.ctx.db.prepare('SELECT COUNT(*) AS c FROM messages').get()).toEqual({ c: 0 });
    expect((await s.api('GET', '/users/@me', s.admin.token)).status).toBe(200);
    const guild = await s.api('GET', `/guilds/${s.guildId}`, s.admin.token);
    expect(guild.status).toBe(200);
    expect(guild.body.channels.find((c: any) => c.id === s.channel).last_message_id).toBeNull();
  });
});
