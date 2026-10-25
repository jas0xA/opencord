// Voice/video over a Selective Forwarding Unit (mediasoup). Each participant uploads once to the
// server relay and downloads every other participant's streams from it, so bandwidth and CPU scale
// linearly with group size instead of quadratically (unlike a peer-to-peer mesh). Signaling is a
// request/response protocol carried over the gateway (op SFU).
import { GatewayOp, type VoiceState } from '@opencord/shared';
import { Device, type types as mst } from 'mediasoup-client';
import { playSound } from './sounds';
import { sendGateway, toast, useStore } from './store';

export interface StreamQuality {
  resolution: 720 | 1080 | 1440 | 2160;
  fps: 15 | 30 | 60;
  optimize: 'motion' | 'detail';
}

export const RESOLUTIONS: Record<StreamQuality['resolution'], [number, number]> = {
  720: [1280, 720],
  1080: [1920, 1080],
  1440: [2560, 1440],
  2160: [3840, 2160],
};

/**
 * Target bitrate for a screen share. WebRTC's default cap (~2.5 Mbps) is far too low for screen
 * content with lots of motion, which makes the encoder keep dropping and restoring resolution.
 */
export function streamBitrate(q: StreamQuality) {
  const [w, h] = RESOLUTIONS[q.resolution];
  const bitsPerPixel = q.optimize === 'motion' ? 0.1 : 0.07;
  return Math.round(Math.min(40_000_000, Math.max(1_500_000, w * h * q.fps * bitsPerPixel)));
}

export interface VoiceSnapshot {
  channelId: string | null;
  guildId: string | null;
  muted: boolean;
  deafened: boolean;
  camera: MediaStream | null;
  screen: MediaStream | null;
  speaking: Set<string>;
  remoteVideo: { userId: string; kind: 'camera' | 'screen'; stream: MediaStream }[];
  connected: Set<string>;
  /** Media path to the SFU: 'failed' means ICE/DTLS could not be established. */
  rtc: 'connecting' | 'connected' | 'failed';
  ping: number | null;
}

type StreamType = 'mic' | 'camera' | 'screen';

interface RemoteConsumer {
  consumer: mst.Consumer;
  userId: string;
  kind: 'audio' | 'video';
  streamType: StreamType;
  stream: MediaStream;
  el?: HTMLAudioElement;
}

class VoiceManager {
  channelId: string | null = null;
  guildId: string | null = null;
  muted = false;
  deafened = false;
  private mic: MediaStream | null = null;
  private camera: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private screenSource: { id: string; audio: boolean } | null = null;
  private micProducer: mst.Producer | null = null;
  private cameraProducer: mst.Producer | null = null;
  private screenProducer: mst.Producer | null = null;
  private device: Device | null = null;
  private sendTransport: mst.Transport | null = null;
  private recvTransport: mst.Transport | null = null;
  private consumers = new Map<string, RemoteConsumer>();
  private volumes = new Map<string, number>();
  private speaking = new Set<string>();
  private listeners = new Set<() => void>();
  private snapshot: VoiceSnapshot = this.build();
  private audioCtx: AudioContext | null = null;
  private analysers = new Map<string, { analyser: AnalyserNode; data: Uint8Array }>();
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private pttDown = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private ping: number | null = null;
  private sfuReqSeq = 0;
  private sfuPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  /* ───────────── subscription for React ───────────── */

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;

  private build(): VoiceSnapshot {
    const remoteVideo: VoiceSnapshot['remoteVideo'] = [];
    for (const c of this.consumers.values()) {
      if (c.kind === 'video' && c.stream.getVideoTracks().some((t) => t.readyState === 'live')) {
        remoteVideo.push({ userId: c.userId, kind: c.streamType === 'screen' ? 'screen' : 'camera', stream: c.stream });
      }
    }
    const connected = new Set<string>();
    if (this.sendTransport?.connectionState === 'connected') connected.add(this.me?.id ?? 'self');
    // A transport only connects once media flows over it; with no mic and nobody to hear, a loaded
    // device is as connected as it gets.
    const transports: mst.Transport[] = [];
    if (this.sendTransport && (this.micProducer || this.cameraProducer || this.screenProducer)) transports.push(this.sendTransport);
    if (this.recvTransport && this.consumers.size > 0) transports.push(this.recvTransport);
    const rtc: VoiceSnapshot['rtc'] = transports.some((t) => t.connectionState === 'failed')
      ? 'failed'
      : this.device && transports.every((t) => t.connectionState === 'connected')
        ? 'connected'
        : 'connecting';
    return {
      channelId: this.channelId,
      guildId: this.guildId,
      muted: this.muted,
      deafened: this.deafened,
      camera: this.camera,
      screen: this.screen,
      speaking: new Set(this.speaking),
      remoteVideo,
      connected,
      rtc,
      ping: this.ping,
    };
  }

  private emit() {
    this.snapshot = this.build();
    for (const l of this.listeners) l();
  }

  private get me() {
    return useStore.getState().me;
  }

  private settings() {
    return this.me!.settings;
  }

  /* ───────────── join / leave ───────────── */

  async join(channelId: string, guildId: string | null) {
    if (this.channelId === channelId) return;
    if (this.channelId) this.leave(false);
    const s = this.settings();
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: s.input_device !== 'default' ? { exact: s.input_device } : undefined,
          echoCancellation: s.echo_cancellation,
          noiseSuppression: s.noise_suppression,
          autoGainControl: s.auto_gain,
        },
      });
    } catch {
      toast('Microphone unavailable. You joined muted.');
      this.mic = null;
      this.muted = true;
    }
    this.channelId = channelId;
    this.guildId = guildId;
    this.applyMicState();
    this.startVad();
    this.startStats();
    sendGateway(GatewayOp.VOICE_STATE_UPDATE, this.statePayload());
    playSound('join');
    this.emit();
  }

  leave(sound = true) {
    if (!this.channelId) return;
    this.teardownSfu();
    for (const s of [this.mic, this.camera, this.screen]) s?.getTracks().forEach((t) => t.stop());
    this.mic = this.camera = this.screen = null;
    this.screenSource = null;
    this.channelId = null;
    this.guildId = null;
    this.speaking.clear();
    this.analysers.clear();
    this.volumes.clear();
    if (this.vadTimer) clearInterval(this.vadTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.vadTimer = this.statsTimer = null;
    this.ping = null;
    sendGateway(GatewayOp.VOICE_STATE_UPDATE, { channel_id: null });
    if (sound) playSound('disconnect');
    this.emit();
  }

  onReconnect() {
    if (!this.channelId) return;
    this.teardownSfu();
    sendGateway(GatewayOp.VOICE_STATE_UPDATE, this.statePayload());
  }

  private statePayload() {
    return {
      channel_id: this.channelId,
      self_mute: this.muted,
      self_deaf: this.deafened,
      self_video: !!this.camera,
      self_stream: !!this.screen,
    };
  }

  /* ───────────── SFU session ───────────── */

  private request(method: string, data?: any): Promise<any> {
    const id = ++this.sfuReqSeq;
    return new Promise((resolve, reject) => {
      this.sfuPending.set(id, { resolve, reject });
      sendGateway(GatewayOp.SFU, { id, method, data });
    });
  }

  handleSfu(msg: any) {
    if (msg && typeof msg.id === 'number') {
      const p = this.sfuPending.get(msg.id);
      if (!p) return;
      this.sfuPending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error ?? 'SFU error'));
    } else if (msg && typeof msg.event === 'string') {
      void this.onSfuEvent(msg.event, msg.data);
    }
  }

  private async onSfuEvent(event: string, data: any) {
    try {
      if (event === 'newProducer') {
        await this.consumeRemote(data.producerId);
      } else if (event === 'producerClosed') {
        this.closeConsumer(data.consumerId);
      } else if (event === 'peerLeft') {
        for (const [id, c] of this.consumers) if (c.userId === data.userId) this.closeConsumer(id);
      }
    } catch (e) {
      console.warn('[voice] SFU event error', e);
    }
  }

  private async initSfu() {
    if (this.device || !this.channelId) return;
    try {
      const device = new Device();
      const caps = await this.request('getRouterRtpCapabilities');
      await device.load({ routerRtpCapabilities: caps });
      const { send, recv, producers } = await this.request('join');

      this.sendTransport = device.createSendTransport(send);
      this.recvTransport = device.createRecvTransport(recv);

      this.sendTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
        this.request('connectTransport', { transportId: send.id, dtlsParameters }).then(cb).catch(eb);
      });
      this.recvTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
        this.request('connectTransport', { transportId: recv.id, dtlsParameters }).then(cb).catch(eb);
      });
      this.sendTransport.on('produce', ({ kind, rtpParameters, appData }, cb, eb) => {
        this.request('produce', { kind, rtpParameters, appData }).then(({ id }) => cb({ id })).catch(eb);
      });
      const onState = () => this.emit();
      this.sendTransport.on('connectionstatechange', onState);
      this.recvTransport.on('connectionstatechange', onState);

      this.device = device;

      // Publish whatever local media we already have.
      if (this.mic) await this.produceMic();
      if (this.camera) await this.produceCamera();
      if (this.screen) await this.produceScreen();

      // Subscribe to everyone already publishing in the room.
      for (const info of producers ?? []) await this.consumeRemote(info.producerId);
      this.emit();
    } catch (e) {
      console.warn('[voice] SFU init failed', e);
      this.teardownSfu();
    }
  }

  private teardownSfu() {
    for (const c of this.consumers.values()) {
      try {
        c.consumer.close();
      } catch {
        /* ignore */
      }
      c.el?.pause();
      c.el = undefined;
    }
    this.consumers.clear();
    for (const p of [this.micProducer, this.cameraProducer, this.screenProducer]) {
      try {
        p?.close();
      } catch {
        /* ignore */
      }
    }
    this.micProducer = this.cameraProducer = this.screenProducer = null;
    try {
      this.sendTransport?.close();
      this.recvTransport?.close();
    } catch {
      /* ignore */
    }
    this.sendTransport = this.recvTransport = null;
    this.device = null;
  }

  /* ───────────── producing (local media → SFU) ───────────── */

  /** Close a producer locally and on the SFU so viewers drop the tile instead of keeping a black one. */
  private closeProducer(p: mst.Producer | null) {
    if (!p) return;
    try {
      p.close();
    } catch {
      /* ignore */
    }
    if (this.device) this.request('closeProducer', { producerId: p.id }).catch(() => {});
  }

  private async produceMic() {
    if (!this.mic || !this.sendTransport || this.micProducer) return;
    const track = this.mic.getAudioTracks()[0];
    if (!track) return;
    this.micProducer = await this.sendTransport.produce({ track, appData: { streamType: 'mic' } });
  }

  private async produceCamera() {
    if (!this.camera || !this.sendTransport || this.cameraProducer) return;
    const track = this.camera.getVideoTracks()[0];
    if (!track) return;
    this.cameraProducer = await this.sendTransport.produce({
      track,
      encodings: [{ maxBitrate: 2_500_000, maxFramerate: 30 }],
      appData: { streamType: 'camera' },
    });
  }

  private async produceScreen() {
    if (!this.screen || !this.sendTransport || this.screenProducer) return;
    const track = this.screen.getVideoTracks()[0];
    if (!track) return;
    const q = this.quality();
    this.screenProducer = await this.sendTransport.produce({
      track,
      encodings: [{ maxBitrate: streamBitrate(q), maxFramerate: q.fps }],
      appData: { streamType: 'screen' },
    });
  }

  private async consumeRemote(producerId: string) {
    if (!this.recvTransport || !this.device) return;
    if ([...this.consumers.values()].some((c) => c.consumer.producerId === producerId)) return;
    const { id, producerId: pid, kind, rtpParameters, userId, streamType } = await this.request('consume', {
      producerId,
      rtpCapabilities: this.device.recvRtpCapabilities,
    });
    const consumer = await this.recvTransport.consume({ id, producerId: pid, kind, rtpParameters });
    const stream = new MediaStream([consumer.track]);
    const entry: RemoteConsumer = { consumer, userId, kind, streamType: (streamType as StreamType) ?? 'mic', stream };
    this.consumers.set(consumer.id, entry);

    if (kind === 'audio') {
      const el = new Audio();
      el.autoplay = true;
      el.srcObject = stream;
      const out = this.settings().output_device;
      if (out !== 'default' && 'setSinkId' in el) (el as any).setSinkId(out).catch(() => {});
      entry.el = el;
      this.applyDeafen();
      if (entry.streamType !== 'screen') this.watchSpeaking(userId, stream);
    } else if (kind === 'video') {
      consumer.track.onended = () => this.closeConsumer(consumer.id);
      consumer.on('trackended', () => this.closeConsumer(consumer.id));
      consumer.on('transportclose', () => this.closeConsumer(consumer.id));
    }
    this.emit();
  }

  private closeConsumer(id: string) {
    const c = this.consumers.get(id);
    if (!c) return;
    this.consumers.delete(id);
    try {
      c.consumer.close();
    } catch {
      /* ignore */
    }
    c.el?.pause();
    if (c.kind === 'audio' && c.streamType === 'mic') {
      this.analysers.delete(c.userId);
      this.speaking.delete(c.userId);
    }
    this.emit();
  }

  /* ───────────── controls ───────────── */

  toggleMute() {
    if (this.deafened && this.muted) {
      this.deafened = false;
      this.applyDeafen();
    }
    this.muted = !this.muted;
    playSound(this.muted ? 'mute' : 'unmute');
    this.applyMicState();
    if (this.channelId) sendGateway(GatewayOp.VOICE_STATE_UPDATE, this.statePayload());
    this.emit();
  }

  toggleDeafen() {
    this.deafened = !this.deafened;
    if (this.deafened) this.muted = true;
    else if (this.muted) this.muted = false;
    playSound(this.deafened ? 'deafen' : 'undeafen');
    this.applyMicState();
    this.applyDeafen();
    if (this.channelId) sendGateway(GatewayOp.VOICE_STATE_UPDATE, this.statePayload());
    this.emit();
  }

  setPushToTalk(down: boolean) {
    this.pttDown = down;
    this.applyMicState();
  }

  setUserVolume(userId: string, volume: number) {
    this.volumes.set(userId, volume);
    this.applyDeafen();
  }

  private applyMicState() {
    const serverMuted = this.channelId ? useStore.getState().voiceStates[this.me?.id ?? '']?.mute : false;
    const ptt = this.settings()?.input_mode === 'ptt';
    const enabled = !this.muted && !serverMuted && (!ptt || this.pttDown);
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }

  private applyDeafen() {
    const out = (this.settings()?.output_volume ?? 100) / 100;
    for (const c of this.consumers.values()) {
      if (c.el) {
        c.el.muted = this.deafened;
        c.el.volume = Math.min(1, out * (this.volumes.get(c.userId) ?? 1));
      }
    }
  }

  async setCamera(on: boolean) {
    if (!this.channelId) return;
    if (on && !this.camera) {
      try {
        const id = this.settings().video_device;
        this.camera = await navigator.mediaDevices.getUserMedia({ video: { deviceId: id !== 'default' ? { exact: id } : undefined, width: 1280, height: 720 } });
      } catch {
        toast('Camera unavailable.');
        return;
      }
      if (this.device) await this.produceCamera();
    } else if (!on && this.camera) {
      this.closeProducer(this.cameraProducer);
      this.cameraProducer = null;
      this.camera.getTracks().forEach((t) => t.stop());
      this.camera = null;
    }
    sendGateway(GatewayOp.VOICE_STATE_UPDATE, this.statePayload());
    this.emit();
  }

  quality(): StreamQuality {
    const st = this.settings();
    return { resolution: st?.stream_resolution ?? 1080, fps: st?.stream_fps ?? 30, optimize: st?.stream_optimize ?? 'motion' };
  }

  private async captureScreen(sourceId: string, withAudio: boolean, q: StreamQuality) {
    const [w, h] = RESOLUTIONS[q.resolution];
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: withAudio ? ({ mandatory: { chromeMediaSource: 'desktop' } } as any) : false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: w, maxHeight: h, maxFrameRate: q.fps } } as any,
    });
    const video = stream.getVideoTracks()[0];
    video.contentHint = q.optimize === 'motion' ? 'motion' : 'detail';
    return stream;
  }

  async startScreenShare(sourceId: string, withAudio = false) {
    if (!this.channelId) return;
    if (this.screen) this.stopScreenShare();
    try {
      this.screen = await this.captureScreen(sourceId, withAudio, this.quality());
    } catch {
      toast('Screen share failed.');
      return;
    }
    this.screenSource = { id: sourceId, audio: withAudio };
    this.screen.getVideoTracks()[0].onended = () => this.stopScreenShare();
    if (this.device) await this.produceScreen();
    sendGateway(GatewayOp.VOICE_STATE_UPDATE, this.statePayload());
    this.emit();
  }

  /** Browser screen share (web app): the browser shows its own screen/window/tab picker. */
  async startDisplayShare(withAudio = false) {
    if (!this.channelId) return;
    if (this.screen) this.stopScreenShare();
    const q = this.quality();
    const [w, h] = RESOLUTIONS[q.resolution];
    try {
      this.screen = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: w }, height: { max: h }, frameRate: { max: q.fps } }, audio: withAudio });
    } catch {
      return; // cancelled in the browser picker
    }
    const video = this.screen.getVideoTracks()[0];
    video.contentHint = q.optimize === 'motion' ? 'motion' : 'detail';
    this.screenSource = null;
    video.onended = () => this.stopScreenShare();
    if (this.device) await this.produceScreen();
    sendGateway(GatewayOp.VOICE_STATE_UPDATE, this.statePayload());
    this.emit();
  }

  /** Applies new quality settings to a running screen share by updating the producer encodings. */
  async updateScreenQuality() {
    if (!this.screenProducer || !this.screen) return;
    const q = this.quality();
    try {
      await this.screenProducer.setRtpEncodingParameters({ maxBitrate: streamBitrate(q), maxFramerate: q.fps, scaleResolutionDownBy: 1 });
    } catch {
      /* keep current encoding */
    }
    this.emit();
  }

  stopScreenShare() {
    if (!this.screen) return;
    this.closeProducer(this.screenProducer);
    this.screenProducer = null;
    this.screen.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this.screenSource = null;
    if (this.channelId) sendGateway(GatewayOp.VOICE_STATE_UPDATE, this.statePayload());
    this.emit();
  }

  /* ───────────── voice states ───────────── */

  onVoiceState(state: VoiceState, prev?: VoiceState) {
    const meId = this.me?.id;
    if (!meId || !this.channelId) return;
    if (state.user_id === meId) {
      if (state.channel_id === this.channelId) {
        this.applyMicState();
        void this.initSfu();
      } else if (!state.channel_id && prev?.channel_id === this.channelId) {
        // Disconnected by a moderator.
        this.leave();
      } else if (state.channel_id && state.channel_id !== this.channelId) {
        // Moved by a moderator.
        this.teardownSfu();
        this.channelId = state.channel_id;
        this.guildId = state.guild_id ?? this.guildId;
        void this.initSfu();
        this.emit();
      }
      return;
    }
    // Remote join/leave only affects the UI (media is driven by SFU events).
    this.emit();
  }

  /* ───────────── speaking detection ───────────── */

  private ctx() {
    return (this.audioCtx ??= new AudioContext());
  }

  private watchSpeaking(userId: string, stream: MediaStream) {
    try {
      const src = this.ctx().createMediaStreamSource(stream);
      const analyser = this.ctx().createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.analysers.set(userId, { analyser, data: new Uint8Array(analyser.fftSize) });
    } catch {
      /* ignore */
    }
  }

  private startVad() {
    if (this.mic && this.me) this.watchSpeaking(this.me.id, this.mic);
    this.vadTimer = setInterval(() => {
      let changed = false;
      const threshold = this.settings()?.vad_threshold ?? -50;
      for (const [uid, { analyser, data }] of this.analysers) {
        analyser.getByteTimeDomainData(data as any);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        const db = 10 * Math.log10(sum / data.length + 1e-10);
        let speaking = db > threshold;
        if (uid === this.me?.id) {
          const ptt = this.settings().input_mode === 'ptt';
          speaking = speaking && !this.muted && (!ptt || this.pttDown);
        }
        if (speaking !== this.speaking.has(uid)) {
          speaking ? this.speaking.add(uid) : this.speaking.delete(uid);
          changed = true;
        }
      }
      if (changed) this.emit();
    }, 100);
  }

  private async statsRtt(source: { getStats: () => Promise<RTCStatsReport> }): Promise<number | null> {
    try {
      const stats = await source.getStats();
      let rtt: number | null = null;
      stats.forEach((s: any) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime != null) {
          rtt = Math.max(rtt ?? 0, Math.round(s.currentRoundTripTime * 1000));
        }
      });
      return rtt;
    } catch {
      return null;
    }
  }

  private startStats() {
    this.statsTimer = setInterval(async () => {
      const sources: { getStats: () => Promise<RTCStatsReport> }[] = [];
      if (this.sendTransport) sources.push(this.sendTransport);
      if (this.recvTransport) sources.push(this.recvTransport);
      let rtt: number | null = null;
      for (const s of sources) {
        const v = await this.statsRtt(s);
        if (v != null) rtt = Math.max(rtt ?? 0, v);
      }
      if (rtt !== this.ping) {
        this.ping = rtt;
        this.emit();
      }
    }, 3000);
  }

  /** Mic test for the Voice & Video settings page. Returns a stop function. */
  async testMic(onLevel: (db: number) => void): Promise<() => void> {
    const s = this.settings();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: s.input_device !== 'default' ? { exact: s.input_device } : undefined, echoCancellation: s.echo_cancellation, noiseSuppression: s.noise_suppression, autoGainControl: s.auto_gain },
    });
    const src = this.ctx().createMediaStreamSource(stream);
    const analyser = this.ctx().createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(data as any);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      onLevel(10 * Math.log10(sum / data.length + 1e-10));
    }, 50);
    return () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
    };
  }
}

export const voice = new VoiceManager();
