// Permission bitfield. Values are bigints, serialized over the wire as decimal strings.
export const Permissions = {
  CREATE_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_EXPRESSIONS: 1n << 30n,
  MANAGE_EVENTS: 1n << 33n,
  MANAGE_THREADS: 1n << 34n,
  USE_EXTERNAL_STICKERS: 1n << 37n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  MODERATE_MEMBERS: 1n << 40n,
  USE_SOUNDBOARD: 1n << 42n,
  SEND_VOICE_MESSAGES: 1n << 46n,
  PIN_MESSAGES: 1n << 51n,
} as const;

export type PermissionName = keyof typeof Permissions;

export const ALL_PERMISSIONS = Object.values(Permissions).reduce((a, b) => a | b, 0n);

export const DEFAULT_EVERYONE_PERMISSIONS =
  Permissions.CREATE_INVITE |
  Permissions.ADD_REACTIONS |
  Permissions.STREAM |
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.EMBED_LINKS |
  Permissions.ATTACH_FILES |
  Permissions.READ_MESSAGE_HISTORY |
  Permissions.USE_EXTERNAL_EMOJIS |
  Permissions.CONNECT |
  Permissions.SPEAK |
  Permissions.USE_VAD |
  Permissions.CHANGE_NICKNAME |
  Permissions.USE_EXTERNAL_STICKERS |
  Permissions.SEND_MESSAGES_IN_THREADS |
  Permissions.USE_SOUNDBOARD |
  Permissions.SEND_VOICE_MESSAGES;

export interface PermissionOverwrite {
  id: string; // role id or user id
  type: 0 | 1; // 0 = role, 1 = member
  allow: string;
  deny: string;
}

export function hasPermission(perms: bigint, flag: bigint): boolean {
  if ((perms & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) return true;
  return (perms & flag) === flag;
}

/**
 * Computes a member's base guild permissions from the roles they hold.
 * `everyoneRoleId` equals the guild id.
 */
export function computeBasePermissions(opts: {
  isOwner: boolean;
  everyonePerms: bigint;
  memberRolePerms: bigint[];
}): bigint {
  if (opts.isOwner) return ALL_PERMISSIONS;
  let perms = opts.everyonePerms;
  for (const p of opts.memberRolePerms) perms |= p;
  if ((perms & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) return ALL_PERMISSIONS;
  return perms;
}

/** Applies channel overwrites following the standard everyone → roles → member order. */
export function applyOverwrites(opts: {
  base: bigint;
  guildId: string;
  userId: string;
  roleIds: string[];
  overwrites: PermissionOverwrite[];
}): bigint {
  const { base, guildId, userId, roleIds, overwrites } = opts;
  if ((base & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) return ALL_PERMISSIONS;
  // Administrator is a role-level permission: an overwrite can never grant it.
  const grant = (o: PermissionOverwrite) => BigInt(o.allow) & ~Permissions.ADMINISTRATOR;
  let perms = base;
  const everyone = overwrites.find((o) => o.type === 0 && o.id === guildId);
  if (everyone) {
    perms &= ~BigInt(everyone.deny);
    perms |= grant(everyone);
  }
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guildId && roleIds.includes(o.id)) {
      allow |= grant(o);
      deny |= BigInt(o.deny);
    }
  }
  perms &= ~deny;
  perms |= allow;
  const member = overwrites.find((o) => o.type === 1 && o.id === userId);
  if (member) {
    perms &= ~BigInt(member.deny);
    perms |= grant(member);
  }
  // Without VIEW_CHANNEL nothing else in the channel applies.
  if ((perms & Permissions.VIEW_CHANNEL) === 0n) return 0n;
  return perms;
}

export const PERMISSION_INFO: { key: PermissionName; label: string; description: string; group: string }[] = [
  { key: 'VIEW_CHANNEL', label: 'View Channels', description: 'Allows members to view channels by default (excluding private channels).', group: 'General Server Permissions' },
  { key: 'MANAGE_CHANNELS', label: 'Manage Channels', description: 'Allows members to create, edit, or delete channels.', group: 'General Server Permissions' },
  { key: 'MANAGE_ROLES', label: 'Manage Roles', description: 'Allows members to create new roles and edit or delete roles lower than their highest role.', group: 'General Server Permissions' },
  { key: 'MANAGE_EXPRESSIONS', label: 'Manage Expressions', description: 'Allows members to add or remove custom emoji, stickers, and sounds in this server.', group: 'General Server Permissions' },
  { key: 'VIEW_AUDIT_LOG', label: 'View Audit Log', description: 'Allows members to view a record of who made which changes in this server.', group: 'General Server Permissions' },
  { key: 'MANAGE_WEBHOOKS', label: 'Manage Webhooks', description: 'Allows members to create, edit, or delete webhooks.', group: 'General Server Permissions' },
  { key: 'MANAGE_GUILD', label: 'Manage Server', description: "Allows members to change this server's name, description, icon and banner.", group: 'General Server Permissions' },
  { key: 'CREATE_INVITE', label: 'Create Invite', description: 'Allows members to invite new people to this server.', group: 'Membership Permissions' },
  { key: 'CHANGE_NICKNAME', label: 'Change Nickname', description: 'Allows members to change their own nickname.', group: 'Membership Permissions' },
  { key: 'MANAGE_NICKNAMES', label: 'Manage Nicknames', description: 'Allows members to change the nicknames of other members.', group: 'Membership Permissions' },
  { key: 'KICK_MEMBERS', label: 'Kick Members', description: 'Allows members to remove other members from this server.', group: 'Membership Permissions' },
  { key: 'BAN_MEMBERS', label: 'Ban Members', description: 'Allows members to permanently ban and delete the message history of other members.', group: 'Membership Permissions' },
  { key: 'MODERATE_MEMBERS', label: 'Timeout Members', description: 'Allows members to temporarily prevent other users from interacting with the server.', group: 'Membership Permissions' },
  { key: 'SEND_MESSAGES', label: 'Send Messages', description: 'Allows members to send messages in text channels.', group: 'Text Channel Permissions' },
  { key: 'SEND_MESSAGES_IN_THREADS', label: 'Send Messages in Threads', description: 'Allows members to send messages in threads.', group: 'Text Channel Permissions' },
  { key: 'EMBED_LINKS', label: 'Embed Links', description: 'Allows links that members share to show embedded content.', group: 'Text Channel Permissions' },
  { key: 'ATTACH_FILES', label: 'Attach Files', description: 'Allows members to upload files or media.', group: 'Text Channel Permissions' },
  { key: 'ADD_REACTIONS', label: 'Add Reactions', description: 'Allows members to add new emoji reactions to a message.', group: 'Text Channel Permissions' },
  { key: 'USE_EXTERNAL_EMOJIS', label: 'Use External Emoji', description: 'Allows members to use emoji from other servers.', group: 'Text Channel Permissions' },
  { key: 'USE_EXTERNAL_STICKERS', label: 'Use External Stickers', description: 'Allows members to use stickers from other servers.', group: 'Text Channel Permissions' },
  { key: 'MENTION_EVERYONE', label: 'Mention @everyone, @here, and All Roles', description: 'Allows members to use @everyone or @here.', group: 'Text Channel Permissions' },
  { key: 'MANAGE_MESSAGES', label: 'Manage Messages', description: 'Allows members to delete messages by other members.', group: 'Text Channel Permissions' },
  { key: 'PIN_MESSAGES', label: 'Pin Messages', description: 'Allows members to pin or unpin any message.', group: 'Text Channel Permissions' },
  { key: 'MANAGE_THREADS', label: 'Manage Threads', description: 'Allows members to rename, delete, close and turn on slow mode for threads.', group: 'Text Channel Permissions' },
  { key: 'READ_MESSAGE_HISTORY', label: 'Read Message History', description: 'Allows members to read previous messages sent in channels.', group: 'Text Channel Permissions' },
  { key: 'SEND_VOICE_MESSAGES', label: 'Send Voice Messages', description: 'Allows members to send voice messages.', group: 'Text Channel Permissions' },
  { key: 'CONNECT', label: 'Connect', description: 'Allows members to join voice channels and hear others.', group: 'Voice Channel Permissions' },
  { key: 'SPEAK', label: 'Speak', description: 'Allows members to talk in voice channels.', group: 'Voice Channel Permissions' },
  { key: 'STREAM', label: 'Video', description: 'Allows members to share their video, screen share, or stream a game.', group: 'Voice Channel Permissions' },
  { key: 'USE_SOUNDBOARD', label: 'Use Soundboard', description: 'Allows members to send sounds from server soundboard.', group: 'Voice Channel Permissions' },
  { key: 'USE_VAD', label: 'Use Voice Activity', description: 'Allows members to speak in voice channels by simply talking.', group: 'Voice Channel Permissions' },
  { key: 'PRIORITY_SPEAKER', label: 'Priority Speaker', description: 'Allows members to be more easily heard in voice channels.', group: 'Voice Channel Permissions' },
  { key: 'MUTE_MEMBERS', label: 'Mute Members', description: 'Allows members to mute other members in voice channels for everyone.', group: 'Voice Channel Permissions' },
  { key: 'DEAFEN_MEMBERS', label: 'Deafen Members', description: 'Allows members to deafen other members in voice channels.', group: 'Voice Channel Permissions' },
  { key: 'MOVE_MEMBERS', label: 'Move Members', description: 'Allows members to disconnect or move other members between voice channels.', group: 'Voice Channel Permissions' },
  { key: 'MANAGE_EVENTS', label: 'Manage Events', description: 'Allows members to create, edit, and cancel events.', group: 'Events Permissions' },
  { key: 'ADMINISTRATOR', label: 'Administrator', description: 'Members with this permission will have every permission and will also bypass all channel specific permissions.', group: 'Advanced Permissions' },
];
