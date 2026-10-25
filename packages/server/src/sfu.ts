// mediasoup SFU (Selective Forwarding Unit). Replaces the peer-to-peer mesh: every participant
// uploads once to this relay and downloads each other participant's stream from it, so bandwidth
// and CPU scale linearly instead of quadratically.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import * as mediasoup from 'mediasoup';
import type { types as ms } from 'mediasoup';

export interface SfuConfig {
  /** Address the SFU binds for media (typically 0.0.0.0). */
  listenIp: string;
  /** Public IP/hostname clients use to reach this server (empty = use listenIp). */
  announcedIp?: string;
  rtcMinPort: number;
  rtcMaxPort: number;
}

interface TransportParams {
  id: string;
  iceParameters: ms.IceParameters;
  iceCandidates: ms.IceCandidate[];
  dtlsParameters: ms.DtlsParameters;
}

interface ProducerInfo {
  producerId: string;
  userId: string;
  kind: ms.MediaKind;
  streamType?: string;
}

interface Peer {
  userId: string;
  channelId: string;
  send: ms.WebRtcTransport;
  recv: ms.WebRtcTransport;
  producers: Map<string, ms.Producer>;
  consumers: Map<string, ms.Consumer>;
}

interface Room {
  channelId: string;
  peers: Map<string, Peer>;
  /** Producers piped in from another host's SFU (see federation/callbridge.ts). */
  external: Map<string, ms.Producer>;
}

export interface PipeInfo {
  ip: string;
  port: number;
  srtpParameters?: ms.SrtpParameters;
}

/** Notified when a participant's producer appears or goes away (used to pipe media between hosts). */
export type ProducerHook = (channelId: string, producer: ms.Producer, event: 'add' | 'remove') => void;

const MEDIA_CODECS: ms.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000 },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
  },
];

export type SfuEventSink = (userId: string, event: string, data?: unknown) => void;

export class Sfu {
  private worker: ms.Worker | null = null;
  private router: ms.Router | null = null;
  private rooms = new Map<string, Room>();
  private config: SfuConfig | null = null;
  private sink: SfuEventSink = () => {};
  private producerHook: ProducerHook = () => {};

  setEventSink(sink: SfuEventSink) {
    this.sink = sink;
  }

  setProducerHook(hook: ProducerHook) {
    this.producerHook = hook;
  }

  async start(config: SfuConfig) {
    this.config = config;
    this.worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: config.rtcMinPort,
      rtcMaxPort: config.rtcMaxPort,
    });
    this.worker.on('died', () => console.error('[sfu] mediasoup worker process died'));
    this.router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  }

  async close() {
    for (const room of this.rooms.values()) {
      for (const p of room.external.values()) p.close();
      for (const peer of room.peers.values()) {
        for (const p of peer.producers.values()) p.close();
        for (const c of peer.consumers.values()) c.close();
        peer.send.close();
        peer.recv.close();
      }
    }
    this.rooms.clear();
    this.router?.close();
    this.worker?.close();
    this.router = null;
    this.worker = null;
  }

  get routerRtpCapabilities(): ms.RtpCapabilities {
    if (!this.router) throw new Error('SFU not started');
    return this.router.rtpCapabilities;
  }

  /** Number of participants currently in a channel's SFU room. */
  peerCount(channelId: string): number {
    return this.rooms.get(channelId)?.peers.size ?? 0;
  }

  /**
   * Address put in the ICE candidates. Without a configured one, a wildcard bind would advertise
   * 0.0.0.0, which no client can reach, so fall back to the host the client connected through.
   */
  private async announcedFor(clientHost?: string | null): Promise<string | undefined> {
    if (this.config?.announcedIp) return this.config.announcedIp;
    const listen = this.config?.listenIp ?? '0.0.0.0';
    if (listen !== '0.0.0.0' && listen !== '::') return undefined;
    const host = clientHost?.replace(/^\[|\]$/g, '');
    if (!host) return undefined;
    if (isIP(host)) return host;
    try {
      return (await lookup(host, { family: listen === '::' ? 0 : 4 })).address;
    } catch {
      return undefined;
    }
  }

  /** Create a participant's send + recv transports and return their params plus existing producers. */
  async join(channelId: string, userId: string, clientHost?: string | null): Promise<{ send: TransportParams; recv: TransportParams; producers: ProducerInfo[] }> {
    if (!this.router) throw new Error('SFU not started');
    // A repeat join comes from a client that rebuilt its transports (e.g. after a gateway reconnect);
    // the old ones belong to a dead peer connection, so start over.
    await this.leave(channelId, userId);
    let room = this.rooms.get(channelId);
    if (!room) {
      room = this.room(channelId);
    }

    const listenIps = [{ ip: this.config?.listenIp ?? '0.0.0.0', announcedIp: await this.announcedFor(clientHost) }];
    const send = await this.router.createWebRtcTransport({
      listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
    });
    const recv = await this.router.createWebRtcTransport({
      listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
    });
    room.peers.set(userId, { userId, channelId, send, recv, producers: new Map(), consumers: new Map() });
    // The newcomer needs to consume everyone already publishing.
    return { send: this.params(send), recv: this.params(recv), producers: this.producersOf(room, userId) };
  }

  async connectTransport(channelId: string, userId: string, transportId: string, dtlsParameters: ms.DtlsParameters): Promise<void> {
    const peer = this.requirePeer(channelId, userId);
    if (peer.send.id === transportId) await peer.send.connect({ dtlsParameters });
    else if (peer.recv.id === transportId) await peer.recv.connect({ dtlsParameters });
    else throw new Error('Unknown transport');
  }

  async produce(
    channelId: string,
    userId: string,
    data: { kind: ms.MediaKind; rtpParameters: ms.RtpParameters; appData?: Record<string, unknown> },
  ): Promise<{ id: string }> {
    const peer = this.requirePeer(channelId, userId);
    const producer = await peer.send.produce({
      kind: data.kind,
      rtpParameters: data.rtpParameters,
      appData: { ...data.appData, userId } as ms.AppData,
    });
    peer.producers.set(producer.id, producer);
    producer.on('transportclose', () => {
      peer.producers.delete(producer.id);
      this.producerHook(channelId, producer, 'remove');
    });
    this.announce(channelId, producer, userId);
    this.producerHook(channelId, producer, 'add');
    return { id: producer.id };
  }

  async consume(
    channelId: string,
    userId: string,
    data: { producerId: string; rtpCapabilities: ms.RtpCapabilities },
  ): Promise<{ id: string; producerId: string; kind: ms.MediaKind; rtpParameters: ms.RtpParameters; userId: string; streamType?: string }> {
    const peer = this.requirePeer(channelId, userId);
    const producer = this.findProducer(channelId, data.producerId);
    if (!producer) throw new Error('Producer not found');
    if (!this.router!.canConsume({ producerId: producer.id, rtpCapabilities: data.rtpCapabilities })) {
      throw new Error('Cannot consume this producer');
    }
    const consumer = await peer.recv.consume({ producerId: producer.id, rtpCapabilities: data.rtpCapabilities });
    peer.consumers.set(consumer.id, consumer);
    consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
    consumer.on('producerclose', () => {
      peer.consumers.delete(consumer.id);
      this.sink(userId, 'producerClosed', { consumerId: consumer.id });
    });
    const meta = producer.appData as { userId: string; streamType?: string };
    return {
      id: consumer.id,
      producerId: producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      userId: meta.userId,
      streamType: meta.streamType,
    };
  }

  /**
   * Close one of a participant's producers (camera off, screen share stopped). Closing it only on the
   * client leaves the server producer alive, so viewers keep a frozen/black tile forever.
   */
  closeProducer(channelId: string, userId: string, producerId: string): void {
    const peer = this.rooms.get(channelId)?.peers.get(userId);
    const producer = peer?.producers.get(producerId);
    if (!peer || !producer) return;
    producer.close();
    peer.producers.delete(producerId);
    this.producerHook(channelId, producer, 'remove');
    // Every consumer of it fires 'producerclose', which sends producerClosed to that viewer.
  }

  /** Tear down a participant's session and notify the rest of the room. */
  async leave(channelId: string, userId: string): Promise<void> {
    const room = this.rooms.get(channelId);
    if (!room) return;
    const peer = room.peers.get(userId);
    if (!peer) return;
    for (const p of peer.producers.values()) {
      p.close();
      this.producerHook(channelId, p, 'remove');
    }
    for (const c of peer.consumers.values()) c.close();
    peer.send.close();
    peer.recv.close();
    room.peers.delete(userId);
    if (room.peers.size === 0 && room.external.size === 0) this.rooms.delete(channelId);
    for (const id of room.peers.keys()) this.sink(id, 'peerLeft', { userId });
  }

  private room(channelId: string): Room {
    let room = this.rooms.get(channelId);
    if (!room) {
      room = { channelId, peers: new Map(), external: new Map() };
      this.rooms.set(channelId, room);
    }
    return room;
  }

  /** Tells everyone else in the room about a new producer. */
  private announce(channelId: string, producer: ms.Producer, userId: string) {
    const streamType = (producer.appData as { streamType?: string }).streamType;
    for (const id of this.rooms.get(channelId)?.peers.keys() ?? []) {
      if (id !== userId) this.sink(id, 'newProducer', { producerId: producer.id, userId, kind: producer.kind, streamType });
    }
  }

  /* ───────────── host-to-host pipes (cross-host calls) ───────────── */

  /** Opens a pipe transport other hosts can send RTP to. SRTP-encrypted, since it crosses the internet. */
  async createPipe(): Promise<{ transport: ms.PipeTransport; info: PipeInfo }> {
    if (!this.router) throw new Error('SFU not started');
    const listen = this.config?.listenIp ?? '0.0.0.0';
    const wildcard = listen === '0.0.0.0' || listen === '::';
    // Pipes need a literal IP: resolve a hostname announcement (e.g. from public_url) first.
    let announced = this.config?.announcedIp ?? '';
    if (announced && !isIP(announced)) {
      try {
        announced = (await lookup(announced, { family: 4 })).address;
      } catch {
        announced = '';
      }
    }
    if (!announced) announced = wildcard ? '127.0.0.1' : listen;
    const transport = await this.router.createPipeTransport({
      listenInfo: { protocol: 'udp', ip: listen, announcedAddress: announced, portRange: { min: this.config!.rtcMinPort, max: this.config!.rtcMaxPort } },
      enableSrtp: true,
    });
    return { transport, info: { ip: announced, port: transport.tuple.localPort, srtpParameters: transport.srtpParameters } };
  }

  /** Makes a producer piped in from another host consumable by this room, attributed to `userId`. */
  addExternalProducer(channelId: string, producer: ms.Producer, userId: string) {
    const room = this.room(channelId);
    room.external.set(producer.id, producer);
    producer.observer.once('close', () => {
      room.external.delete(producer.id);
      if (room.peers.size === 0 && room.external.size === 0) this.rooms.delete(channelId);
    });
    this.announce(channelId, producer, userId);
  }

  /** Producers that belong to participants in this room (excludes ones piped in from elsewhere). */
  localProducers(channelId: string): ms.Producer[] {
    const room = this.rooms.get(channelId);
    return room ? [...room.peers.values()].flatMap((p) => [...p.producers.values()]) : [];
  }

  private params(t: ms.WebRtcTransport): TransportParams {
    return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters };
  }

  private producersOf(room: Room, userId: string): ProducerInfo[] {
    const out: ProducerInfo[] = [];
    const add = (producer: ms.Producer) => {
      const meta = producer.appData as { userId: string; streamType?: string };
      out.push({ producerId: producer.id, userId: meta.userId, kind: producer.kind, streamType: meta.streamType });
    };
    for (const [id, p] of room.peers) {
      if (id === userId) continue;
      for (const producer of p.producers.values()) add(producer);
    }
    for (const producer of room.external.values()) add(producer);
    return out;
  }

  private requirePeer(channelId: string, userId: string): Peer {
    const peer = this.rooms.get(channelId)?.peers.get(userId);
    if (!peer) throw new Error('Not connected to the SFU room');
    return peer;
  }

  private findProducer(channelId: string, producerId: string): ms.Producer | undefined {
    const room = this.rooms.get(channelId);
    if (!room) return undefined;
    for (const peer of room.peers.values()) {
      const p = peer.producers.get(producerId);
      if (p) return p;
    }
    return room.external.get(producerId);
  }
}
