import { afterEach, describe, expect, it } from 'vitest';
import { makeNetwork } from './helpers';

type Host = Awaited<ReturnType<ReturnType<typeof makeNetwork>['host']>>;
let hosts: Host[] = [];
afterEach(async () => {
  for (const h of hosts) await h.close();
  hosts = [];
});

async function twoHosts() {
  const net = makeNetwork();
  const a = await net.host('https://a.test', (c) => (c.federation.seeds = ['https://b.test']));
  const b = await net.host('https://b.test', (c) => (c.federation.seeds = ['https://a.test']));
  hosts.push(a, b);
  return { net, a, b };
}

const settle = async (...hs: Host[]) => {
  for (let i = 0; i < 3; i++) {
    for (const h of hs) {
      await h.ctx.federation!.syncOnce();
      await h.ctx.federation!.flushOutbox();
    }
  }
};

describe('global network', () => {
  it('gossips signed host and username records between hosts', async () => {
    const { a, b } = await twoHosts();
    await a.user('alice');
    await settle(a, b);
    const rec = b.ctx.federation!.getRecord('user:alice');
    expect(rec?.host).toBe('https://a.test');
    expect(b.ctx.federation!.getRecord('host:https://a.test')?.data.name).toBeTruthy();
  });

  it('keeps usernames unique across hosts', async () => {
    const { a, b } = await twoHosts();
    await a.user('alice');
    await settle(a, b);
    const r = await b.api('POST', '/auth/register', undefined, { email: 'x@b.test', username: 'alice', password: 'sturdy-pass-42' });
    expect(r.body.errors?.username).toMatch(/unavailable/);
  });

  it('rejects records with a bad signature or written for another host', async () => {
    const { a, b } = await twoHosts();
    await a.user('alice');
    await settle(a, b);
    const good = a.ctx.federation!.getRecord('user:alice')!;
    expect(await b.ctx.federation!.ingest({ ...good, data: { id: 'evil' }, ts: good.ts + 1 })).toBe(false);
    const hostRec = a.ctx.federation!.getRecord('host:https://a.test')!;
    expect(await b.ctx.federation!.ingest({ ...hostRec, key: 'host:https://c.test' })).toBe(false);
  });

  it('befriends and DMs a user on another host, mirroring both sides', async () => {
    const { a, b } = await twoHosts();
    const alice = await a.user('alice');
    const bob = await b.user('bob');
    await settle(a, b);

    // Alice adds bob@b.test from host A.
    const add = await a.api('POST', '/users/@me/relationships', alice.token, { username: 'bob@b.test' });
    expect(add.status).toBe(200);
    await settle(a, b);
    let bobRels = await b.api('GET', '/users/@me/relationships', bob.token);
    expect(bobRels.body).toHaveLength(1);
    expect(bobRels.body[0].type).toBe(3); // incoming
    expect(bobRels.body[0].user.username).toBe('alice@a.test');

    // Bob accepts on host B.
    await b.api('PUT', `/users/@me/relationships/${bobRels.body[0].id}`, bob.token, {});
    await settle(a, b);
    const aliceRels = await a.api('GET', '/users/@me/relationships', alice.token);
    expect(aliceRels.body[0].type).toBe(1);
    bobRels = await b.api('GET', '/users/@me/relationships', bob.token);
    expect(bobRels.body[0].type).toBe(1);

    // Alice messages bob; it arrives on host B authored by alice's remote user.
    const remoteBob = aliceRels.body[0].id;
    const dm = await a.api('POST', '/users/@me/channels', alice.token, { recipient_id: remoteBob });
    const sent = await a.api('POST', `/channels/${dm.body.id}/messages`, alice.token, { content: 'hello across hosts' });
    expect(sent.status).toBe(200);
    await settle(a, b);
    const bobDm = b.ctx.db
      .prepare('SELECT c.id FROM channels c JOIN channel_recipients r ON r.channel_id = c.id WHERE c.type = 1 AND r.user_id = ?')
      .get(bob.id) as any;
    const history = await b.api('GET', `/channels/${bobDm.id}/messages`, bob.token);
    expect(history.body[0].content).toBe('hello across hosts');
    expect(history.body[0].author.username).toBe('alice@a.test');

    // Bob replies; edits and deletes follow the message.
    const reply = await b.api('POST', `/channels/${bobDm.id}/messages`, bob.token, { content: 'hi alice' });
    await settle(a, b);
    let aHist = await a.api('GET', `/channels/${dm.body.id}/messages`, alice.token);
    expect(aHist.body[0].content).toBe('hi alice');
    await b.api('PATCH', `/channels/${bobDm.id}/messages/${reply.body.id}`, bob.token, { content: 'hi alice!' });
    await settle(a, b);
    aHist = await a.api('GET', `/channels/${dm.body.id}/messages`, alice.token);
    expect(aHist.body[0].content).toBe('hi alice!');
    await b.api('DELETE', `/channels/${bobDm.id}/messages/${reply.body.id}`, bob.token);
    await settle(a, b);
    aHist = await a.api('GET', `/channels/${dm.body.id}/messages`, alice.token);
    expect(aHist.body.map((m: any) => m.content)).toEqual(['hello across hosts']);
  });

  it('drops relayed DMs from non-friends', async () => {
    const { a, b } = await twoHosts();
    const alice = await a.user('alice');
    const bob = await b.user('bob');
    await settle(a, b);
    const r = await b.ctx.federation!.request('https://a.test', '/api/v1/federation/inbox', {
      type: 'dm_message', to_id: alice.id, from: { id: bob.id, username: 'bob', display_name: null, avatar: null }, message: { id: '1', content: 'spam' },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects inbox requests that are not signed by the claimed host', async () => {
    const { a } = await twoHosts();
    const res = await a.app.inject({
      method: 'POST', url: '/api/v1/federation/inbox',
      headers: { 'content-type': 'application/json', 'x-opencord-host': 'https://b.test', 'x-opencord-date': String(Date.now()), 'x-opencord-signature': 'AAAA' },
      payload: JSON.stringify({ type: 'friend_request' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('signs a user in to another host with an assertion from their home host', async () => {
    const { a, b } = await twoHosts();
    const alice = await a.user('alice');
    await settle(a, b);
    const { body } = await a.api('POST', '/federation/client/assertion', alice.token, { audience: 'https://b.test' });
    const login = await b.api('POST', '/federation/login', undefined, { assertion: body.assertion });
    expect(login.body.token).toBeTruthy();
    const me = await b.api('GET', '/users/@me', login.body.token);
    expect(me.body.username).toBe('alice@a.test');
    // Wrong audience is refused.
    const other = await a.api('POST', '/federation/client/assertion', alice.token, { audience: 'https://c.test' });
    expect((await b.api('POST', '/federation/login', undefined, { assertion: other.body.assertion })).status).toBe(401);
    // A remote user can't log in with a password on the visited host.
    expect((await b.api('POST', '/auth/login', undefined, { login: 'alice@a.test', password: '!remote' })).status).toBe(400);
  });
});

describe('global servers, cosmetics and themes', () => {
  it('lists a global server on other hosts and lets them sign in to join it', async () => {
    const { a, b } = await twoHosts();
    const owner = await a.user('owner');
    const visitor = await b.user('visitor');
    const g = (await a.api('POST', '/guilds', owner.token, { name: 'Worldwide' })).body;
    const set = await a.api('PUT', `/guilds/${g.id}/discovery`, owner.token, { discoverable: true, global: true });
    expect(set.body.invite).toBeTruthy();
    await settle(a, b);

    const dir = await b.api('GET', '/federation/client/directory/guild', visitor.token);
    const listing = dir.body.find((x: any) => x.name === 'Worldwide');
    expect(listing.host).toBe('https://a.test');

    // The visitor signs in to host A with their host-B account and joins via the listing's invite.
    const { body: as } = await b.api('POST', '/federation/client/assertion', visitor.token, { audience: listing.host });
    const login = await a.api('POST', '/federation/login', undefined, { assertion: as.assertion });
    const join = await a.api('POST', `/invites/${listing.invite}`, login.body.token, {});
    expect(join.status).toBe(200);
    expect(a.ctx.store.guildMemberIds(g.id)).toHaveLength(2);

    // Local discovery lists it too, and members can join without an invite.
    const local = await a.user('neighbour');
    const browse = await a.api('GET', '/discovery/guilds', local.token);
    expect(browse.body.map((x: any) => x.name)).toContain('Worldwide');
    expect((await a.api('POST', `/discovery/guilds/${g.id}/join`, local.token)).status).toBe(200);
  });

  it('keeps private cosmetics private and blocks copies of no-copy designs', async () => {
    const { a } = await twoHosts();
    const maker = await a.user('maker');
    const other = await a.user('other');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const priv = await a.api('POST', '/marketplace/items', maker.token, { category: 'avatar_decoration', name: 'Secret', asset: png, visibility: 'private', allow_copy: false });
    expect(priv.status).toBe(200);
    expect((await a.api('GET', `/marketplace/items/${priv.body.id}`, other.token)).status).toBe(404);
    expect((await a.api('PUT', `/marketplace/items/${priv.body.id}/claim`, other.token)).status).toBe(404);
    const community = await a.api('GET', '/marketplace/items?tab=community', other.token);
    expect(community.body.items.map((i: any) => i.id)).not.toContain(priv.body.id);
    const copy = await a.api('POST', '/marketplace/items', other.token, { category: 'avatar_decoration', name: 'Mine now', asset: png });
    expect(copy.status).toBe(400);
  });

  it('publishes a global cosmetic that users on other hosts can claim', async () => {
    const { a, b } = await twoHosts();
    const maker = await a.user('maker');
    const fan = await b.user('fan');
    const item = await a.api('POST', '/marketplace/items', maker.token, { category: 'banner', name: 'Sunset', colors: ['#ff8800', '#220044'], global: true });
    expect(item.body.global).toBe(true);
    await settle(a, b);
    const dir = await b.api('GET', '/federation/client/directory/item', fan.token);
    const listing = dir.body.find((x: any) => x.name === 'Sunset');
    expect(listing.author).toBe('maker@a.test');
    const claimed = await b.api('POST', '/marketplace/global/claim', fan.token, { key: listing.key });
    expect(claimed.body.origin).toBe(`https://a.test|${item.body.id}`);
    const owned = await b.api('GET', '/marketplace/items?tab=owned', fan.token);
    expect(owned.body.items.map((i: any) => i.name)).toContain('Sunset');
  });

  it('shares global themes across hosts and respects no-copy', async () => {
    const { a, b } = await twoHosts();
    const author = await a.user('author');
    const fan = await b.user('fan');
    const t = await a.api('POST', '/themes', author.token, { name: 'Neon', css: ':root{--brand:#f0f}', js: 'api.setVar("--x","1")', visibility: 'global', allow_copy: false });
    expect(t.status).toBe(200);
    await settle(a, b);
    const dir = await b.api('GET', '/federation/client/directory/theme', fan.token);
    const listing = dir.body.find((x: any) => x.name === 'Neon');
    const installed = await b.api('POST', '/themes/global/install', fan.token, { key: listing.key });
    expect(installed.body.css).toContain('--brand');
    expect(installed.body.can_view_source).toBe(false);
    expect((await b.api('POST', `/themes/${installed.body.id}/fork`, fan.token)).status).toBe(403);
    // Re-publishing the exact code under another name is refused on the author's host.
    const other = await a.user('copycat');
    expect((await a.api('POST', '/themes', other.token, { name: 'Neon 2', css: ':root{--brand:#f0f}', js: 'api.setVar("--x","1")' })).status).toBe(400);
  });
});

describe('cross-host calls', () => {
  async function friends() {
    const ctx = await twoHosts();
    const alice = await ctx.a.user('alice');
    const bob = await ctx.b.user('bob');
    await settle(ctx.a, ctx.b);
    await ctx.a.api('POST', '/users/@me/relationships', alice.token, { username: 'bob@b.test' });
    await settle(ctx.a, ctx.b);
    const incoming = (await ctx.b.api('GET', '/users/@me/relationships', bob.token)).body[0];
    await ctx.b.api('PUT', `/users/@me/relationships/${incoming.id}`, bob.token, {});
    await settle(ctx.a, ctx.b);
    const remoteBob = (await ctx.a.api('GET', '/users/@me/relationships', alice.token)).body[0].id;
    const remoteAlice = incoming.id;
    const dmA = (await ctx.a.api('POST', '/users/@me/channels', alice.token, { recipient_id: remoteBob })).body.id;
    const dmB = (await ctx.b.api('POST', '/users/@me/channels', bob.token, { recipient_id: remoteAlice })).body.id;
    return { ...ctx, alice, bob, remoteAlice, remoteBob, dmA, dmB };
  }

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('condition not met');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('rings the other host, bridges both SFUs and pipes media across', async () => {
    const { a, b, alice, bob, remoteAlice, dmA, dmB } = await friends();
    const ga = a.gateway(alice.token);
    const gb = b.gateway(bob.token);
    await ga.wait('READY');
    await gb.wait('READY');

    // Alice starts a call on host A: Bob is rung on host B and sees Alice in the call.
    ga.send(4, { channel_id: dmA });
    const ring = await gb.wait('CALL_CREATE', (d) => d.channel_id === dmB);
    expect(ring.ringing).toContain(bob.id);
    await gb.wait('VOICE_STATE_UPDATE', (d) => d.user_id === remoteAlice && d.channel_id === dmB);

    // Alice publishes on her own host's SFU.
    ga.send(21, { id: 1, method: 'join' });
    await until(() => !!(a.ctx.sfu as any).rooms.get(dmA)?.peers.get(alice.id));

    // Bob answers on host B → the hosts open an SRTP pipe between their SFUs.
    gb.send(4, { channel_id: dmB });
    await until(() => !!a.ctx.callBridge!.bridgeOf(dmA)?.connected && !!b.ctx.callBridge!.bridgeOf(dmB)?.connected);

    // A producer on host A (stand-in for Alice's mic) shows up on host B, attributed to Alice's remote user.
    const router = (a.ctx.sfu as any).router;
    const direct = await router.createDirectTransport();
    const mic = await direct.produce({
      kind: 'audio',
      rtpParameters: { codecs: [{ mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2 }], encodings: [{ ssrc: 1111 }] },
      appData: { userId: alice.id, streamType: 'mic' },
    });
    (a.ctx.sfu as any).rooms.get(dmA).peers.get(alice.id).producers.set(mic.id, mic);
    (a.ctx.sfu as any).producerHook(dmA, mic, 'add');
    await until(() => !!(b.ctx.sfu as any).rooms.get(dmB)?.external.get(mic.id));
    const piped = (b.ctx.sfu as any).rooms.get(dmB).external.get(mic.id);
    expect(piped.appData.userId).toBe(remoteAlice);

    // Closing it on A removes it on B.
    mic.close();
    (a.ctx.sfu as any).producerHook(dmA, mic, 'remove');
    await until(() => !(b.ctx.sfu as any).rooms.get(dmB)?.external.get(mic.id));

    // Hanging up tears the bridge down on both hosts.
    ga.send(4, { channel_id: null });
    await until(() => !a.ctx.callBridge!.bridgeOf(dmA) && !b.ctx.callBridge!.bridgeOf(dmB));
    ga.close();
    gb.close();
  });
});
