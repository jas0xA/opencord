import { afterEach, describe, expect, it } from 'vitest';
import { Permissions } from '@opencord/shared';
import { makeServer } from './helpers';

let server: Awaited<ReturnType<typeof makeServer>>;
afterEach(async () => server?.close());

describe('cors', () => {
  it('allows browser preflights for PATCH, PUT and DELETE', async () => {
    server = await makeServer();
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const res = await server.app.inject({
        method: 'OPTIONS',
        url: '/api/v1/guilds/1',
        headers: { origin: 'http://localhost:5173', 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type' },
      });
      expect(res.statusCode).toBe(204);
      expect(String(res.headers['access-control-allow-methods'])).toContain(method);
    }
  });
});

describe('registration modes', () => {
  it('first user becomes admin; closed mode blocks sign-up', async () => {
    server = await makeServer();
    const a = await server.user('admin');
    const me = await server.api('GET', '/users/@me', a.token);
    expect(me.body.admin).toBe(true);
    server.config.registration.mode = 'closed';
    const r = await server.api('POST', '/auth/register', undefined, { email: 'x@x.dev', username: 'xx', password: 'sturdy-pass-42' });
    expect(r.status).toBe(403);
  });

  it('allowlist mode only accepts listed emails, once', async () => {
    server = await makeServer((c) => (c.registration.mode = 'allowlist'));
    const reg = (email: string, username: string) =>
      server.api('POST', '/auth/register', undefined, { email, username, password: 'sturdy-pass-42' });
    expect((await reg('nope@x.dev', 'nope')).status).toBe(403);
    server.ctx.db.prepare('INSERT INTO allowlist (email, added_at) VALUES (?, ?)').run('ok@x.dev', Date.now());
    expect((await reg('OK@x.dev', 'okay')).body.token).toBeTruthy();
    // Entry is consumed.
    server.ctx.db.prepare('DELETE FROM users').run();
    expect((await reg('ok@x.dev', 'okay2')).status).toBe(403);
  });

  it('invite_only mode requires a valid invite and joins the guild', async () => {
    server = await makeServer();
    const owner = await server.user('owner');
    const g = await server.api('POST', '/guilds', owner.token, { name: 'Club' });
    const text = g.body.channels.find((c: any) => c.type === 0);
    const inv = await server.api('POST', `/channels/${text.id}/invites`, owner.token, {});
    server.config.registration.mode = 'invite_only';
    const bad = await server.api('POST', '/auth/register', undefined, { email: 'n@x.dev', username: 'newbie', password: 'sturdy-pass-42' });
    expect(bad.status).toBe(403);
    const ok = await server.api('POST', '/auth/register', undefined, { email: 'n@x.dev', username: 'newbie', password: 'sturdy-pass-42', invite: inv.body.code });
    expect(ok.body.token).toBeTruthy();
    expect(server.ctx.store.guildMemberIds(g.body.id)).toHaveLength(2);
  });

  it('rejects bad logins and accepts username or email', async () => {
    server = await makeServer();
    await server.user('bob');
    expect((await server.api('POST', '/auth/login', undefined, { login: 'bob', password: 'wrong' })).status).toBe(400);
    expect((await server.api('POST', '/auth/login', undefined, { login: 'bob@test.dev', password: 'sturdy-pass-42' })).body.token).toBeTruthy();
  });
});

describe('account rules', () => {
  it('enforces username length and a sensible password policy', async () => {
    server = await makeServer();
    const reg = (username: string, password: string) =>
      server.api('POST', '/auth/register', undefined, { email: `${username}@x.dev`, username, password });
    expect((await reg('ab', 'sturdy-pass-42')).body.errors.username).toMatch(/at least 3/);
    expect((await reg('abc', 'short1')).body.errors.password).toMatch(/at least 8/);
    expect((await reg('abc', 'lettersonly')).body.errors.password).toMatch(/letter and one number/);
    expect((await reg('abc', 'password1')).body.errors.password).toMatch(/too common/);
    expect((await reg('abc', 'sturdy-pass-42')).body.token).toBeTruthy();
    expect((await reg('abc', 'sturdy-pass-42')).body.errors.username).toMatch(/unavailable/);
  });

  it('lets one email own several accounts and log into the right one', async () => {
    server = await makeServer();
    const reg = (username: string, password: string) =>
      server.api('POST', '/auth/register', undefined, { email: 'shared@x.dev', username, password });
    expect((await reg('first', 'sturdy-pass-42')).body.token).toBeTruthy();
    expect((await reg('second', 'other-pass-77')).body.token).toBeTruthy();
    const login = (password: string, account_id?: string) => server.api('POST', '/auth/login', undefined, { login: 'shared@x.dev', password, account_id });
    // Distinct passwords pick the account unambiguously.
    const a = await login('other-pass-77');
    expect((await server.api('GET', '/users/@me', a.body.token)).body.username).toBe('second');
    // Same password on both: the client gets a list to choose from.
    expect((await reg('third', 'sturdy-pass-42')).body.token).toBeTruthy();
    const choose = await login('sturdy-pass-42');
    expect(choose.body.choose_account.map((u: any) => u.username)).toEqual(['first', 'third']);
    const picked = await login('sturdy-pass-42', choose.body.choose_account[1].id);
    expect((await server.api('GET', '/users/@me', picked.body.token)).body.username).toBe('third');
  });

  it('creates and lists sibling accounts from a signed-in account', async () => {
    server = await makeServer();
    const main = await server.user('mainacct');
    const bad = await server.api('POST', '/users/@me/siblings', main.token, { username: 'altacct', password: 'alt-pass-123', current_password: 'nope' });
    expect(bad.status).toBe(400);
    const r = await server.api('POST', '/users/@me/siblings', main.token, { username: 'altacct', password: 'alt-pass-123', current_password: 'sturdy-pass-42' });
    expect(r.body.user.username).toBe('altacct');
    const list = await server.api('GET', '/users/@me/siblings', r.body.token);
    expect(list.body.map((u: any) => u.username)).toEqual(['mainacct']);
  });
});

describe('friends and DMs', () => {
  it('request → accept → DM; blocking stops messages', async () => {
    server = await makeServer();
    const a = await server.user('alice');
    const b = await server.user('bob');
    await server.api('POST', '/users/@me/relationships', a.token, { username: 'bob' });
    let rels = await server.api('GET', '/users/@me/relationships', b.token);
    expect(rels.body[0].type).toBe(3); // incoming
    await server.api('PUT', `/users/@me/relationships/${a.id}`, b.token, {});
    rels = await server.api('GET', '/users/@me/relationships', a.token);
    expect(rels.body[0].type).toBe(1);
    // Accepting puts the DM in both users' lists straight away.
    const open = server.ctx.db
      .prepare('SELECT r.user_id FROM channel_recipients r JOIN channels c ON c.id = r.channel_id WHERE c.type = 1 AND r.closed = 0')
      .all()
      .map((r: any) => r.user_id);
    expect(open.sort()).toEqual([a.id, b.id].sort());

    const dm = await server.api('POST', '/users/@me/channels', a.token, { recipient_id: b.id });
    const sent = await server.api('POST', `/channels/${dm.body.id}/messages`, a.token, { content: 'hi bob' });
    expect(sent.status).toBe(200);
    const history = await server.api('GET', `/channels/${dm.body.id}/messages`, b.token);
    expect(history.body[0].content).toBe('hi bob');

    await server.api('PUT', `/users/@me/relationships/${a.id}`, b.token, { type: 2 });
    const blocked = await server.api('POST', `/channels/${dm.body.id}/messages`, a.token, { content: 'still there?' });
    expect(blocked.status).toBe(403);
  });

  it('strangers without a shared server cannot DM', async () => {
    server = await makeServer();
    const a = await server.user();
    const b = await server.user();
    const dm = await server.api('POST', '/users/@me/channels', a.token, { recipient_id: b.id });
    expect((await server.api('POST', `/channels/${dm.body.id}/messages`, a.token, { content: 'hey' })).status).toBe(403);
  });
});

describe('guilds, permissions and moderation', () => {
  async function setup() {
    server = await makeServer();
    const owner = await server.user('owner');
    const mod = await server.user('mod');
    const member = await server.user('member');
    const g = (await server.api('POST', '/guilds', owner.token, { name: 'Test Guild' })).body;
    const text = g.channels.find((c: any) => c.type === 0);
    const inv = (await server.api('POST', `/channels/${text.id}/invites`, owner.token, {})).body;
    await server.api('POST', `/invites/${inv.code}`, mod.token);
    await server.api('POST', `/invites/${inv.code}`, member.token);
    return { owner, mod, member, g, text, inv };
  }

  it('creates default channels and roles', async () => {
    const { g } = await setup();
    expect(g.channels.map((c: any) => c.name)).toEqual(expect.arrayContaining(['general', 'General', 'Text Channels', 'Voice Channels']));
    expect(g.roles[0].name).toBe('@everyone');
  });

  it('enforces role hierarchy for kicks and role grants', async () => {
    const { owner, mod, member, g } = await setup();
    // Members cannot kick.
    expect((await server.api('DELETE', `/guilds/${g.id}/members/${mod.id}`, member.token)).status).toBe(403);
    const role = (await server.api('POST', `/guilds/${g.id}/roles`, owner.token, {
      name: 'Moderator', permissions: (Permissions.KICK_MEMBERS | Permissions.MANAGE_ROLES | Permissions.BAN_MEMBERS).toString(),
    })).body;
    await server.api('PATCH', `/guilds/${g.id}/members/${mod.id}`, owner.token, { roles: [role.id] });
    // Mod cannot give out its own role (not below its highest).
    expect((await server.api('PATCH', `/guilds/${g.id}/members/${member.id}`, mod.token, { roles: [role.id] })).status).toBe(403);
    // Mod cannot kick the owner, but can kick a member.
    expect((await server.api('DELETE', `/guilds/${g.id}/members/${owner.id}`, mod.token)).status).toBe(403);
    expect((await server.api('DELETE', `/guilds/${g.id}/members/${member.id}`, mod.token)).status).toBe(200);
    // Audit log captured it.
    const log = await server.api('GET', `/guilds/${g.id}/audit-logs`, owner.token);
    expect(log.body.entries.map((e: any) => e.action)).toContain('MEMBER_KICK');
  });

  it('bans prevent rejoining; unban allows it', async () => {
    const { owner, member, g, inv } = await setup();
    await server.api('PUT', `/guilds/${g.id}/bans/${member.id}`, owner.token, { reason: 'spam' });
    expect(server.ctx.store.isMember(g.id, member.id)).toBe(false);
    expect((await server.api('POST', `/invites/${inv.code}`, member.token)).status).toBe(403);
    await server.api('DELETE', `/guilds/${g.id}/bans/${member.id}`, owner.token);
    expect((await server.api('POST', `/invites/${inv.code}`, member.token)).status).toBe(200);
  });

  it('timeouts block sending', async () => {
    const { owner, member, g, text } = await setup();
    await server.api('PATCH', `/guilds/${g.id}/members/${member.id}`, owner.token, { communication_disabled_until: Date.now() + 60_000 });
    const r = await server.api('POST', `/channels/${text.id}/messages`, member.token, { content: 'hello' });
    expect(r.status).toBe(403);
  });

  it('channel overwrites hide channels from @everyone', async () => {
    const { owner, member, g, text } = await setup();
    await server.api('PUT', `/channels/${text.id}/permissions/${g.id}`, owner.token, { type: 0, allow: '0', deny: Permissions.VIEW_CHANNEL.toString() });
    expect((await server.api('GET', `/channels/${text.id}/messages`, member.token)).status).toBe(404);
    expect((await server.api('GET', `/channels/${text.id}/messages`, owner.token)).status).toBe(200);
  });

  it('automod blocks keywords', async () => {
    const { owner, member, g, text } = await setup();
    await server.api('POST', `/guilds/${g.id}/auto-moderation/rules`, owner.token, {
      name: 'No bad words', trigger: 'keyword', keywords: ['badword'], actions: [{ type: 'block' }],
    });
    expect((await server.api('POST', `/channels/${text.id}/messages`, member.token, { content: 'this has a badword in it' })).status).toBe(400);
    expect((await server.api('POST', `/channels/${text.id}/messages`, member.token, { content: 'this is fine' })).status).toBe(200);
  });

  it('non-members cannot read guild channels', async () => {
    const { text } = await setup();
    const outsider = await server.user('outsider');
    expect((await server.api('GET', `/channels/${text.id}/messages`, outsider.token)).status).toBe(404);
  });

  it('server profile settings persist (banner preset, traits, description)', async () => {
    const { owner, member, g } = await setup();
    const r = await server.api('PATCH', `/guilds/${g.id}`, owner.token, {
      banner_preset: 3, description: 'hello', traits: [{ emoji: '🎮', label: 'Gaming' }],
    });
    expect(r.body.banner_preset).toBe(3);
    expect(r.body.traits[0].label).toBe('Gaming');
    expect((await server.api('PATCH', `/guilds/${g.id}`, member.token, { name: 'pwned' })).status).toBe(403);
  });
});

describe('marketplace', () => {
  it('claims and equips official items, publishes community items', async () => {
    server = await makeServer();
    const a = await server.user();
    const list = await server.api('GET', '/marketplace/items?tab=official&category=avatar_decoration', a.token);
    const item = list.body.items[0];
    expect((await server.api('PATCH', '/users/@me', a.token, { avatar_decoration: item.id })).status).toBe(400);
    await server.api('PUT', `/marketplace/items/${item.id}/claim`, a.token);
    const me = await server.api('PATCH', '/users/@me', a.token, { avatar_decoration: item.id });
    expect(me.body.avatar_decoration).toBe(item.id);

    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const created = await server.api('POST', '/marketplace/items', a.token, { category: 'avatar_decoration', name: 'My Deco', asset: png, tags: ['cool'] });
    expect(created.body.status).toBe('approved');
    const b = await server.user();
    const community = await server.api('GET', '/marketplace/items?tab=community', b.token);
    expect(community.body.items.map((i: any) => i.name)).toContain('My Deco');
  });

  it('equips marketplace banners only when owned', async () => {
    server = await makeServer();
    const a = await server.user();
    const banners = await server.api('GET', '/marketplace/items?tab=official&category=banner', a.token);
    const id = banners.body.items[0].id;
    expect((await server.api('PATCH', '/users/@me', a.token, { banner: `market:${id}` })).status).toBe(400);
    await server.api('PUT', `/marketplace/items/${id}/claim`, a.token);
    const me = await server.api('PATCH', '/users/@me', a.token, { banner: `market:${id}` });
    expect(me.body.banner).toBe(`market:${id}`);
    await server.api('DELETE', `/marketplace/items/${id}/claim`, a.token);
    expect((await server.api('GET', '/users/@me', a.token)).body.banner).toBeNull();
  });

  it('respects require_approval', async () => {
    server = await makeServer((c) => (c.marketplace.require_approval = true));
    const admin = await server.user();
    const a = await server.user();
    const created = await server.api('POST', '/marketplace/items', a.token, { category: 'profile_theme', name: 'Theme', colors: ['#112233', '#445566'] });
    expect(created.body.status).toBe('pending');
    expect((await server.api('GET', '/marketplace/items?tab=community', admin.token)).body.items).toHaveLength(0);
    await server.api('POST', `/admin/marketplace/items/${created.body.id}/status`, admin.token, { status: 'approved' });
    expect((await server.api('GET', '/marketplace/items?tab=community', admin.token)).body.items).toHaveLength(1);
  });
});

describe('gateway', () => {
  it('sends READY and dispatches messages and presence', async () => {
    server = await makeServer();
    const a = await server.user('alice');
    const b = await server.user('bob');
    await server.api('POST', '/users/@me/relationships', a.token, { username: 'bob' });
    await server.api('PUT', `/users/@me/relationships/${a.id}`, b.token, {});
    const ga = server.gateway(a.token);
    const ready = await ga.wait('READY');
    expect(ready.user.username).toBe('alice');
    expect(ready.relationships).toHaveLength(1);
    // Becoming friends opened the DM for both sides.
    expect(ready.private_channels).toHaveLength(1);

    const gb = server.gateway(b.token);
    await gb.wait('READY');
    const presence = await ga.wait('PRESENCE_UPDATE', (d) => d.user_id === b.id && d.status === 'online');
    expect(presence.status).toBe('online');

    const dm = await server.api('POST', '/users/@me/channels', a.token, { recipient_id: b.id });
    await server.api('POST', `/channels/${dm.body.id}/messages`, a.token, { content: 'live!' });
    const created = await gb.wait('MESSAGE_CREATE');
    expect(created.content).toBe('live!');
    ga.close();
    gb.close();
  });

  it('DM calls create a call message and relay signaling between participants', async () => {
    server = await makeServer();
    const a = await server.user('alice');
    const b = await server.user('bob');
    await server.api('POST', '/users/@me/relationships', a.token, { username: 'bob' });
    await server.api('PUT', `/users/@me/relationships/${a.id}`, b.token, {});
    const dm = (await server.api('POST', '/users/@me/channels', a.token, { recipient_id: b.id })).body;
    const ga = server.gateway(a.token);
    const gb = server.gateway(b.token);
    await ga.wait('READY');
    await gb.wait('READY');
    ga.send(4, { channel_id: dm.id });
    const call = await gb.wait('CALL_CREATE');
    expect(call.ringing).toEqual([b.id]);
    gb.send(4, { channel_id: dm.id });
    await ga.wait('VOICE_STATE_UPDATE', (d) => d.user_id === b.id && d.channel_id === dm.id);
    ga.send(20, { to: b.id, channel_id: dm.id, kind: 'offer', data: { sdp: 'x' } });
    const sig = await new Promise<any>((resolve) => gb.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.op === 20) resolve(m.d);
    }));
    expect(sig.from).toBe(a.id);
    ga.send(4, { channel_id: null });
    gb.send(4, { channel_id: null });
    const ended = await ga.wait('MESSAGE_UPDATE', (d) => d.call?.ended_at);
    expect(ended.type).toBe(3);
    ga.close();
    gb.close();
  });
});

describe('message reports', () => {
  it('lets members report, moderators see and resolve them', async () => {
    server = await makeServer();
    const owner = await server.user('owner');
    const member = await server.user('member');
    const g = (await server.api('POST', '/guilds', owner.token, { name: 'Reports' })).body;
    const text = g.channels.find((c: any) => c.type === 0);
    const inv = await server.api('POST', `/channels/${text.id}/invites`, owner.token, {});
    await server.api('POST', `/invites/${inv.body.code}`, member.token, {});
    const msg = await server.api('POST', `/channels/${text.id}/messages`, owner.token, { content: 'buy cheap stuff' });

    expect((await server.api('POST', `/channels/${text.id}/messages/${msg.body.id}/report`, owner.token, { reason: 'spam' })).status).toBe(400);
    expect((await server.api('POST', `/channels/${text.id}/messages/${msg.body.id}/report`, member.token, { reason: 'spam', details: 'ad' })).status).toBe(200);
    // Members without Manage Messages can't read the queue.
    expect((await server.api('GET', `/guilds/${g.id}/reports`, member.token)).status).toBe(403);

    const queue = await server.api('GET', `/guilds/${g.id}/reports`, owner.token);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].message.content).toBe('buy cheap stuff');
    await server.api('POST', `/reports/${queue.body[0].id}/resolve`, owner.token, { action: 'delete_message' });
    expect((await server.api('GET', `/guilds/${g.id}/reports`, owner.token)).body).toHaveLength(0);
    expect(server.ctx.store.messageRow(msg.body.id)).toBeFalsy();
  });
});
