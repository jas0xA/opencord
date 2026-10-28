import type { PermissionOverwrite } from './permissions';

export type Snowflake = string;

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';

export interface ProfileCosmetics {
  avatar_decoration: string | null; // marketplace item id
  profile_effect: string | null;
  nameplate: string | null;
  display_name_style: { font: string; effect: string; colors: string[] } | null;
}

export interface PublicUser extends ProfileCosmetics {
  id: Snowflake;
  username: string;
  display_name: string | null;
  avatar: string | null; // upload hash / path
  banner: string | null;
  banner_color: string | null;
  accent_color: string | null;
  theme_colors: [string, string] | null; // profile theme gradient
  pronouns: string;
  bio: string;
  badges: string[];
  bot: boolean;
  created_at: number;
}

export interface Connection {
  type: string; // github, x, steam, ...
  name: string;
  url: string | null;
  verified: boolean;
  visible: boolean;
  show_details: boolean;
  metadata: Record<string, string>;
}

export interface UserSettings {
  theme: 'dark' | 'light' | 'ash' | 'onyx' | 'sync';
  message_display: 'cozy' | 'compact';
  zoom: number;
  font_scale: number;
  locale: string;
  time_24h: boolean;
  developer_mode: boolean;
  reduced_motion: boolean;
  saturation: number;
  underline_links: boolean;
  role_colors: 'name' | 'dot' | 'hidden';
  allow_dms_from_guild_members: boolean;
  friend_requests_from: { everyone: boolean; friends_of_friends: boolean; server_members: boolean };
  explicit_filter: 'all' | 'friends' | 'none';
  show_activity: boolean;
  desktop_notifications: boolean;
  notification_sounds: boolean;
  unread_badge: boolean;
  input_device: string;
  output_device: string;
  video_device: string;
  input_volume: number;
  output_volume: number;
  input_mode: 'vad' | 'ptt';
  ptt_key: string;
  vad_threshold: number;
  echo_cancellation: boolean;
  noise_suppression: boolean;
  auto_gain: boolean;
  keybinds: { action: string; keys: string }[];
  /** Screen share quality: vertical resolution, frames per second, and what to keep when bandwidth is tight. */
  stream_resolution: 720 | 1080 | 1440 | 2160;
  stream_fps: 15 | 30 | 60;
  stream_optimize: 'motion' | 'detail';
  guild_folders: { id: string; name: string | null; color: string | null; guild_ids: Snowflake[] }[];
  guild_positions: Snowflake[];
  custom_status: { text: string; emoji: string | null; expires_at: number | null } | null;
  status: PresenceStatus;
  /** Per-user choices that only affect what you see and hear, keyed by user id. */
  user_overrides: Record<Snowflake, UserOverride>;
}

export interface UserOverride {
  /** How loud you hear them in calls and voice channels, in percent (0-200, default 100). */
  volume?: number;
  /** You don't hear them at all in calls and voice channels. */
  mute_voice?: boolean;
  /** Their messages are collapsed and never notify you. */
  mute_messages?: boolean;
}

export interface SelfUser extends PublicUser {
  email: string;
  mfa_enabled: boolean;
  admin: boolean;
  settings: UserSettings;
  connections: Connection[];
  inventory: string[]; // claimed marketplace item ids
}

export interface Presence {
  user_id: Snowflake;
  status: PresenceStatus;
  custom_status: { text: string; emoji: string | null } | null;
  activities: Activity[];
}

export interface Activity {
  type: 0 | 1 | 2 | 3 | 5; // playing, streaming, listening, watching, competing
  name: string;
  details?: string;
  state?: string;
  started_at?: number;
}

export const RelationshipType = {
  FRIEND: 1,
  BLOCKED: 2,
  INCOMING: 3,
  OUTGOING: 4,
} as const;
export type RelationshipTypeValue = (typeof RelationshipType)[keyof typeof RelationshipType];

export interface Relationship {
  id: Snowflake; // other user's id
  type: RelationshipTypeValue;
  user: PublicUser;
  nickname: string | null;
  since: number;
}

export const ChannelType = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  GUILD_STAGE: 13,
  GUILD_FORUM: 15,
} as const;
export type ChannelTypeValue = (typeof ChannelType)[keyof typeof ChannelType];

export interface Channel {
  id: Snowflake;
  type: ChannelTypeValue;
  guild_id: Snowflake | null;
  parent_id: Snowflake | null;
  name: string | null;
  topic: string | null;
  position: number;
  nsfw: boolean;
  rate_limit_per_user: number;
  bitrate: number;
  user_limit: number;
  icon: string | null;
  owner_id: Snowflake | null; // group dm owner
  permission_overwrites: PermissionOverwrite[];
  recipients?: PublicUser[]; // dm / group dm
  last_message_id: Snowflake | null;
}

export interface Attachment {
  id: Snowflake;
  filename: string;
  url: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
}

export interface Embed {
  type: 'link' | 'image' | 'video' | 'rich';
  url?: string;
  title?: string;
  description?: string;
  site_name?: string;
  color?: string;
  image?: { url: string; width?: number; height?: number };
  thumbnail?: { url: string; width?: number; height?: number };
}

export interface Reaction {
  emoji: { id: Snowflake | null; name: string; animated?: boolean };
  count: number;
  me: boolean;
}

export const MessageType = {
  DEFAULT: 0,
  RECIPIENT_ADD: 1,
  RECIPIENT_REMOVE: 2,
  CALL: 3,
  CHANNEL_NAME_CHANGE: 4,
  CHANNEL_ICON_CHANGE: 5,
  CHANNEL_PINNED_MESSAGE: 6,
  GUILD_MEMBER_JOIN: 7,
  REPLY: 19,
  AUTO_MODERATION_ACTION: 24,
} as const;
export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

export interface Message {
  id: Snowflake;
  channel_id: Snowflake;
  guild_id: Snowflake | null;
  author: PublicUser;
  member?: { nick: string | null; roles: Snowflake[] } | null;
  content: string;
  type: MessageTypeValue;
  created_at: number;
  edited_at: number | null;
  pinned: boolean;
  mention_everyone: boolean;
  mentions: Snowflake[];
  mention_roles: Snowflake[];
  attachments: Attachment[];
  embeds: Embed[];
  reactions: Reaction[];
  sticker_ids: Snowflake[];
  referenced_message: Message | null;
  message_reference: { message_id: Snowflake; channel_id: Snowflake } | null;
  call: { participants: Snowflake[]; ended_at: number | null } | null;
  webhook_id: Snowflake | null;
  nonce?: string;
}

export interface Role {
  id: Snowflake;
  guild_id: Snowflake;
  name: string;
  color: string | null;
  hoist: boolean;
  icon: string | null;
  position: number;
  permissions: string;
  mentionable: boolean;
  managed: boolean;
}

export interface GuildMember {
  guild_id: Snowflake;
  user: PublicUser;
  nick: string | null;
  avatar: string | null;
  roles: Snowflake[];
  joined_at: number;
  communication_disabled_until: number | null;
  mute: boolean;
  deaf: boolean;
}

export interface Emoji {
  id: Snowflake;
  guild_id: Snowflake;
  name: string;
  animated: boolean;
  url: string;
  creator_id: Snowflake | null;
}

export interface Sticker {
  id: Snowflake;
  guild_id: Snowflake;
  name: string;
  description: string;
  tags: string;
  url: string;
  format: 'png' | 'apng' | 'gif' | 'webp';
}

export interface SoundboardSound {
  id: Snowflake;
  guild_id: Snowflake;
  name: string;
  emoji: string | null;
  volume: number;
  url: string;
}

export interface Guild {
  id: Snowflake;
  name: string;
  icon: string | null;
  banner: string | null;
  banner_preset: number; // index into BANNER_PRESETS when banner is null
  description: string;
  owner_id: Snowflake;
  traits: { emoji: string | null; label: string }[];
  tag: { text: string; badge: number; color: string } | null;
  system_channel_id: Snowflake | null;
  rules_channel_id: Snowflake | null;
  afk_channel_id: Snowflake | null;
  afk_timeout: number;
  verification_level: 0 | 1 | 2 | 3 | 4;
  explicit_content_filter: 0 | 1 | 2;
  default_notifications: 0 | 1;
  features: string[]; // COMMUNITY, DISCOVERABLE, INVITES_DISABLED, ...
  vanity_code: string | null;
  member_count: number;
  online_count?: number;
  created_at: number;
}

/** Full guild payload as sent in READY / GUILD_CREATE. */
export interface GuildFull extends Guild {
  channels: Channel[];
  roles: Role[];
  members: GuildMember[];
  emojis: Emoji[];
  stickers: Sticker[];
  sounds: SoundboardSound[];
  voice_states: VoiceState[];
}

export interface Invite {
  code: string;
  guild: Pick<Guild, 'id' | 'name' | 'icon' | 'banner' | 'banner_preset' | 'description' | 'created_at'> & {
    member_count: number;
    online_count: number;
  };
  channel: Pick<Channel, 'id' | 'name' | 'type'>;
  inviter: PublicUser | null;
  uses: number;
  max_uses: number;
  max_age: number;
  temporary: boolean;
  created_at: number;
  expires_at: number | null;
}

export interface Ban {
  user: PublicUser;
  reason: string | null;
  created_at: number;
}

export interface AuditLogEntry {
  id: Snowflake;
  guild_id: Snowflake;
  user_id: Snowflake;
  target_id: Snowflake | null;
  action: string; // e.g. MEMBER_KICK, CHANNEL_CREATE
  changes: { key: string; old?: unknown; new?: unknown }[];
  reason: string | null;
  created_at: number;
}

export type AutoModTrigger = 'keyword' | 'spam' | 'mention_spam' | 'link';
export interface AutoModRule {
  id: Snowflake;
  guild_id: Snowflake;
  name: string;
  enabled: boolean;
  trigger: AutoModTrigger;
  keywords: string[];
  allow_list: string[];
  mention_limit: number;
  actions: { type: 'block' | 'alert' | 'timeout'; channel_id?: Snowflake; duration?: number; message?: string }[];
  exempt_roles: Snowflake[];
  exempt_channels: Snowflake[];
}

export interface Webhook {
  id: Snowflake;
  guild_id: Snowflake;
  channel_id: Snowflake;
  name: string;
  avatar: string | null;
  token?: string;
  creator: PublicUser | null;
  created_at: number;
}

export interface VoiceState {
  user_id: Snowflake;
  channel_id: Snowflake | null; // guild voice channel or dm/group dm channel
  guild_id: Snowflake | null;
  self_mute: boolean;
  self_deaf: boolean;
  self_video: boolean;
  self_stream: boolean;
  mute: boolean;
  deaf: boolean;
  /** Set on a state sent only to you when the server refused to let you join this channel (e.g. a block). */
  refused_channel_id?: Snowflake;
}

export interface ReadState {
  channel_id: Snowflake;
  last_message_id: Snowflake | null;
  mention_count: number;
}

export type MarketplaceCategory =
  | 'avatar_decoration'
  | 'profile_effect'
  | 'nameplate'
  | 'banner'
  | 'profile_theme';

export interface MarketplaceItem {
  id: Snowflake;
  category: MarketplaceCategory;
  name: string;
  description: string;
  asset: string; // url of image (apng/webp/gif/png/svg)
  preview: string | null;
  colors: string[] | null; // profile theme colors
  official: boolean;
  author: PublicUser | null;
  status: 'approved' | 'pending' | 'rejected';
  likes: number;
  liked: boolean;
  owners: number;
  tags: string[];
  created_at: number;
  /** private: only the author can see and use it · public: listed in the Community tab. */
  visibility?: 'private' | 'public' | 'imported';
  /** False: others may use it, but the design can't be re-published by someone else. */
  allow_copy?: boolean;
  /** Listed on the global OpenCord network. */
  global?: boolean;
  /** "<host>|<id>" for items imported from another host. */
  origin?: string | null;
}

export interface InstanceInfo {
  name: string;
  description: string;
  version: string;
  registration: 'open' | 'invite_only' | 'allowlist' | 'closed';
  require_email_verification: boolean;
  max_upload_mb: number;
  community_marketplace: boolean;
  connections: string[]; // providers configured with OAuth
  voice: { ice_servers: { urls: string | string[]; username?: string; credential?: string }[] };
  web?: { enabled: boolean; android_apk: boolean };
  /** Part of the global OpenCord network. */
  network?: boolean;
}
