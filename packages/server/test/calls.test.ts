import { afterEach, describe, expect, it } from 'vitest';
import { makeServer } from './helpers';

let server: Awaited<ReturnType<typeof makeServer>>;
afterEach(async () => {
  await server?.close();
});

async function befriend(a: { token: string; id: string }, b: { token: string; id: string; username: string }) {
  await server.api('POST', '/users/@me/relationships', a.token, { username: b.username });
  await server.api('PUT', `/users/@me/relationships/${a.id}`, b.token, {});
}

async function pair(friends: boolean) {
  server = await makeServer();
  const a = await server.user('alice');
  const b = await server.user('bob');
  if (friends) await befriend(a, b);
  const dm = (await server.api('POST', '/users/@me/channels', a.token, { recipient_id: b.id })).body;
  const ga = server.gateway(a.token);
  const gb = server.gateway(b.token);
  await ga.wait('READY');
  await gb.wait('READY');
  return { a, b, dm, ga, gb };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

describe('calls', () => {
  it('rings friends', async () => {
    const { b, dm, ga, gb } = await pair(true);
    ga.send(4, { channel_id: dm.id });
    expect((await gb.wait('CALL_CREATE')).ringing).toEqual([b.id]);
    ga.close();
    gb.close();
  });

  it('lets non-friends call without ringing the callee', async () => {
    const { a, b, dm, ga, gb } = await pair(false);
    ga.send(4, { channel_id: dm.id });
    const call = await gb.wait('CALL_CREATE');
    expect(call.ringing).toEqual([]);
    // The call is still there to join.
    gb.send(4, { channel_id: dm.id });
    await ga.wait('VOICE_STATE_UPDATE', (d) => d.user_id === b.id && d.channel_id === dm.id);
    // Asking to ring them anyway changes nothing.
    await server.api('POST', `/channels/${dm.id}/call/ring`, a.token, {});
    gb.send(4, { channel_id: null });
    await settle();
    await server.api('POST', `/channels/${dm.id}/call/ring`, a.token, {});
    const upd = await gb.wait('CALL_UPDATE');
    expect(upd.ringing).toEqual([]);
    ga.close();
    gb.close();
  });

  it('never rings someone in Do Not Disturb, and DND stops a ring in progress', async () => {
    const { b, dm, ga, gb } = await pair(true);
    ga.send(4, { channel_id: dm.id });
    expect((await gb.wait('CALL_CREATE')).ringing).toEqual([b.id]);
    await server.api('PATCH', '/users/@me/settings', b.token, { status: 'dnd' });
    expect((await gb.wait('CALL_UPDATE', (d) => d.ringing.length === 0)).ringing).toEqual([]);
    ga.send(4, { channel_id: null });
    await gb.wait('CALL_DELETE');
    ga.send(4, { channel_id: dm.id });
    expect((await gb.wait('CALL_CREATE', (d) => d.message_id !== undefined && d.ringing.length === 0)).ringing).toEqual([]);
    ga.close();
    gb.close();
  });

  it('refuses calls across a block, and blocking ends a ringing call', async () => {
    const { a, b, dm, ga, gb } = await pair(true);
    ga.send(4, { channel_id: dm.id });
    await gb.wait('CALL_CREATE');
    await server.api('PUT', `/users/@me/relationships/${a.id}`, b.token, { type: 2 });
    await gb.wait('CALL_DELETE');
    // Neither side can start a call now.
    ga.send(4, { channel_id: dm.id });
    const refused = await ga.wait('VOICE_STATE_UPDATE', (d) => d.refused_channel_id === dm.id);
    expect(refused.channel_id).toBeNull();
    gb.send(4, { channel_id: dm.id });
    await gb.wait('VOICE_STATE_UPDATE', (d) => d.refused_channel_id === dm.id);
    await settle();
    expect(gb.events.filter((e) => e.t === 'CALL_CREATE')).toHaveLength(1);
    expect([...server.ctx.hub.voiceStates.values()].filter((v) => v.channel_id === dm.id)).toHaveLength(0);
    ga.close();
    gb.close();
  });
});

describe('mention badges', () => {
  it('skips people who blocked the author or muted their messages', async () => {
    server = await makeServer();
    const owner = await server.user('owner');
    const loud = await server.user('loud');
    const blocker = await server.user('blocker');
    const muter = await server.user('muter');
    const fan = await server.user('fan');
    const g = (await server.api('POST', '/guilds', owner.token, { name: 'Gang' })).body;
    const ch = (await server.api('GET', `/guilds/${g.id}`, owner.token)).body.channels.find((c: any) => c.type === 0).id;
    const inv = (await server.api('POST', `/channels/${ch}/invites`, owner.token, {})).body.code;
    for (const u of [loud, blocker, muter, fan]) await server.api('POST', `/invites/${inv}`, u.token, {});
    await server.api('PUT', `/users/@me/relationships/${loud.id}`, blocker.token, { type: 2 });
    expect((await server.api('PATCH', '/users/@me/settings', muter.token, { user_overrides: { [loud.id]: { mute_messages: true } } })).status).toBe(200);
    await server.api('POST', `/channels/${ch}/messages`, loud.token, { content: `hey <@${blocker.id}> <@${muter.id}> <@${fan.id}>` });
    const count = (u: string) => (server.ctx.db.prepare('SELECT mention_count AS c FROM read_states WHERE user_id = ? AND channel_id = ?').get(u, ch) as any)?.c ?? 0;
    expect(count(fan.id)).toBe(1);
    expect(count(blocker.id)).toBe(0);
    expect(count(muter.id)).toBe(0);
  });
});

describe('settings validation', () => {
  it('rejects wrong types and bad values, keeps good ones', async () => {
    server = await makeServer();
    const u = await server.user();
    expect((await server.api('PATCH', '/users/@me/settings', u.token, { status: 'sleeping' })).status).toBe(400);
    expect((await server.api('PATCH', '/users/@me/settings', u.token, { notification_sounds: 'yes' })).status).toBe(400);
    expect((await server.api('PATCH', '/users/@me/settings', u.token, { user_overrides: { '123': { volume: 500 } } })).status).toBe(400);
    expect((await server.api('PATCH', '/users/@me/settings', u.token, { user_overrides: { 'not-an-id': { volume: 50 } } })).status).toBe(400);
    const ok = await server.api('PATCH', '/users/@me/settings', u.token, { user_overrides: { '123': { volume: 150, mute_voice: false } }, made_up_key: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.user_overrides).toEqual({ '123': { volume: 150, mute_voice: false } });
    expect('made_up_key' in ok.body).toBe(false);
  });
});
