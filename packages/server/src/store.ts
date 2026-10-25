// Data access + serialization shared by REST routes and the gateway.
import {
  ALL_PERMISSIONS, ChannelType, Permissions, applyOverwrites, computeBasePermissions, defaultUserSettings,
  hasPermission, type AuditLogEntry, type Channel, type Connection, type Emoji, type Guild, type GuildFull,
  type GuildMember, type MarketplaceItem, type Message, type PermissionOverwrite, type PublicUser,
  type Reaction, type Role, type SelfUser, type SoundboardSound, type Sticker, type UserSettings,
} from '@opencord/shared';
import type { DB } from './db';
import { forbidden, json, notFound, snowflake } from './util';

export const fileUrl = (rel: string | null | undefined) => (rel ? (rel.startsWith('market:') || /^https?:\/\//.test(rel) ? rel : `/uploads/${rel}`) : null);

/* ───────────────────────── users ───────────────────────── */

export interface UserRow {
  id: string; username: string; email: string; password_hash: string; display_name: string | null;
  avatar: string | null; banner: string | null; banner_color: string | null; accent_color: string | null;
  theme_colors: string | null; pronouns: string; bio: string; badges: string; bot: number; admin: number;
  disabled: number; email_verified: number; mfa_secret: string | null; avatar_decoration: string | null;
  profile_effect: string | null; nameplate: string | null; display_name_style: string | null; settings: string;
  created_at: number;
}

export class Store {
  constructor(public db: DB) {}

  userRow(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  userByName(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase()) as UserRow | undefined;
  }

  publicUser(row: UserRow): PublicUser {
    const badges = json<string[]>(row.badges, []);
    if (row.admin && !badges.includes('staff')) badges.unshift('staff');
    return {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      avatar: fileUrl(row.avatar),
      banner: fileUrl(row.banner),
      banner_color: row.banner_color,
      accent_color: row.accent_color,
      theme_colors: json(row.theme_colors, null),
      pronouns: row.pronouns,
      bio: row.bio,
      badges,
      bot: !!row.bot,
      created_at: row.created_at,
      avatar_decoration: row.avatar_decoration,
      profile_effect: row.profile_effect,
      nameplate: row.nameplate,
      display_name_style: json(row.display_name_style, null),
    };
  }

  user(id: string): PublicUser {
    const row = this.userRow(id);
    if (!row) return this.deletedUser(id);
    return this.publicUser(row);
  }

  deletedUser(id: string): PublicUser {
    return {
      id, username: 'deleted_user', display_name: 'Deleted User', avatar: null, banner: null, banner_color: null,
      accent_color: null, theme_colors: null, pronouns: '', bio: '', badges: [], bot: false, created_at: 0,
      avatar_decoration: null, profile_effect: null, nameplate: null, display_name_style: null,
    };
  }

  settings(row: UserRow): UserSettings {
    return { ...defaultUserSettings(), ...json<Partial<UserSettings>>(row.settings, {}) };
  }

  connections(userId: string, onlyVisible = false): Connection[] {
    const rows = this.db
      .prepare(`SELECT * FROM connections WHERE user_id = ? ${onlyVisible ? 'AND visible = 1' : ''}`)
      .all(userId) as any[];
    return rows.map((r) => ({
      type: r.type, name: r.name, url: r.url, verified: !!r.verified, visible: !!r.visible,
      show_details: !!r.show_details, metadata: json(r.metadata, {}),
    }));
  }

  selfUser(row: UserRow): SelfUser {
    const inventory = (this.db.prepare('SELECT item_id FROM marketplace_owned WHERE user_id = ?').all(row.id) as any[]).map(
      (r) => r.item_id,
    );
    return {
      ...this.publicUser(row),
      email: row.email,
      mfa_enabled: !!row.mfa_secret,
      admin: !!row.admin,
      settings: this.settings(row),
      connections: this.connections(row.id),
      inventory,
    };
  }

  /* ───────────────────────── guilds ───────────────────────── */

  guildRow(id: string): any {
    return this.db.prepare('SELECT * FROM guilds WHERE id = ?').get(id);
  }

  guild(row: any): Guild {
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM members WHERE guild_id = ?').get(row.id) as any).c;
    return {
      id: row.id,
      name: row.name,
      icon: fileUrl(row.icon),
      banner: fileUrl(row.banner),
      banner_preset: row.banner_preset,
      description: row.description,
      owner_id: row.owner_id,
      traits: json(row.traits, []),
      tag: json(row.tag, null),
      system_channel_id: row.system_channel_id,
      rules_channel_id: row.rules_channel_id,
      afk_channel_id: row.afk_channel_id,
      afk_timeout: row.afk_timeout,
      verification_level: row.verification_level,
      explicit_content_filter: row.explicit_content_filter,
      default_notifications: row.default_notifications,
      features: json(row.features, []),
      vanity_code: row.vanity_code,
      member_count: count,
      created_at: row.created_at,
    };
  }

  guildFull(guildId: string): GuildFull {
    const row = this.guildRow(guildId);
    if (!row) throw notFound('Guild');
    return {
      ...this.guild(row),
      channels: this.guildChannels(guildId),
      roles: this.roles(guildId),
      members: this.members(guildId),
      emojis: this.emojis(guildId),
      stickers: this.stickers(guildId),
      sounds: this.sounds(guildId),
      voice_states: [],
    };
  }

  userGuildIds(userId: string): string[] {
    return (this.db.prepare('SELECT guild_id FROM members WHERE user_id = ?').all(userId) as any[]).map((r) => r.guild_id);
  }

  guildMemberIds(guildId: string): string[] {
    return (this.db.prepare('SELECT user_id FROM members WHERE guild_id = ?').all(guildId) as any[]).map((r) => r.user_id);
  }

  isMember(guildId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  }

  roles(guildId: string): Role[] {
    return (this.db.prepare('SELECT * FROM roles WHERE guild_id = ? ORDER BY position').all(guildId) as any[]).map((r) =>
      this.role(r),
    );
  }

  role(r: any): Role {
    return {
      id: r.id, guild_id: r.guild_id, name: r.name, color: r.color, hoist: !!r.hoist, icon: fileUrl(r.icon),
      position: r.position, permissions: r.permissions, mentionable: !!r.mentionable, managed: !!r.managed,
    };
  }

  memberRoleIds(guildId: string, userId: string): string[] {
    return (
      this.db.prepare('SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?').all(guildId, userId) as any[]
    ).map((r) => r.role_id);
  }

  member(guildId: string, userId: string): GuildMember | null {
    const m = this.db.prepare('SELECT * FROM members WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as any;
    if (!m) return null;
    return this.serializeMember(m, this.memberRoleIds(guildId, userId));
  }

  serializeMember(m: any, roles: string[]): GuildMember {
    return {
      guild_id: m.guild_id,
      user: this.user(m.user_id),
      nick: m.nick,
      avatar: fileUrl(m.avatar),
      roles,
      joined_at: m.joined_at,
      communication_disabled_until: m.timeout_until && m.timeout_until > Date.now() ? m.timeout_until : null,
      mute: !!m.mute,
      deaf: !!m.deaf,
    };
  }

  members(guildId: string): GuildMember[] {
    const rows = this.db.prepare('SELECT * FROM members WHERE guild_id = ?').all(guildId) as any[];
    const roleRows = this.db.prepare('SELECT user_id, role_id FROM member_roles WHERE guild_id = ?').all(guildId) as any[];
    const byUser = new Map<string, string[]>();
    for (const r of roleRows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id)!.push(r.role_id);
    }
    return rows.map((m) => this.serializeMember(m, byUser.get(m.user_id) ?? []));
  }

  emojis(guildId: string): Emoji[] {
    return (this.db.prepare('SELECT * FROM emojis WHERE guild_id = ?').all(guildId) as any[]).map((e) => ({
      id: e.id, guild_id: e.guild_id, name: e.name, animated: !!e.animated, url: fileUrl(e.file)!, creator_id: e.creator_id,
    }));
  }

  stickers(guildId: string): Sticker[] {
    return (this.db.prepare('SELECT * FROM stickers WHERE guild_id = ?').all(guildId) as any[]).map((s) => ({
      id: s.id, guild_id: s.guild_id, name: s.name, description: s.description, tags: s.tags, url: fileUrl(s.file)!,
      format: s.format,
    }));
  }

  sounds(guildId: string): SoundboardSound[] {
    return (this.db.prepare('SELECT * FROM sounds WHERE guild_id = ?').all(guildId) as any[]).map((s) => ({
      id: s.id, guild_id: s.guild_id, name: s.name, emoji: s.emoji, volume: s.volume, url: fileUrl(s.file)!,
    }));
  }

  /* ───────────────────────── channels ───────────────────────── */

  channelRow(id: string): any {
    return this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  }

  channel(row: any, withRecipients = true): Channel {
    const ch: Channel = {
      id: row.id,
      type: row.type,
      guild_id: row.guild_id,
      parent_id: row.parent_id,
      name: row.name,
      topic: row.topic,
      position: row.position,
      nsfw: !!row.nsfw,
      rate_limit_per_user: row.rate_limit_per_user,
      bitrate: row.bitrate,
      user_limit: row.user_limit,
      icon: fileUrl(row.icon),
      owner_id: row.owner_id,
      permission_overwrites: json(row.overwrites, []),
      last_message_id: row.last_message_id,
    };
    if (withRecipients && (row.type === ChannelType.DM || row.type === ChannelType.GROUP_DM)) {
      ch.recipients = this.recipientIds(row.id).map((id) => this.user(id));
    }
    return ch;
  }

  guildChannels(guildId: string): Channel[] {
    return (this.db.prepare('SELECT * FROM channels WHERE guild_id = ? ORDER BY position').all(guildId) as any[]).map((r) =>
      this.channel(r),
    );
  }

  recipientIds(channelId: string): string[] {
    return (this.db.prepare('SELECT user_id FROM channel_recipients WHERE channel_id = ?').all(channelId) as any[]).map(
      (r) => r.user_id,
    );
  }

  privateChannels(userId: string): Channel[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM channels c JOIN channel_recipients r ON r.channel_id = c.id
         WHERE r.user_id = ? AND r.closed = 0 ORDER BY COALESCE(c.last_message_id, c.id) DESC`,
      )
      .all(userId) as any[];
    return rows.map((r) => this.channel(r));
  }

  /* ───────────────────────── permissions ───────────────────────── */

  guildPermissions(guildId: string, userId: string): bigint {
    const g = this.guildRow(guildId);
    if (!g) throw notFound('Guild');
    if (!this.isMember(guildId, userId)) return 0n;
    if (g.owner_id === userId) return ALL_PERMISSIONS;
    const everyone = this.db.prepare('SELECT permissions FROM roles WHERE id = ?').get(guildId) as any;
    const rolePerms = (
      this.db
        .prepare(
          'SELECT r.permissions FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.guild_id = ? AND mr.user_id = ?',
        )
        .all(guildId, userId) as any[]
    ).map((r) => BigInt(r.permissions));
    let perms = computeBasePermissions({
      isOwner: false,
      everyonePerms: BigInt(everyone?.permissions ?? '0'),
      memberRolePerms: rolePerms,
    });
    // Timed-out members keep only read permissions.
    const m = this.db.prepare('SELECT timeout_until FROM members WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as any;
    if (m?.timeout_until && m.timeout_until > Date.now() && !hasPermission(perms, Permissions.ADMINISTRATOR)) {
      perms &= Permissions.VIEW_CHANNEL | Permissions.READ_MESSAGE_HISTORY;
    }
    return perms;
  }

  channelPermissions(channelId: string, userId: string): bigint {
    const ch = this.channelRow(channelId);
    if (!ch) throw notFound('Channel');
    if (!ch.guild_id) {
      const isRecipient = !!this.db
        .prepare('SELECT 1 FROM channel_recipients WHERE channel_id = ? AND user_id = ?')
        .get(channelId, userId);
      if (!isRecipient) return 0n;
      return (
        Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.READ_MESSAGE_HISTORY | Permissions.ADD_REACTIONS |
        Permissions.ATTACH_FILES | Permissions.EMBED_LINKS | Permissions.CONNECT | Permissions.SPEAK | Permissions.STREAM |
        Permissions.USE_EXTERNAL_EMOJIS | Permissions.PIN_MESSAGES | Permissions.USE_EXTERNAL_STICKERS
      );
    }
    const base = this.guildPermissions(ch.guild_id, userId);
    if (base === 0n) return 0n;
    const overwrites: PermissionOverwrite[] = [...json<PermissionOverwrite[]>(ch.overwrites, [])];
    // Channels inherit from their category when they have no overwrites of their own.
    if (overwrites.length === 0 && ch.parent_id) {
      const parent = this.channelRow(ch.parent_id);
      if (parent) overwrites.push(...json<PermissionOverwrite[]>(parent.overwrites, []));
    }
    return applyOverwrites({
      base,
      guildId: ch.guild_id,
      userId,
      roleIds: this.memberRoleIds(ch.guild_id, userId),
      overwrites,
    });
  }

  requireGuildPerm(guildId: string, userId: string, flag: bigint) {
    if (!this.isMember(guildId, userId)) throw notFound('Guild');
    if (!hasPermission(this.guildPermissions(guildId, userId), flag)) throw forbidden();
  }

  requireChannelPerm(channelId: string, userId: string, flag: bigint) {
    const perms = this.channelPermissions(channelId, userId);
    if (!hasPermission(perms, Permissions.VIEW_CHANNEL)) throw notFound('Channel');
    if (!hasPermission(perms, flag)) throw forbidden();
  }

  /** Highest role position a member holds (owner = Infinity). */
  highestRole(guildId: string, userId: string): number {
    const g = this.guildRow(guildId);
    if (g?.owner_id === userId) return Infinity;
    const r = this.db
      .prepare(
        'SELECT MAX(r.position) AS p FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.guild_id = ? AND mr.user_id = ?',
      )
      .get(guildId, userId) as any;
    return r?.p ?? 0;
  }

  /** Moderation actions require the actor to sit above the target in the role hierarchy. */
  requireAbove(guildId: string, actorId: string, targetId: string) {
    const g = this.guildRow(guildId);
    if (g.owner_id === targetId) throw forbidden('You cannot moderate the server owner');
    if (actorId === targetId) throw forbidden('You cannot moderate yourself');
    if (this.highestRole(guildId, actorId) <= this.highestRole(guildId, targetId)) {
      throw forbidden("Target's highest role is equal to or above yours");
    }
  }

  /* ───────────────────────── messages ───────────────────────── */

  messageRow(id: string): any {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  reactions(messageId: string, viewerId: string): Reaction[] {
    const rows = this.db
      .prepare(
        `SELECT emoji_id, emoji_name, COUNT(*) AS c, SUM(user_id = ?) AS me, MIN(created_at) AS first
         FROM reactions WHERE message_id = ? GROUP BY emoji_id, emoji_name ORDER BY first`,
      )
      .all(viewerId, messageId) as any[];
    return rows.map((r) => ({
      emoji: { id: r.emoji_id || null, name: r.emoji_name },
      count: r.c,
      me: !!r.me,
    }));
  }

  message(row: any, viewerId: string, depth = 0): Message {
    let author: PublicUser;
    if (row.webhook_id) {
      author = { ...this.deletedUser(row.webhook_id), username: row.webhook_name ?? 'Webhook', display_name: row.webhook_name, avatar: fileUrl(row.webhook_avatar), bot: true };
    } else {
      author = this.user(row.author_id);
    }
    let member: Message['member'] = null;
    if (row.guild_id && !row.webhook_id) {
      const m = this.db.prepare('SELECT nick FROM members WHERE guild_id = ? AND user_id = ?').get(row.guild_id, row.author_id) as any;
      if (m) member = { nick: m.nick, roles: this.memberRoleIds(row.guild_id, row.author_id) };
    }
    let referenced: Message | null = null;
    if (row.reference_id && depth === 0) {
      const ref = this.messageRow(row.reference_id);
      if (ref) referenced = this.message(ref, viewerId, 1);
    }
    return {
      id: row.id,
      channel_id: row.channel_id,
      guild_id: row.guild_id,
      author,
      member,
      content: row.content,
      type: row.type,
      created_at: row.created_at,
      edited_at: row.edited_at,
      pinned: !!row.pinned,
      mention_everyone: !!row.mention_everyone,
      mentions: json(row.mentions, []),
      mention_roles: json(row.mention_roles, []),
      attachments: json(row.attachments, []),
      embeds: json(row.embeds, []),
      reactions: this.reactions(row.id, viewerId),
      sticker_ids: json(row.sticker_ids, []),
      referenced_message: referenced,
      message_reference: row.reference_id ? { message_id: row.reference_id, channel_id: row.channel_id } : null,
      call: json(row.call, null),
      webhook_id: row.webhook_id,
    };
  }

  /* ───────────────────────── audit log ───────────────────────── */

  audit(
    guildId: string,
    userId: string,
    action: string,
    targetId: string | null,
    changes: AuditLogEntry['changes'] = [],
    reason: string | null = null,
  ) {
    this.db
      .prepare(
        'INSERT INTO audit_log (id, guild_id, user_id, target_id, action, changes, reason, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(snowflake(), guildId, userId, targetId, action, JSON.stringify(changes), reason, Date.now());
  }

  /* ───────────────────────── marketplace ───────────────────────── */

  marketplaceItem(r: any, viewerId: string): MarketplaceItem {
    const likes = (this.db.prepare('SELECT COUNT(*) AS c FROM marketplace_likes WHERE item_id = ?').get(r.id) as any).c;
    const liked = !!this.db.prepare('SELECT 1 FROM marketplace_likes WHERE item_id = ? AND user_id = ?').get(r.id, viewerId);
    const owners = (this.db.prepare('SELECT COUNT(*) AS c FROM marketplace_owned WHERE item_id = ?').get(r.id) as any).c;
    const asset = r.asset.startsWith('builtin:') || r.asset.startsWith('http') ? r.asset : fileUrl(r.asset)!;
    return {
      id: r.id,
      category: r.category,
      name: r.name,
      description: r.description,
      asset,
      preview: r.preview ? (r.preview.startsWith('builtin:') ? r.preview : fileUrl(r.preview)) : null,
      colors: json(r.colors, null),
      official: !!r.official,
      author: r.author_id ? this.user(r.author_id) : null,
      status: r.status,
      likes,
      liked,
      owners,
      tags: json(r.tags, []),
      created_at: r.created_at,
      visibility: r.visibility ?? 'public',
      allow_copy: r.allow_copy === undefined ? true : !!r.allow_copy,
      global: !!r.global,
      origin: r.origin ?? null,
    };
  }
}
