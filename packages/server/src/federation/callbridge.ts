// Calls between users on different hosts.
//
// Each user stays connected to their own host's SFU, so each host carries its own user's media.
// The other participant appears locally as a "virtual" voice state (which also drives ringing),
// and once both sides are in the call the two SFUs open an SRTP pipe transport to each other and
// pipe every local producer across. Each host sends exactly one copy of each stream to the other.
import type { types as ms } from 'mediasoup';
import type { Ctx } from '../app';
import type { PipeInfo } from '../sfu';
import { isRemote, profileOf, remoteRecipient } from './relay';

interface Bridge {
  channelId: string;
  localUser: string;
  remoteUser: string;
  remoteOrigin: string;
  pipe: ms.PipeTransport;
  connected: boolean;
  /** local producer id → pipe consumer sending it to the other host */
  out: Map<string, ms.Consumer>;
  /** remote producer id → producer it became here */
  in: Map<string, ms.Producer>;
}

export class CallBridge {
  private bridges = new Map<string, Bridge>();
  private opening = new Set<string>();

  constructor(private ctx: Ctx) {
    ctx.sfu.setProducerHook((channelId, producer, event) => {
      const b = this.bridges.get(channelId);
      if (!b?.connected) return;
      const owner = (producer.appData as { userId?: string }).userId;
      if (!owner || isRemote(ctx.store.userRow(owner) as any)) return;
      if (event === 'add') void this.pipeOut(b, producer).catch((e) => console.warn('[callbridge] pipe out failed', (e as Error).message));
      else this.unpipeOut(b, producer.id);
    });
  }

  private get fed() {
    return this.ctx.federation!;
  }

  /** Called on every voice-state change of a local user in a DM. */
  onLocalVoice(userId: string, channelId: string, state: { channel_id: string | null; self_mute?: boolean; self_deaf?: boolean; self_video?: boolean; self_stream?: boolean }) {
    if (isRemote(this.ctx.store.userRow(userId) as any)) return; // virtual participant, driven by the other host
    const remote = remoteRecipient(this.ctx, channelId, userId);
    if (!remote) return;
    const row = this.ctx.store.userRow(remote) as any;
    void this.fed
      .request(row.home_host, '/api/v1/federation/inbox', {
        type: 'call_state',
        from: profileOf(this.ctx, userId),
        to_id: row.home_id,
        joined: !!state.channel_id,
        self_mute: !!state.self_mute,
        self_deaf: !!state.self_deaf,
        self_video: !!state.self_video,
        self_stream: !!state.self_stream,
      })
      .catch(() => {});
    if (!state.channel_id) this.close(channelId);
    else void this.ensure(channelId);
  }

  /** Inbox: the remote participant joined/left/changed their state. */
  async onRemoteCallState(event: any, dmId: string, remoteId: string) {
    const hub = this.ctx.hub;
    if (event.joined) {
      hub.updateVoiceState(remoteId, {
        channel_id: dmId,
        self_mute: !!event.self_mute,
        self_deaf: !!event.self_deaf,
        self_video: !!event.self_video,
        self_stream: !!event.self_stream,
      });
      await this.ensure(dmId);
    } else {
      hub.leaveVoice(remoteId);
      this.close(dmId);
    }
    return { ok: true };
  }

  /** Opens the pipe once both sides are in the call. The host with the lower origin initiates. */
  private async ensure(channelId: string) {
    if (this.bridges.has(channelId) || this.opening.has(channelId)) return;
    const states = [...this.ctx.hub.voiceStates.values()].filter((v) => v.channel_id === channelId);
    const local = states.find((v) => !isRemote(this.ctx.store.userRow(v.user_id) as any));
    const remote = states.find((v) => isRemote(this.ctx.store.userRow(v.user_id) as any));
    if (!local || !remote) return;
    const row = this.ctx.store.userRow(remote.user_id) as any;
    if (this.fed.origin > row.home_host) return; // the other host opens it
    this.opening.add(channelId);
    try {
      const { transport, info } = await this.ctx.sfu.createPipe();
      const b: Bridge = { channelId, localUser: local.user_id, remoteUser: remote.user_id, remoteOrigin: row.home_host, pipe: transport, connected: false, out: new Map(), in: new Map() };
      this.bridges.set(channelId, b);
      const res = await this.fed.request(row.home_host, '/api/v1/federation/inbox', {
        type: 'pipe_open', from: profileOf(this.ctx, local.user_id), to_id: row.home_id, pipe: info,
      });
      if (!res?.pipe) throw new Error('peer refused pipe');
      await this.connect(b, res.pipe);
    } catch (e) {
      console.warn('[callbridge] could not open pipe:', (e as Error).message);
      this.close(channelId);
    } finally {
      this.opening.delete(channelId);
    }
  }

  /** Inbox: the other host opened a pipe; answer with ours. */
  async onPipeOpen(event: any, localUser: string, remoteUser: string, dmId: string): Promise<{ pipe: PipeInfo }> {
    this.close(dmId);
    const { transport, info } = await this.ctx.sfu.createPipe();
    const row = this.ctx.store.userRow(remoteUser) as any;
    const b: Bridge = { channelId: dmId, localUser, remoteUser, remoteOrigin: row.home_host, pipe: transport, connected: false, out: new Map(), in: new Map() };
    this.bridges.set(dmId, b);
    // Connect after answering so the initiator learns our address first.
    setImmediate(() => void this.connect(b, event.pipe).catch((e) => console.warn('[callbridge] connect failed', (e as Error).message)));
    return { pipe: info };
  }

  private async connect(b: Bridge, peer: PipeInfo) {
    if (typeof peer?.ip !== 'string' || typeof peer.port !== 'number') throw new Error('bad pipe address');
    await b.pipe.connect({ ip: peer.ip, port: peer.port, srtpParameters: peer.srtpParameters });
    b.connected = true;
    for (const p of this.ctx.sfu.localProducers(b.channelId)) await this.pipeOut(b, p);
  }

  private async pipeOut(b: Bridge, producer: ms.Producer) {
    if (b.out.has(producer.id) || producer.closed) return;
    const consumer = await b.pipe.consume({ producerId: producer.id });
    b.out.set(producer.id, consumer);
    consumer.observer.once('close', () => b.out.delete(producer.id));
    const row = this.ctx.store.userRow(b.remoteUser) as any;
    await this.fed.request(b.remoteOrigin, '/api/v1/federation/inbox', {
      type: 'pipe_produce',
      from: profileOf(this.ctx, b.localUser),
      to_id: row.home_id,
      producer: { id: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters, streamType: (producer.appData as any).streamType, paused: producer.paused },
    });
  }

  private unpipeOut(b: Bridge, producerId: string) {
    const c = b.out.get(producerId);
    if (!c) return;
    c.close();
    b.out.delete(producerId);
    const row = this.ctx.store.userRow(b.remoteUser) as any;
    void this.fed
      .request(b.remoteOrigin, '/api/v1/federation/inbox', { type: 'pipe_unproduce', from: profileOf(this.ctx, b.localUser), to_id: row.home_id, producer_id: producerId })
      .catch(() => {});
  }

  /** Inbox: a producer from the other host arrives through the pipe. */
  async onPipeProduce(event: any, dmId: string, remoteUser: string) {
    const b = this.bridges.get(dmId);
    const p = event.producer;
    if (!b || !p || typeof p.id !== 'string' || (p.kind !== 'audio' && p.kind !== 'video')) return { ok: false };
    if (b.in.has(p.id)) return { ok: true };
    const producer = await b.pipe.produce({
      id: p.id,
      kind: p.kind,
      rtpParameters: p.rtpParameters,
      paused: !!p.paused,
      appData: { userId: remoteUser, streamType: typeof p.streamType === 'string' ? p.streamType : undefined, piped: true },
    });
    b.in.set(p.id, producer);
    this.ctx.sfu.addExternalProducer(dmId, producer, remoteUser);
    return { ok: true };
  }

  onPipeUnproduce(event: any, dmId: string) {
    const b = this.bridges.get(dmId);
    const producer = b?.in.get(String(event.producer_id));
    if (!b || !producer) return { ok: true };
    producer.close(); // its consumers get 'producerclose' → clients drop the tile
    b.in.delete(producer.id);
    return { ok: true };
  }

  /** Tears down a bridge (when either side has left). */
  close(channelId: string) {
    const b = this.bridges.get(channelId);
    if (!b) return;
    this.bridges.delete(channelId);
    for (const p of b.in.values()) p.close();
    b.pipe.close();
  }

  /** Inbox dispatch for call events. Returns null for events this module doesn't handle. */
  async handle(event: any, target: { id: string }, remoteId: string, openDm: (a: string, b: string) => { id: string }) {
    switch (event.type) {
      case 'call_state':
        return this.onRemoteCallState(event, openDm(target.id, remoteId).id, remoteId);
      case 'pipe_open':
        return this.onPipeOpen(event, target.id, remoteId, openDm(target.id, remoteId).id);
      case 'pipe_produce':
        return this.onPipeProduce(event, openDm(target.id, remoteId).id, remoteId);
      case 'pipe_unproduce':
        return this.onPipeUnproduce(event, openDm(target.id, remoteId).id);
      default:
        return null;
    }
  }

  /** For tests. */
  bridgeOf(channelId: string) {
    return this.bridges.get(channelId);
  }
}
