import type {
  Channel, GuildFull, Guild, GuildMember, Message, Presence, PublicUser, ReadState, Relationship,
  Role, SelfUser, VoiceState, Emoji, Sticker, SoundboardSound, MarketplaceItem, UserSettings,
} from './types';

export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  /** WebRTC signaling relayed peer to peer through the server. */
  RTC_SIGNAL: 20,
  /** SFU (mediasoup) signaling: request/response plus server-initiated events. */
  SFU: 21,
} as const;

export interface GatewayPayload<T = unknown> {
  op: number;
  d: T;
  s?: number | null;
  t?: string | null;
}

export interface ReadyEvent {
  user: SelfUser;
  session_id: string;
  guilds: GuildFull[];
  private_channels: Channel[];
  relationships: Relationship[];
  presences: Presence[];
  read_states: ReadState[];
  voice_states: VoiceState[]; // dm call voice states
  notes: Record<string, string>;
}

export interface RtcSignal {
  to: string; // user id
  from?: string; // filled in by server
  channel_id: string;
  kind: 'offer' | 'answer' | 'candidate' | 'hangup' | 'meta';
  data: unknown;
}

/** Client → server SFU request over the gateway. */
export interface SfuRequest {
  id: number;
  method: string;
  data?: unknown;
}

/** Server → client SFU response to a {@link SfuRequest}. */
export interface SfuResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Server → client SFU event (unsolicited). */
export interface SfuEvent {
  event: 'newProducer' | 'producerClosed' | 'peerLeft';
  data?: unknown;
}

/** Map of every dispatch event name to its payload type. */
export interface DispatchEvents {
  READY: ReadyEvent;
  USER_UPDATE: SelfUser | PublicUser;
  USER_SETTINGS_UPDATE: Partial<UserSettings>;
  RELATIONSHIP_ADD: Relationship;
  RELATIONSHIP_REMOVE: { id: string; type: number };
  PRESENCE_UPDATE: Presence;
  CHANNEL_CREATE: Channel;
  CHANNEL_UPDATE: Channel;
  CHANNEL_DELETE: Channel;
  CHANNEL_RECIPIENT_ADD: { channel_id: string; user: PublicUser };
  CHANNEL_RECIPIENT_REMOVE: { channel_id: string; user: PublicUser };
  CHANNEL_PINS_UPDATE: { channel_id: string };
  GUILD_CREATE: GuildFull;
  GUILD_UPDATE: Guild;
  GUILD_DELETE: { id: string; unavailable?: boolean };
  GUILD_MEMBER_ADD: GuildMember;
  GUILD_MEMBER_UPDATE: GuildMember;
  GUILD_MEMBER_REMOVE: { guild_id: string; user: PublicUser };
  GUILD_BAN_ADD: { guild_id: string; user: PublicUser };
  GUILD_BAN_REMOVE: { guild_id: string; user: PublicUser };
  GUILD_ROLE_CREATE: { guild_id: string; role: Role };
  GUILD_ROLE_UPDATE: { guild_id: string; role: Role };
  GUILD_ROLE_DELETE: { guild_id: string; role_id: string };
  GUILD_EMOJIS_UPDATE: { guild_id: string; emojis: Emoji[] };
  GUILD_STICKERS_UPDATE: { guild_id: string; stickers: Sticker[] };
  GUILD_SOUNDBOARD_UPDATE: { guild_id: string; sounds: SoundboardSound[] };
  MESSAGE_CREATE: Message;
  MESSAGE_UPDATE: Message;
  MESSAGE_DELETE: { id: string; channel_id: string; guild_id: string | null };
  MESSAGE_DELETE_BULK: { ids: string[]; channel_id: string; guild_id: string | null };
  MESSAGE_REACTION_ADD: { message_id: string; channel_id: string; user_id: string; emoji: { id: string | null; name: string } };
  MESSAGE_REACTION_REMOVE: { message_id: string; channel_id: string; user_id: string; emoji: { id: string | null; name: string } };
  MESSAGE_ACK: { channel_id: string; message_id: string };
  TYPING_START: { channel_id: string; user_id: string; guild_id: string | null; timestamp: number };
  VOICE_STATE_UPDATE: VoiceState;
  CALL_CREATE: { channel_id: string; ringing: string[]; message_id: string };
  CALL_UPDATE: { channel_id: string; ringing: string[] };
  CALL_DELETE: { channel_id: string };
  MARKETPLACE_ITEM_CREATE: MarketplaceItem;
  MARKETPLACE_ITEM_UPDATE: MarketplaceItem;
  MARKETPLACE_ITEM_DELETE: { id: string };
  SOUNDBOARD_PLAY: { guild_id: string; channel_id: string; user_id: string; sound_id: string };
}
export type DispatchEventName = keyof DispatchEvents;
