import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { MAX_UPLOAD_MB_CAP } from '@opencord/shared';

export const DEFAULT_CONFIG_TOML = `# ─────────────────────────────────────────────────────────────
#  OpenCord server configuration
#  Most settings take effect after a restart. Settings marked
#  (live) are reloaded automatically when this file is saved.
# ─────────────────────────────────────────────────────────────

[server]
# Address to listen on. 0.0.0.0 = all interfaces.
host = "0.0.0.0"
port = 8443
# The URL clients use to reach this server (used in invite links and emails).
# Leave empty to derive it from the request.
public_url = ""
# Set to true when running behind a reverse proxy (nginx, caddy, ...).
trust_proxy = false

[tls]
# Automatic HTTPS: get and renew a free Let's Encrypt certificate for the host in
# [server].public_url, which can be a domain or just your server's public IP
# address (e.g. public_url = "https://203.0.113.5"). IP certificates last about
# 6 days and are renewed automatically. Needs port 80 forwarded to http_port and
# port 443 to [server].port (or set [server].port = 443).
auto = false
email = ""            # optional, for expiry warnings from Let's Encrypt
http_port = 80        # plain-HTTP port for validation and the redirect to HTTPS
acme_directory = "https://acme-v02.api.letsencrypt.org/directory"
# Or serve HTTPS with your own certificate files (or terminate TLS in a reverse proxy).
enabled = false
cert = ""
key = ""

[instance]
# (live) Shown on the client's login screen.
name = "My OpenCord"
description = "A self-hosted OpenCord server."
# Accounts registered with these emails become instance admins.
admin_emails = []

[registration]
# (live) Who may create an account:
#   "open"        - anyone
#   "invite_only" - only with a valid guild invite code
#   "allowlist"   - only emails added with: opencord-server allow-email add <email>
#   "closed"      - nobody (existing users can still log in)
mode = "open"
require_email_verification = false
min_password_length = 8
# How many accounts one email address may own (users can switch between them).
max_accounts_per_email = 5

[smtp]
# Used for email verification and password resets.
enabled = false
host = ""
port = 587
secure = false
user = ""
pass = ""
from = "OpenCord <no-reply@example.com>"

[storage]
# Database and uploaded files live here (relative to this config file).
data_dir = "./data"
# (live) Largest file a message can carry, in MB (up to 500). Also editable in
# Server Admin → Storage.
max_upload_mb = 500
# (live) Total disk space OpenCord may use (database + uploads), in GB. 0 = no limit.
# Near the limit, new uploads and messages make room by deleting the media of the
# oldest messages, then the oldest messages themselves. Accounts, servers and
# everything else are never deleted.
max_storage_gb = 0
max_avatar_mb = 8
max_emoji_kb = 512

[limits]
# (live)
max_guilds_per_user = 100
max_members_per_guild = 0    # 0 = unlimited
max_message_length = 4000
messages_per_10s = 10
max_group_dm_size = 10

[marketplace]
# (live) Lets users publish their own cosmetics in the Community tab.
community_enabled = true
# If true, community items must be approved by an admin before they are listed.
require_approval = false
max_item_mb = 5

[voice]
# ICE servers sent to clients for peer-to-peer calls.
stun = ["stun:stun.l.google.com:19302"]
# Optional TURN relay (e.g. coturn) for users behind strict NATs.
turn_url = ""
turn_user = ""
turn_pass = ""

[sfu]
# Selective Forwarding Unit (mediasoup) that relays voice/video for all calls.
# Address the media relay binds to. 0.0.0.0 = all interfaces.
listen_ip = "0.0.0.0"
# Public IP or hostname clients use to reach this server. Leave empty to fall
# back to [server].public_url's host, or else the address each client connected
# to. Set it explicitly if clients reach the API through a different address
# than the media relay (e.g. a reverse proxy or CDN in front of the API).
announced_ip = ""
# UDP/TCP port range the media relay uses. Open these in your firewall.
rtc_min_port = 40000
rtc_max_port = 49999

[federation]
# Join the global OpenCord network: usernames are unique across every host,
# friends and DMs work between hosts, users can sign in to other hosts with
# their account here, and global servers and cosmetics show up in the browser.
# Requires [server].public_url to be set to an address other hosts can reach.
enabled = true
# Help host the global network: store the shared directory and serve it to
# other hosts. Costs a little disk and bandwidth. Set to false to only use it.
help_host = true
# Hosts to bootstrap from (any host that helps host). More are discovered
# automatically from the directory.
seeds = []
# How often to pull directory updates from peers, in seconds.
sync_interval_s = 60

[web]
# Serve the OpenCord web app on this server so phones and browsers can use it
# without installing anything (iOS: Share → Add to Home Screen).
enabled = true
# Path to an Android APK to offer for download at /download/android
# (relative to this config file). Leave empty to hide the APK button.
# Build one with: scripts/build-android.sh https://your.host
android_apk = ""
# For the APK to open full-screen (without a browser bar), Android checks
# /.well-known/assetlinks.json. Fill these in from the build script's output.
android_package = "org.opencord.app"
android_sha256 = ""

[updates]
# Check GitHub once every few hours for a newer OpenCord release and show
# "update available" (with how to update) on the Server Admin page.
check = true

[embeds]
# Fetch link previews (OpenGraph) for URLs posted in messages.
enabled = true
timeout_ms = 4000

# OAuth apps for verified "Connected Apps". Fill in client id/secret to enable a provider.
# Callback URL: <public_url>/api/v1/connections/<provider>/callback
[connections.github]
client_id = ""
client_secret = ""

[logging]
# trace | debug | info | warn | error   ("info" logs every HTTP request)
level = "warn"
file = ""
`;

const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().int().min(1).max(65535).default(8443),
    public_url: z.string().default(''),
    trust_proxy: z.boolean().default(false),
  }),
  tls: z.object({
    auto: z.boolean().default(false),
    email: z.string().default(''),
    http_port: z.number().int().min(1).max(65535).default(80),
    acme_directory: z.string().url().default('https://acme-v02.api.letsencrypt.org/directory'),
    enabled: z.boolean().default(false),
    cert: z.string().default(''),
    key: z.string().default(''),
  }),
  instance: z.object({
    name: z.string().default('My OpenCord'),
    description: z.string().default(''),
    admin_emails: z.array(z.string()).default([]),
  }),
  registration: z.object({
    mode: z.enum(['open', 'invite_only', 'allowlist', 'closed']).default('open'),
    require_email_verification: z.boolean().default(false),
    min_password_length: z.number().int().min(8).default(8),
    max_accounts_per_email: z.number().int().min(1).default(5),
  }),
  smtp: z.object({
    enabled: z.boolean().default(false),
    host: z.string().default(''),
    port: z.number().int().default(587),
    secure: z.boolean().default(false),
    user: z.string().default(''),
    pass: z.string().default(''),
    from: z.string().default('OpenCord <no-reply@example.com>'),
  }),
  storage: z.object({
    data_dir: z.string().default('./data'),
    max_upload_mb: z.number().positive().default(MAX_UPLOAD_MB_CAP).transform((v) => Math.min(v, MAX_UPLOAD_MB_CAP)),
    max_storage_gb: z.number().min(0).default(0),
    max_avatar_mb: z.number().default(8),
    max_emoji_kb: z.number().default(512),
  }),
  limits: z.object({
    max_guilds_per_user: z.number().int().default(100),
    max_members_per_guild: z.number().int().default(0),
    max_message_length: z.number().int().default(4000),
    messages_per_10s: z.number().int().default(10),
    max_group_dm_size: z.number().int().default(10),
  }),
  marketplace: z.object({
    community_enabled: z.boolean().default(true),
    require_approval: z.boolean().default(false),
    max_item_mb: z.number().default(5),
  }),
  voice: z.object({
    stun: z.array(z.string()).default([]),
    turn_url: z.string().default(''),
    turn_user: z.string().default(''),
    turn_pass: z.string().default(''),
  }),
  sfu: z.object({
    listen_ip: z.string().default('0.0.0.0'),
    announced_ip: z.string().default(''),
    rtc_min_port: z.number().int().min(1).max(65535).default(40000),
    rtc_max_port: z.number().int().min(1).max(65535).default(49999),
  }),
  federation: z.object({
    enabled: z.boolean().default(true),
    help_host: z.boolean().default(true),
    seeds: z.array(z.string()).default([]),
    sync_interval_s: z.number().int().min(10).default(60),
  }),
  web: z.object({
    enabled: z.boolean().default(true),
    android_apk: z.string().default(''),
    android_package: z.string().default('org.opencord.app'),
    android_sha256: z.string().default(''),
  }),
  updates: z.object({ check: z.boolean().default(true) }),
  embeds: z.object({ enabled: z.boolean().default(true), timeout_ms: z.number().default(4000) }),
  connections: z.record(z.object({ client_id: z.string().default(''), client_secret: z.string().default('') })).default({}),
  logging: z.object({ level: z.string().default('warn'), file: z.string().default('') }),
});

export type Config = z.infer<typeof ConfigSchema> & { configPath: string; dataDir: string };

const defaults = parse(DEFAULT_CONFIG_TOML) as Record<string, unknown>;

function deepMerge(base: any, over: any): any {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over ?? base;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = typeof v === 'object' && v !== null && !Array.isArray(v) ? deepMerge(base[k] ?? {}, v) : v;
  }
  return out;
}

export function resolveConfigPath(): string {
  const idx = process.argv.indexOf('--config');
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  if (process.env.OPENCORD_CONFIG) return path.resolve(process.env.OPENCORD_CONFIG);
  return path.resolve('config.toml');
}

export function loadConfig(configPath = resolveConfigPath()): Config {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, DEFAULT_CONFIG_TOML);
    console.log(`[config] wrote default configuration to ${configPath}`);
  }
  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid TOML in ${configPath}: ${(e as Error).message}`);
  }
  const merged = deepMerge(defaults, raw);
  // Environment overrides, handy for containers (docker-compose.yml sets these).
  const env = process.env;
  const bool = (v: string) => /^(1|true|yes|on)$/i.test(v);
  if (env.OPENCORD_PORT) merged.server.port = Number(env.OPENCORD_PORT);
  if (env.OPENCORD_HOST) merged.server.host = env.OPENCORD_HOST;
  if (env.OPENCORD_PUBLIC_URL) merged.server.public_url = env.OPENCORD_PUBLIC_URL;
  if (env.OPENCORD_TRUST_PROXY) merged.server.trust_proxy = bool(env.OPENCORD_TRUST_PROXY);
  if (env.OPENCORD_DATA_DIR) merged.storage.data_dir = env.OPENCORD_DATA_DIR;
  if (env.OPENCORD_ANNOUNCED_IP) merged.sfu.announced_ip = env.OPENCORD_ANNOUNCED_IP;
  if (env.OPENCORD_RTC_MIN_PORT) merged.sfu.rtc_min_port = Number(env.OPENCORD_RTC_MIN_PORT);
  if (env.OPENCORD_RTC_MAX_PORT) merged.sfu.rtc_max_port = Number(env.OPENCORD_RTC_MAX_PORT);
  if (env.OPENCORD_FEDERATION) merged.federation.enabled = bool(env.OPENCORD_FEDERATION);
  if (env.OPENCORD_HELP_HOST) merged.federation.help_host = bool(env.OPENCORD_HELP_HOST);
  if (env.OPENCORD_SEEDS) merged.federation.seeds = env.OPENCORD_SEEDS.split(',').map((x) => x.trim()).filter(Boolean);
  if (env.OPENCORD_UPDATE_CHECK) merged.updates.check = bool(env.OPENCORD_UPDATE_CHECK);
  if (env.OPENCORD_TLS_AUTO) merged.tls.auto = bool(env.OPENCORD_TLS_AUTO);
  if (env.OPENCORD_TLS_EMAIL) merged.tls.email = env.OPENCORD_TLS_EMAIL;
  if (env.OPENCORD_HTTP_PORT) merged.tls.http_port = Number(env.OPENCORD_HTTP_PORT);
  if (env.OPENCORD_ACME_DIRECTORY) merged.tls.acme_directory = env.OPENCORD_ACME_DIRECTORY;
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration in ${configPath}:\n${issues}`);
  }
  if (result.data.tls.auto && !/^https:\/\/[^/]+/.test(result.data.server.public_url)) {
    throw new Error(`[tls] auto = true needs [server].public_url set to your address, e.g. "https://203.0.113.5" or "https://chat.example.com" (${configPath})`);
  }
  const dataDir = path.resolve(path.dirname(configPath), result.data.storage.data_dir);
  return { ...result.data, configPath, dataDir };
}

/** Reloads the live-reloadable sections in place when the file changes. */
export function watchConfig(cfg: Config, onReload?: (c: Config) => void) {
  let timer: NodeJS.Timeout | null = null;
  try {
    fs.watch(cfg.configPath, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const next = loadConfig(cfg.configPath);
          cfg.instance = next.instance;
          cfg.registration = next.registration;
          cfg.limits = next.limits;
          cfg.marketplace = next.marketplace;
          cfg.storage.max_upload_mb = next.storage.max_upload_mb;
          cfg.storage.max_storage_gb = next.storage.max_storage_gb;
          console.log('[config] reloaded');
          onReload?.(cfg);
        } catch (e) {
          console.error('[config] reload failed:', (e as Error).message);
        }
      }, 200);
    });
  } catch {
    /* watching is best-effort */
  }
}
