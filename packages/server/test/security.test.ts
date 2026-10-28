import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Permissions as P, hasPermission } from '@opencord/shared';
import { makeServer } from './helpers';

let server: Awaited<ReturnType<typeof makeServer>>;
afterEach(async () => {
  await server?.close();
});

/** A guild with an owner and a member holding a "Mod" role with the given permissions. */
async function guildWithMod(perms: bigint) {
  server = await makeServer();
  const owner = await server.user('owner');
  const mod = await server.user('moddy');
  const g = (await server.api('POST', '/guilds', owner.token, { name: 'Guild' })).body;
  const full = (await server.api('GET', `/guilds/${g.id}`, owner.token)).body;
  const text = full.channels.find((c: any) => c.type === 0).id as string;
  const voiceCh = full.channels.find((c: any) => c.type === 2).id as string;
  const inv = (await server.api('POST', `/channels/${text}/invites`, owner.token, {})).body.code;
  await server.api('POST', `/invites/${inv}`, mod.token, {});
  const role = (await server.api('POST', `/guilds/${g.id}/roles`, owner.token, { name: 'Mod', permissions: perms.toString() })).body;
  await server.api('PATCH', `/guilds/${g.id}/members/${mod.id}`, owner.token, { roles: [role.id] });
  return { owner, mod, guildId: g.id as string, text, voiceCh };
}

describe('channel permission overwrites', () => {
  it("can't grant Administrator or permissions the editor lacks", async () => {
    const { mod, text } = await guildWithMod(P.MANAGE_ROLES | P.MANAGE_CHANNELS | P.VIEW_CHANNEL | P.SEND_MESSAGES);
    const put = (allow: bigint) => server.api('PUT', `/channels/${text}/permissions/${mod.id}`, mod.token, { type: 1, allow: allow.toString(), deny: '0' });
    expect((await put(P.ADMINISTRATOR)).status).toBe(403);
    expect((await put(P.MANAGE_MESSAGES)).status).toBe(403);
    expect((await put(P.SEND_MESSAGES)).status).toBe(200);
    expect((await server.api('PUT', `/channels/${text}/permissions/${mod.id}`, mod.token, { type: 1, allow: 'lots', deny: '0' })).status).toBe(400);
  });

  it('ignores an Administrator bit already stored in an overwrite', async () => {
    const { mod, text } = await guildWithMod(P.VIEW_CHANNEL | P.SEND_MESSAGES);
    server.ctx.db.prepare('UPDATE channels SET overwrites = ? WHERE id = ?').run(JSON.stringify([{ id: mod.id, type: 1, allow: P.ADMINISTRATOR.toString(), deny: '0' }]), text);
    expect(hasPermission(server.ctx.store.channelPermissions(text, mod.id), P.MANAGE_MESSAGES)).toBe(false);
  });

  it('keeps categories within their guild', async () => {
    const { owner, guildId, text } = await guildWithMod(0n);
    const other = (await server.api('POST', '/guilds', owner.token, { name: 'Other' })).body;
    const otherCat = (await server.api('GET', `/guilds/${other.id}`, owner.token)).body.channels.find((c: any) => c.type === 4).id;
    expect((await server.api('PATCH', `/channels/${text}`, owner.token, { parent_id: otherCat })).status).toBe(400);
    expect((await server.api('PATCH', `/guilds/${guildId}/channels`, owner.token, [{ id: text, position: 0, parent_id: otherCat }])).status).toBe(400);
  });
});

describe('message moderation stays in its channel', () => {
  it("bulk delete and reaction tools ignore other channels' messages", async () => {
    const { owner, mod, text } = await guildWithMod(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.MANAGE_MESSAGES);
    // A private guild the mod isn't in, with a message carrying a file.
    const priv = (await server.api('POST', '/guilds', owner.token, { name: 'Private' })).body;
    const privText = (await server.api('GET', `/guilds/${priv.id}`, owner.token)).body.channels.find((c: any) => c.type === 0).id;
    const port = (server.app.server.address() as any).port;
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: 'secret' }));
    form.append('files[0]', new Blob([Buffer.alloc(1000, 1)]), 'secret.bin');
    const secret = await (await fetch(`http://127.0.0.1:${port}/api/v1/channels/${privText}/messages`, { method: 'POST', headers: { authorization: owner.token }, body: form })).json();
    await server.api('PUT', `/channels/${privText}/messages/${secret.id}/reactions/${encodeURIComponent('🔥')}/@me`, owner.token, {});
    const file = path.join(server.ctx.files.root, secret.attachments[0].url.replace(/^\/uploads\//, ''));

    const mine = (await server.api('POST', `/channels/${text}/messages`, mod.token, { content: 'mine' })).body;
    const bulk = await server.api('POST', `/channels/${text}/messages/bulk-delete`, mod.token, { messages: [secret.id, mine.id] });
    expect(bulk.status).toBe(200);
    expect(server.ctx.store.messageRow(secret.id)).toBeTruthy();
    expect(fs.existsSync(file)).toBe(true);
    expect(server.ctx.store.messageRow(mine.id)).toBeFalsy();

    expect((await server.api('GET', `/channels/${text}/messages/${secret.id}/reactions/${encodeURIComponent('🔥')}`, mod.token)).status).toBe(404);
    expect((await server.api('DELETE', `/channels/${text}/messages/${secret.id}/reactions/${encodeURIComponent('🔥')}/${owner.id}`, mod.token)).status).toBe(404);
  });

  it("can't move a member into another guild's voice channel", async () => {
    const { owner, mod, guildId } = await guildWithMod(P.VIEW_CHANNEL | P.CONNECT | P.MOVE_MEMBERS);
    const other = (await server.api('POST', '/guilds', owner.token, { name: 'Other' })).body;
    const otherVoice = (await server.api('GET', `/guilds/${other.id}`, owner.token)).body.channels.find((c: any) => c.type === 2).id;
    const r = await server.api('PATCH', `/guilds/${guildId}/members/${owner.id}`, mod.token, { channel_id: otherVoice });
    expect(r.status).toBe(400);
  });
});

describe('auth rate limits', () => {
  it('slows down password guessing', async () => {
    server = await makeServer();
    await server.user('target');
    const tries: number[] = [];
    for (let i = 0; i < 12; i++) tries.push((await server.api('POST', '/auth/login', undefined, { login: 'target', password: `wrong-${i}` })).status);
    expect(tries.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(tries.at(-1)).toBe(429);
  });
});

describe('gateway', () => {
  it('ignores a second IDENTIFY on the same connection', async () => {
    server = await makeServer();
    const a = await server.user('first');
    const b = await server.user('second');
    const g = server.gateway(a.token);
    await g.wait('READY');
    g.send(2, { token: b.token });
    await new Promise((r) => setTimeout(r, 150));
    expect(g.events.filter((e) => e.t === 'READY')).toHaveLength(1);
    g.close();
  });

  it("doesn't show typing across a block", async () => {
    server = await makeServer();
    const a = await server.user('typer');
    const b = await server.user('watcher');
    await server.api('POST', '/users/@me/relationships', a.token, { username: 'watcher' });
    await server.api('PUT', `/users/@me/relationships/${a.id}`, b.token, {});
    const dm = (await server.api('POST', '/users/@me/channels', a.token, { recipient_id: b.id })).body;
    const gb = server.gateway(b.token);
    await gb.wait('READY');
    await server.api('PUT', `/users/@me/relationships/${a.id}`, b.token, { type: 2 });
    await server.api('POST', `/channels/${dm.id}/typing`, a.token, {});
    await new Promise((r) => setTimeout(r, 150));
    expect(gb.events.filter((e) => e.t === 'TYPING_START')).toHaveLength(0);
    gb.close();
  });
});
