import type { WebSocket } from 'ws';
import {
  ChannelType, GatewayOp, MessageType, Permissions, hasPermission, type Activity, type DispatchEventName,
  type DispatchEvents, type GatewayPayload, type Presence, type PresenceStatus, type ReadyEvent, type Relationship,
  type RtcSignal, type SfuRequest, type VoiceState,
} from '@opencord/shared';
import type { Store } from '../store';
import { Sfu } from '../sfu';
import { randomToken, sha256, snowflake } from '../util';

const HEARTBEAT_INTERVAL = 41_250;
const RING_TIMEOUT = 60_000;

interface Session {
  id: string;
  ws: WebSocket;
  userId: string | null;
  seq: number;
  lastBeat: number;
  /** Host (without port) the client used to reach the server; the SFU's fallback announced address. */
  host: string | null;
}

interface CallState {
  channelId: string;
  messageId: string;
  startedAt: number;
  participants: Set<string>;
  ringing: Set<string>;
  ringTimer: NodeJS.Timeout | null;
}

export class Hub {
  private sessions = new Map<string, Session>();
  private byUser = new Map<string, Set<Session>>();
  private presences = new Map<string, { status: PresenceStatus; activities: Activity[] }>();
  readonly voiceStates = new Map<string, VoiceState>();
  private calls = new Map<string, CallState>();
  private reaper: NodeJS.Timeout;

  /** Voice changes in DMs/group DMs (the federation uses it to bridge calls with other hosts). */
  onPrivateVoice: ((userId: string, channelId: string, state: { channel_id: string | null; self_mute?: boolean; self_deaf?: boolean; self_video?: boolean; self_stream?: boolean }) => void) | null = null;

  constructor(private store: Store, private sfu: Sfu) {
    this.sfu.setEventSink((userId, event, data) => this.sendSfuEvent(userId, event, data));
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const s of this.sessions.values()) {
        if (now - s.lastBeat > HEARTBEAT_INTERVAL * 2.5) s.ws.terminate();
      }
    }, HEARTBEAT_INTERVAL);
    this.reaper.unref();
  }

  close() {
    clearInterval(this.reaper);
    for (const s of this.sessions.values()) s.ws.close(1001, 'Server shutting down');
  }

  /* ───────────── connection lifecycle ───────────── */

  attach(ws: WebSocket, host?: string | null) {
    const session: Session = { id: randomToken(16), ws, userId: null, seq: 0, lastBeat: Date.now(), host: host ?? null };
    this.sessions.set(session.id, session);
    this.send(session, { op: GatewayOp.HELLO, d: { heartbeat_interval: HEARTBEAT_INTERVAL } });

    const identifyTimeout = setTimeout(() => {
      if (!session.userId) ws.close(4003, 'Not authenticated');
    }, 15_000);

    ws.on('message', (raw) => {
      let msg: GatewayPayload<any>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(4002, 'Decode error');
        return;
      }
      try {
        this.handle(session, msg);
      } catch (e) {
        console.error('[gateway] handler error', e);
      }
    });
    ws.on('close', () => {
      clearTimeout(identifyTimeout);
      this.detach(session);
    });
    ws.on('error', () => {});
  }

  private handle(session: Session, msg: GatewayPayload<any>) {
    session.lastBeat = Date.now();
    switch (msg.op) {
      case GatewayOp.HEARTBEAT:
        this.send(session, { op: GatewayOp.HEARTBEAT_ACK, d: null });
        return;
      case GatewayOp.IDENTIFY:
        return this.identify(session, msg.d?.token);
    }
    if (!session.userId) {
      session.ws.close(4003, 'Not authenticated');
      return;
    }
    switch (msg.op) {
      case GatewayOp.PRESENCE_UPDATE:
        return this.updatePresence(session.userId, msg.d);
      case GatewayOp.VOICE_STATE_UPDATE:
        return this.updateVoiceState(session.userId, msg.d);
      case GatewayOp.RTC_SIGNAL:
        return this.relaySignal(session.userId, msg.d);
      case GatewayOp.SFU:
        return this.handleSfu(session, msg.d);
    }
  }

  private identify(session: Session, token: unknown) {
    if (typeof token !== 'string') return session.ws.close(4004, 'Authentication failed');
    const row = this.store.db
      .prepare('SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.disabled = 0')
      .get(sha256(token)) as any;
    if (!row) return session.ws.close(4004, 'Authentication failed');
    session.userId = row.user_id;
    const wasOnline = this.byUser.has(row.user_id);
    if (!wasOnline) this.byUser.set(row.user_id, new Set());
    this.byUser.get(row.user_id)!.add(session);
    this.dispatchTo(session, 'READY', this.buildReady(row.user_id, session.id));
    if (!wasOnline) {
      const u = this.store.userRow(row.user_id)!;
      this.presences.set(row.user_id, { status: this.store.settings(u).status, activities: [] });
      this.broadcastPresence(row.user_id);
    }
  }

  private detach(session: Session) {
    this.sessions.delete(session.id);
    if (!session.userId) return;
    const set = this.byUser.get(session.userId);
    if (!set) return;
    set.delete(session);
    if (set.size === 0) {
      this.byUser.delete(session.userId);
      this.presences.delete(session.userId);
      this.leaveVoice(session.userId);
      this.broadcastPresence(session.userId);
    }
  }

  /** Disconnects every gateway session for a user (used when their token is revoked or they are disabled). */
  kickUser(userId: string) {
    for (const s of this.byUser.get(userId) ?? []) s.ws.close(4004, 'Session invalidated');
  }

  isOnline(userId: string) {
    return this.byUser.has(userId);
  }

  /* ───────────── READY ───────────── */

  buildReady(userId: string, sessionId: string): ReadyEvent {
    const store = this.store;
    const row = store.userRow(userId)!;
    const guildIds = store.userGuildIds(userId);
    const guilds = guildIds.map((id) => {
      const g = store.guildFull(id);
      g.voice_states = [...this.voiceStates.values()].filter((v) => v.guild_id === id);
      g.online_count = g.members.filter((m) => this.publicStatus(m.user.id) !== 'offline').length;
      return g;
    });
    const privateChannels = store.privateChannels(userId);
    const relationships = this.relationships(userId);

    // Presences of everyone this user can see.
    const visible = new Set<string>();
    for (const g of guilds) for (const m of g.members) visible.add(m.user.id);
    for (const r of relationships) visible.add(r.id);
    for (const c of privateChannels) for (const u of c.recipients ?? []) visible.add(u.id);
    visible.delete(userId);
    const presences: Presence[] = [];
    for (const id of visible) {
      const p = this.presence(id);
      if (p.status !== 'offline') presences.push(p);
    }

    const readStates = (
      store.db.prepare('SELECT channel_id, last_message_id, mention_count FROM read_states WHERE user_id = ?').all(userId) as any[]
    ).map((r) => ({ channel_id: r.channel_id, last_message_id: r.last_message_id, mention_count: r.mention_count }));

    const dmIds = new Set(privateChannels.map((c) => c.id));
    const voiceStates = [...this.voiceStates.values()].filter((v) => v.channel_id && dmIds.has(v.channel_id));

    const notes: Record<string, string> = {};
    for (const n of store.db.prepare('SELECT target_id, note FROM notes WHERE user_id = ?').all(userId) as any[]) {
      notes[n.target_id] = n.note;
    }

    return {
      user: store.selfUser(row),
      session_id: sessionId,
      guilds,
      private_channels: privateChannels,
      relationships,
      presences,
      read_states: readStates,
      voice_states: voiceStates,
      notes,
    };
  }

  relationships(userId: string): Relationship[] {
    return (this.store.db.prepare('SELECT * FROM relationships WHERE user_id = ?').all(userId) as any[]).map((r) => ({
      id: r.other_id,
      type: r.type,
      user: this.store.user(r.other_id),
      nickname: r.nickname,
      since: r.since,
    }));
  }

  /* ───────────── presence ───────────── */

  publicStatus(userId: string): PresenceStatus {
    const p = this.presences.get(userId);
    if (!p || p.status === 'invisible') return 'offline';
    return p.status;
  }

  presence(userId: string): Presence {
    const row = this.store.userRow(userId);
    const status = this.publicStatus(userId);
    const settings = row ? this.store.settings(row) : null;
    let custom = settings?.custom_status ?? null;
    if (custom?.expires_at && custom.expires_at < Date.now()) custom = null;
    return {
      user_id: userId,
      status,
      custom_status: status === 'offline' || !custom ? null : { text: custom.text, emoji: custom.emoji },
      activities: status === 'offline' || settings?.show_activity === false ? [] : (this.presences.get(userId)?.activities ?? []),
    };
  }

  updatePresence(userId: string, d: { status?: PresenceStatus; activities?: Activity[] }) {
    const p = this.presences.get(userId);
    if (!p) return;
    if (d.status && ['online', 'idle', 'dnd', 'invisible'].includes(d.status)) {
      p.status = d.status;
      const row = this.store.userRow(userId)!;
      const s = { ...this.store.settings(row), status: d.status };
      this.store.db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(s), userId);
    }
    if (Array.isArray(d.activities)) p.activities = d.activities.slice(0, 5);
    this.broadcastPresence(userId);
    // Do Not Disturb silences calls that are ringing right now, too.
    if (p.status === 'dnd') {
      for (const call of this.calls.values()) {
        if (call.ringing.delete(userId)) this.toUsers(this.store.recipientIds(call.channelId), 'CALL_UPDATE', { channel_id: call.channelId, ringing: [...call.ringing] });
      }
    }
  }

  /** Users who share a guild, DM or friendship with `userId`. */
  audience(userId: string): Set<string> {
    const ids = new Set<string>();
    const db = this.store.db;
    for (const r of db
      .prepare(
        'SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = ?',
      )
      .all(userId) as any[])
      ids.add(r.user_id);
    for (const r of db.prepare('SELECT other_id FROM relationships WHERE user_id = ? AND type = 1').all(userId) as any[])
      ids.add(r.other_id);
    for (const r of db
      .prepare(
        'SELECT DISTINCT r2.user_id FROM channel_recipients r1 JOIN channel_recipients r2 ON r1.channel_id = r2.channel_id WHERE r1.user_id = ?',
      )
      .all(userId) as any[])
      ids.add(r.user_id);
    return ids;
  }

  broadcastPresence(userId: string) {
    const p = this.presence(userId);
    const aud = this.audience(userId);
    aud.delete(userId);
    this.toUsers(aud, 'PRESENCE_UPDATE', p);
    // The user's own sessions get their real status (incl. invisible).
    const own = this.presences.get(userId);
    if (own) this.toUsers([userId], 'PRESENCE_UPDATE', { ...p, status: own.status });
  }

  /** Re-broadcast the user object to everyone who can see it (after a profile edit). */
  broadcastUserUpdate(userId: string) {
    const row = this.store.userRow(userId);
    if (!row) return;
    const pub = this.store.publicUser(row);
    const aud = this.audience(userId);
    aud.delete(userId);
    this.toUsers(aud, 'USER_UPDATE', pub);
    this.toUsers([userId], 'USER_UPDATE', this.store.selfUser(row));
  }

  /* ───────────── dispatch ───────────── */

  private send(session: Session, payload: GatewayPayload) {
    if (session.ws.readyState === 1) session.ws.send(JSON.stringify(payload));
  }

  private dispatchTo<K extends DispatchEventName>(session: Session, t: K, d: DispatchEvents[K]) {
    session.seq++;
    this.send(session, { op: GatewayOp.DISPATCH, t, d, s: session.seq });
  }

  toUsers<K extends DispatchEventName>(userIds: Iterable<string>, t: K, d: DispatchEvents[K]) {
    for (const id of userIds) {
      for (const s of this.byUser.get(id) ?? []) this.dispatchTo(s, t, d);
    }
  }

  toGuild<K extends DispatchEventName>(guildId: string, t: K, d: DispatchEvents[K]) {
    this.toUsers(this.store.guildMemberIds(guildId), t, d);
  }

  /** Sends to everyone who can view a channel (recipients for DMs). */
  toChannel<K extends DispatchEventName>(channelId: string, t: K, d: DispatchEvents[K] | ((userId: string) => DispatchEvents[K])) {
    for (const uid of this.channelViewers(channelId)) {
      const payload = typeof d === 'function' ? (d as (u: string) => DispatchEvents[K])(uid) : d;
      this.toUsers([uid], t, payload);
    }
  }

  channelViewers(channelId: string): string[] {
    const ch = this.store.channelRow(channelId);
    if (!ch) return [];
    if (!ch.guild_id) return this.store.recipientIds(channelId);
    return this.store
      .guildMemberIds(ch.guild_id)
      .filter((uid) => this.byUser.has(uid) && hasPermission(this.store.channelPermissions(channelId, uid), Permissions.VIEW_CHANNEL));
  }

  /* ───────────── voice ───────────── */

  updateVoiceState(
    userId: string,
    d: { channel_id: string | null; self_mute?: boolean; self_deaf?: boolean; self_video?: boolean; self_stream?: boolean },
  ) {
    const prev = this.voiceStates.get(userId);
    const channelId = d.channel_id ?? null;

    if (!channelId) {
      this.leaveVoice(userId);
      return;
    }
    const ch = this.store.channelRow(channelId);
    if (!ch) return;
    const isPrivate = ch.type === ChannelType.DM || ch.type === ChannelType.GROUP_DM;
    if (!isPrivate && ch.type !== ChannelType.GUILD_VOICE && ch.type !== ChannelType.GUILD_STAGE) return;
    const perms = this.store.channelPermissions(channelId, userId);
    if (!hasPermission(perms, Permissions.CONNECT)) return;
    if (ch.type === ChannelType.DM && prev?.channel_id !== channelId) {
      const other = this.store.recipientIds(channelId).find((r) => r !== userId);
      if (other && this.blockedEitherWay(userId, other)) {
        this.toUsers([userId], 'VOICE_STATE_UPDATE', this.idleVoice(userId, channelId));
        return;
      }
    }

    if (prev?.channel_id && prev.channel_id !== channelId) this.leaveVoice(userId);

    if (!isPrivate && ch.user_limit > 0 && prev?.channel_id !== channelId) {
      const count = [...this.voiceStates.values()].filter((v) => v.channel_id === channelId).length;
      if (count >= ch.user_limit && !hasPermission(perms, Permissions.MOVE_MEMBERS)) return;
    }

    const member = ch.guild_id
      ? (this.store.db.prepare('SELECT mute, deaf FROM members WHERE guild_id = ? AND user_id = ?').get(ch.guild_id, userId) as any)
      : null;
    const state: VoiceState = {
      user_id: userId,
      channel_id: channelId,
      guild_id: ch.guild_id,
      self_mute: d.self_mute ?? prev?.self_mute ?? false,
      self_deaf: d.self_deaf ?? prev?.self_deaf ?? false,
      self_video: (d.self_video ?? prev?.self_video ?? false) && hasPermission(perms, Permissions.STREAM),
      self_stream: (d.self_stream ?? prev?.self_stream ?? false) && hasPermission(perms, Permissions.STREAM),
      mute: !!member?.mute || !hasPermission(perms, Permissions.SPEAK),
      deaf: !!member?.deaf,
    };
    this.voiceStates.set(userId, state);
    this.broadcastVoice(state);
    if (isPrivate && prev?.channel_id !== channelId) this.joinCall(userId, channelId);
    if (isPrivate) this.onPrivateVoice?.(userId, channelId, state);
  }

  leaveVoice(userId: string) {
    const prev = this.voiceStates.get(userId);
    if (!prev?.channel_id) return;
    this.voiceStates.delete(userId);
    this.broadcastVoice({ ...prev, channel_id: null }, prev.channel_id);
    void this.sfu.leave(prev.channel_id, userId);
    if (!prev.guild_id) this.onPrivateVoice?.(userId, prev.channel_id, { channel_id: null });
    const call = this.calls.get(prev.channel_id);
    if (call) {
      call.participants.delete(userId);
      const stillIn = [...this.voiceStates.values()].some((v) => v.channel_id === prev.channel_id);
      if (!stillIn) this.endCall(call);
    }
  }

  /** Server-side mute/deafen or disconnect by a moderator. */
  refreshVoiceState(userId: string) {
    const v = this.voiceStates.get(userId);
    if (v?.channel_id) this.updateVoiceState(userId, { channel_id: v.channel_id });
  }

  /** `routeChannel` is the channel the state belonged to (needed when leaving, since channel_id is then null). */
  private broadcastVoice(state: VoiceState, routeChannel = state.channel_id) {
    if (state.guild_id) this.toGuild(state.guild_id, 'VOICE_STATE_UPDATE', state);
    else if (routeChannel) this.toUsers(this.store.recipientIds(routeChannel), 'VOICE_STATE_UPDATE', state);
  }

  private joinCall(userId: string, channelId: string) {
    let call = this.calls.get(channelId);
    const recipients = this.store.recipientIds(channelId);
    if (!call) {
      const messageId = snowflake();
      const now = Date.now();
      this.store.db
        .prepare(
          'INSERT INTO messages (id, channel_id, guild_id, author_id, content, type, created_at, call) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(messageId, channelId, null, userId, '', MessageType.CALL, now, JSON.stringify({ participants: [userId], ended_at: null }));
      this.store.db.prepare('UPDATE channels SET last_message_id = ? WHERE id = ?').run(messageId, channelId);
      this.store.db.prepare('UPDATE channel_recipients SET closed = 0 WHERE channel_id = ?').run(channelId);
      call = {
        channelId,
        messageId,
        startedAt: now,
        participants: new Set([userId]),
        ringing: new Set(recipients.filter((r) => r !== userId && this.shouldRing(userId, r))),
        ringTimer: null,
      };
      this.calls.set(channelId, call);
      call.ringTimer = setTimeout(() => {
        call!.ringing.clear();
        this.toUsers(recipients, 'CALL_UPDATE', { channel_id: channelId, ringing: [] });
      }, RING_TIMEOUT);
      this.toUsers(recipients, 'CALL_CREATE', { channel_id: channelId, ringing: [...call.ringing], message_id: messageId });
      const msg = this.store.message(this.store.messageRow(messageId), userId);
      this.toUsers(recipients, 'MESSAGE_CREATE', msg);
    } else {
      call.participants.add(userId);
      call.ringing.delete(userId);
      const row = this.store.messageRow(call.messageId);
      const data = JSON.parse(row.call);
      if (!data.participants.includes(userId)) data.participants.push(userId);
      this.store.db.prepare('UPDATE messages SET call = ? WHERE id = ?').run(JSON.stringify(data), call.messageId);
      this.toUsers(recipients, 'CALL_UPDATE', { channel_id: channelId, ringing: [...call.ringing] });
    }
  }

  /** Starts (or stops) ringing recipients of a call. `byUserId` is who asked; rings follow `shouldRing`. */
  ring(channelId: string, userIds: string[] | null, stop: boolean, byUserId?: string) {
    const call = this.calls.get(channelId);
    if (!call) return;
    const recipients = this.store.recipientIds(channelId);
    const targets = (userIds ?? recipients.filter((r) => !call.participants.has(r))).filter((t) => recipients.includes(t));
    for (const t of targets) {
      if (stop) call.ringing.delete(t);
      else if (!call.participants.has(t) && (!byUserId || this.shouldRing(byUserId, t))) call.ringing.add(t);
    }
    this.toUsers(recipients, 'CALL_UPDATE', { channel_id: channelId, ringing: [...call.ringing] });
  }

  /**
   * Whether `callee` gets a ringing call popup and sound from `caller`. Anyone can still join a
   * DM call; only friends ring, and never across a block or while the callee is in Do Not Disturb.
   */
  shouldRing(caller: string, callee: string) {
    if (this.blockedEitherWay(caller, callee)) return false;
    const friends = this.store.db.prepare('SELECT 1 FROM relationships WHERE user_id = ? AND other_id = ? AND type = 1').get(callee, caller);
    if (!friends) return false;
    const status = this.presences.get(callee)?.status ?? this.storedStatus(callee);
    return status !== 'dnd';
  }

  /** After `blocker` blocks `blocked`: stop rings between them and end their 1:1 DM call. */
  onBlock(blocker: string, blocked: string) {
    for (const call of [...this.calls.values()]) {
      const recipients = this.store.recipientIds(call.channelId);
      if (!recipients.includes(blocker) || !recipients.includes(blocked)) continue;
      const changed = call.ringing.delete(blocker) || call.ringing.delete(blocked);
      if (changed) this.toUsers(recipients, 'CALL_UPDATE', { channel_id: call.channelId, ringing: [...call.ringing] });
      if (this.store.channelRow(call.channelId)?.type === ChannelType.DM) {
        if (this.voiceStates.get(blocked)?.channel_id === call.channelId) this.leaveVoice(blocked);
        if (this.voiceStates.get(blocker)?.channel_id === call.channelId) this.leaveVoice(blocker);
      }
    }
  }

  blockedEitherWay(a: string, b: string) {
    return !!this.store.db
      .prepare('SELECT 1 FROM relationships WHERE type = 2 AND ((user_id = ? AND other_id = ?) OR (user_id = ? AND other_id = ?))')
      .get(a, b, b, a);
  }

  private storedStatus(userId: string): PresenceStatus | null {
    const row = this.store.userRow(userId);
    return row ? this.store.settings(row).status : null;
  }

  /** A "not in voice" state, sent to a client whose join was refused so it stops trying. */
  private idleVoice(userId: string, channelId: string): VoiceState {
    return { user_id: userId, channel_id: null, guild_id: null, self_mute: false, self_deaf: false, self_video: false, self_stream: false, mute: false, deaf: false, refused_channel_id: channelId };
  }

  private endCall(call: CallState) {
    if (call.ringTimer) clearTimeout(call.ringTimer);
    this.calls.delete(call.channelId);
    const row = this.store.messageRow(call.messageId);
    if (row) {
      const data = JSON.parse(row.call);
      data.ended_at = Date.now();
      this.store.db.prepare('UPDATE messages SET call = ? WHERE id = ?').run(JSON.stringify(data), call.messageId);
      const recipients = this.store.recipientIds(call.channelId);
      for (const r of recipients) this.toUsers([r], 'MESSAGE_UPDATE', this.store.message(this.store.messageRow(call.messageId), r));
      this.toUsers(recipients, 'CALL_DELETE', { channel_id: call.channelId });
    }
  }

  private relaySignal(fromId: string, d: RtcSignal) {
    if (!d || typeof d.to !== 'string' || typeof d.channel_id !== 'string') return;
    const mine = this.voiceStates.get(fromId);
    const theirs = this.voiceStates.get(d.to);
    // Only peers in the same voice channel may exchange signaling.
    if (d.kind !== 'hangup' && (mine?.channel_id !== d.channel_id || theirs?.channel_id !== d.channel_id)) return;
    for (const s of this.byUser.get(d.to) ?? []) {
      this.send(s, { op: GatewayOp.RTC_SIGNAL, d: { ...d, from: fromId } });
    }
  }

  /* ───────────── SFU (mediasoup) ───────────── */

  private sendSfuEvent(userId: string, event: string, data?: unknown) {
    for (const s of this.byUser.get(userId) ?? []) this.send(s, { op: GatewayOp.SFU, d: { event, data } });
  }

  private handleSfu(session: Session, d: unknown) {
    const userId = session.userId!;
    const req = d as SfuRequest;
    if (!req || typeof req.id !== 'number' || typeof req.method !== 'string') return;
    const channelId = this.voiceStates.get(userId)?.channel_id ?? null;
    const reply = (ok: boolean, data?: unknown, error?: string) => {
      for (const s of this.byUser.get(userId) ?? []) this.send(s, { op: GatewayOp.SFU, d: { id: req.id, ok, data, error } });
    };
    void (async () => {
      try {
        switch (req.method) {
          case 'getRouterRtpCapabilities':
            return reply(true, this.sfu.routerRtpCapabilities);
          case 'join': {
            if (!channelId) throw new Error('Not in a voice channel');
            return reply(true, await this.sfu.join(channelId, userId, session.host));
          }
          case 'connectTransport': {
            if (!channelId) throw new Error('Not in a voice channel');
            await this.sfu.connectTransport(channelId, userId, (req.data as any)?.transportId, (req.data as any)?.dtlsParameters);
            return reply(true, {});
          }
          case 'produce': {
            if (!channelId) throw new Error('Not in a voice channel');
            const { id } = await this.sfu.produce(channelId, userId, req.data as any);
            return reply(true, { id });
          }
          case 'consume': {
            if (!channelId) throw new Error('Not in a voice channel');
            return reply(true, await this.sfu.consume(channelId, userId, req.data as any));
          }
          case 'closeProducer': {
            if (channelId) this.sfu.closeProducer(channelId, userId, (req.data as any)?.producerId);
            return reply(true, {});
          }
          case 'leave': {
            if (channelId) await this.sfu.leave(channelId, userId);
            return reply(true, {});
          }
          default:
            return reply(false, undefined, `Unknown SFU method: ${req.method}`);
        }
      } catch (e) {
        reply(false, undefined, (e as Error).message);
      }
    })();
  }
}
