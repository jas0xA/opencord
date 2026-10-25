import type Database from 'better-sqlite3';

// Append-only list. Never edit a migration that has shipped; add a new one.
// A function migration runs with foreign keys off (for table rebuilds) inside a transaction.
export const MIGRATIONS: (string | ((db: Database.Database) => void))[] = [
  /* 1: initial schema */ `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  avatar TEXT,
  banner TEXT,
  banner_color TEXT,
  accent_color TEXT,
  theme_colors TEXT,
  pronouns TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  badges TEXT NOT NULL DEFAULT '[]',
  bot INTEGER NOT NULL DEFAULT 0,
  admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  mfa_secret TEXT,
  avatar_decoration TEXT,
  profile_effect TEXT,
  nameplate TEXT,
  display_name_style TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE email_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE allowlist (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  note TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE relationships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type INTEGER NOT NULL,
  nickname TEXT,
  since INTEGER NOT NULL,
  PRIMARY KEY (user_id, other_id)
);

CREATE TABLE notes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  note TEXT NOT NULL,
  PRIMARY KEY (user_id, target_id)
);

CREATE TABLE connections (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1,
  show_details INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, type, name)
);

CREATE TABLE guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  banner TEXT,
  banner_preset INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL REFERENCES users(id),
  traits TEXT NOT NULL DEFAULT '[]',
  tag TEXT,
  system_channel_id TEXT,
  rules_channel_id TEXT,
  afk_channel_id TEXT,
  afk_timeout INTEGER NOT NULL DEFAULT 300,
  verification_level INTEGER NOT NULL DEFAULT 0,
  explicit_content_filter INTEGER NOT NULL DEFAULT 0,
  default_notifications INTEGER NOT NULL DEFAULT 1,
  features TEXT NOT NULL DEFAULT '[]',
  vanity_code TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  type INTEGER NOT NULL,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  parent_id TEXT,
  name TEXT,
  topic TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  nsfw INTEGER NOT NULL DEFAULT 0,
  rate_limit_per_user INTEGER NOT NULL DEFAULT 0,
  bitrate INTEGER NOT NULL DEFAULT 64000,
  user_limit INTEGER NOT NULL DEFAULT 0,
  icon TEXT,
  owner_id TEXT,
  overwrites TEXT NOT NULL DEFAULT '[]',
  last_message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX channels_guild ON channels(guild_id);

CREATE TABLE channel_recipients (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  closed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX recipients_user ON channel_recipients(user_id);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  hoist INTEGER NOT NULL DEFAULT 0,
  icon TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '0',
  mentionable INTEGER NOT NULL DEFAULT 0,
  managed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX roles_guild ON roles(guild_id);

CREATE TABLE members (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nick TEXT,
  avatar TEXT,
  joined_at INTEGER NOT NULL,
  timeout_until INTEGER,
  mute INTEGER NOT NULL DEFAULT 0,
  deaf INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

CREATE TABLE member_roles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, user_id, role_id),
  FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE
);

CREATE TABLE bans (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  moderator_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  inviter_id TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,
  max_age INTEGER NOT NULL DEFAULT 604800,
  temporary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id TEXT,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  type INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  mention_everyone INTEGER NOT NULL DEFAULT 0,
  mentions TEXT NOT NULL DEFAULT '[]',
  mention_roles TEXT NOT NULL DEFAULT '[]',
  attachments TEXT NOT NULL DEFAULT '[]',
  embeds TEXT NOT NULL DEFAULT '[]',
  sticker_ids TEXT NOT NULL DEFAULT '[]',
  reference_id TEXT,
  call TEXT,
  webhook_id TEXT,
  webhook_name TEXT,
  webhook_avatar TEXT
);
CREATE INDEX messages_channel ON messages(channel_id, id);

CREATE TABLE reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji_id TEXT NOT NULL DEFAULT '',
  emoji_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji_id, emoji_name)
);

CREATE TABLE read_states (
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  last_message_id TEXT,
  mention_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE emojis (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  animated INTEGER NOT NULL DEFAULT 0,
  file TEXT NOT NULL,
  creator_id TEXT
);

CREATE TABLE stickers (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL,
  format TEXT NOT NULL
);

CREATE TABLE sounds (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT,
  volume REAL NOT NULL DEFAULT 1,
  file TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  target_id TEXT,
  action TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_guild ON audit_log(guild_id, id);

CREATE TABLE automod_rules (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar TEXT,
  token TEXT NOT NULL,
  creator_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE marketplace_items (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  asset TEXT NOT NULL,
  preview TEXT,
  colors TEXT,
  official INTEGER NOT NULL DEFAULT 0,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE marketplace_likes (
  item_id TEXT NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, user_id)
);

CREATE TABLE marketplace_owned (
  item_id TEXT NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);

CREATE TABLE marketplace_reports (
  item_id TEXT NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
`,

  /* 2: one email may own several accounts (usernames stay unique) */
  (db) => {
    const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as { sql: string };
    const next = sql
      .replace(/^CREATE TABLE "?users"?/, 'CREATE TABLE users_new')
      .replace(/email TEXT NOT NULL UNIQUE COLLATE NOCASE/, 'email TEXT NOT NULL COLLATE NOCASE');
    db.exec(next);
    db.exec('INSERT INTO users_new SELECT * FROM users');
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('CREATE INDEX users_email ON users(email)');
  },
  /* 3: message reports */ `
CREATE TABLE message_reports (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  author_id TEXT,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  -- Copy of the message at report time, so deleting it doesn't erase the evidence.
  snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (message_id, reporter_id)
);
CREATE INDEX message_reports_status ON message_reports(status, guild_id);
`,
  /* 4: global network, server discovery, cosmetic visibility, themes */ `
ALTER TABLE users ADD COLUMN home_host TEXT;
ALTER TABLE users ADD COLUMN home_id TEXT;
CREATE UNIQUE INDEX users_remote ON users(home_host, home_id) WHERE home_host IS NOT NULL;

CREATE TABLE federation_records (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  host TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  sig TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX federation_records_kind ON federation_records(kind, deleted, ts);
CREATE INDEX federation_records_received ON federation_records(received_at);

CREATE TABLE federation_peers (
  origin TEXT PRIMARY KEY,
  pubkey TEXT,
  cursor INTEGER NOT NULL DEFAULT 0,
  last_ok INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE federation_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Maps a relayed message to its id on the sender's host (for edits/deletes and de-duplication).
CREATE TABLE federation_messages (
  origin TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  PRIMARY KEY (origin, remote_id)
);

ALTER TABLE guilds ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN global INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN discovery_invite TEXT;

ALTER TABLE marketplace_items ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE marketplace_items ADD COLUMN allow_copy INTEGER NOT NULL DEFAULT 1;
ALTER TABLE marketplace_items ADD COLUMN global INTEGER NOT NULL DEFAULT 0;
-- Items imported from another host's global listing ("<host>|<id>").
ALTER TABLE marketplace_items ADD COLUMN origin TEXT;
-- sha256 of the uploaded asset, so no-copy designs can't be re-uploaded by someone else.
ALTER TABLE marketplace_items ADD COLUMN asset_hash TEXT;

CREATE TABLE themes (
  id TEXT PRIMARY KEY,
  author_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  css TEXT NOT NULL DEFAULT '',
  js TEXT NOT NULL DEFAULT '',
  -- private: author only · public: everyone on this host · global: listed on the network
  visibility TEXT NOT NULL DEFAULT 'private',
  allow_copy INTEGER NOT NULL DEFAULT 1,
  origin TEXT,
  remote_id TEXT,
  installs INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX themes_visibility ON themes(visibility, updated_at);
`,
];
