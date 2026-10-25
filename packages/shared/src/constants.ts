export const APP_NAME = 'OpenCord';
export const DEFAULT_PORT = 8443;
export const API_PREFIX = '/api/v1';
export const GATEWAY_PATH = '/gateway';

/** Server banner presets shown in Server Settings → Server Profile (index = guild.banner_preset). */
export const BANNER_PRESETS: string[] = [
  'linear-gradient(180deg, #0d0d0f 0%, #3a3b40 100%)',
  'linear-gradient(180deg, #ff2fa6 0%, #ff74c4 100%)',
  'linear-gradient(180deg, #e01f1f 0%, #f5594a 100%)',
  'linear-gradient(180deg, #e8701a 0%, #ffa44a 100%)',
  'linear-gradient(180deg, #e6c32b 0%, #fbe36a 100%)',
  'linear-gradient(180deg, #6d2a90 0%, #c26fe0 100%)',
  'linear-gradient(180deg, #078bff 0%, #4fd0ff 100%)',
  'linear-gradient(180deg, #2ed3b7 0%, #9bfaf0 100%)',
  'linear-gradient(180deg, #2f6b0a 0%, #79b62d 100%)',
  'linear-gradient(180deg, #1e1f22 0%, #6b6d72 100%)',
];

export const CONNECTION_PROVIDERS: { id: string; name: string; color: string; profileUrl?: string }[] = [
  { id: 'battlenet', name: 'Battle.net', color: '#148eff' },
  { id: 'bluesky', name: 'Bluesky', color: '#1185fe', profileUrl: 'https://bsky.app/profile/{name}' },
  { id: 'paypal', name: 'PayPal', color: '#003087' },
  { id: 'reddit', name: 'Reddit', color: '#ff4500', profileUrl: 'https://reddit.com/u/{name}' },
  { id: 'steam', name: 'Steam', color: '#171a21', profileUrl: 'https://steamcommunity.com/id/{name}' },
  { id: 'ebay', name: 'eBay', color: '#e53238' },
  { id: 'crunchyroll', name: 'Crunchyroll', color: '#f47521' },
  { id: 'playstation', name: 'PlayStation Network', color: '#003791' },
  { id: 'spotify', name: 'Spotify', color: '#1db954', profileUrl: 'https://open.spotify.com/user/{name}' },
  { id: 'xbox', name: 'Xbox', color: '#107c10' },
  { id: 'amazonmusic', name: 'Amazon Music', color: '#25d1da' },
  { id: 'leagueoflegends', name: 'League of Legends', color: '#c89b3c' },
  { id: 'domain', name: 'Domain', color: '#5865f2', profileUrl: 'https://{name}' },
  { id: 'epicgames', name: 'Epic Games', color: '#313131' },
  { id: 'facebook', name: 'Facebook', color: '#1877f2', profileUrl: 'https://facebook.com/{name}' },
  { id: 'flickr', name: 'Flickr', color: '#ff0084' },
  { id: 'roblox', name: 'Roblox', color: '#e2231a', profileUrl: 'https://www.roblox.com/user.aspx?username={name}' },
  { id: 'twitch', name: 'Twitch', color: '#9146ff', profileUrl: 'https://twitch.tv/{name}' },
  { id: 'youtube', name: 'YouTube', color: '#ff0000', profileUrl: 'https://youtube.com/@{name}' },
  { id: 'x', name: 'X', color: '#000000', profileUrl: 'https://x.com/{name}' },
  { id: 'github', name: 'GitHub', color: '#181717', profileUrl: 'https://github.com/{name}' },
];

export const AUDIT_ACTIONS = [
  'GUILD_UPDATE', 'CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'CHANNEL_OVERWRITE_UPDATE',
  'MEMBER_KICK', 'MEMBER_BAN_ADD', 'MEMBER_BAN_REMOVE', 'MEMBER_UPDATE', 'MEMBER_ROLE_UPDATE',
  'MEMBER_TIMEOUT', 'ROLE_CREATE', 'ROLE_UPDATE', 'ROLE_DELETE', 'INVITE_CREATE', 'INVITE_DELETE',
  'WEBHOOK_CREATE', 'WEBHOOK_DELETE', 'EMOJI_CREATE', 'EMOJI_DELETE', 'STICKER_CREATE', 'STICKER_DELETE',
  'SOUND_CREATE', 'SOUND_DELETE', 'MESSAGE_DELETE', 'MESSAGE_BULK_DELETE', 'MESSAGE_PIN', 'MESSAGE_UNPIN',
  'AUTOMOD_RULE_CREATE', 'AUTOMOD_RULE_UPDATE', 'AUTOMOD_RULE_DELETE', 'AUTOMOD_BLOCK_MESSAGE',
] as const;

export const USERNAME_MIN = 3;
export const USERNAME_REGEX = /^[a-z0-9_.]{3,32}$/;

/** Problem with a new username, or null if it's fine. */
export function usernameProblem(name: string): string | null {
  if (name.length < USERNAME_MIN) return `Must be at least ${USERNAME_MIN} characters`;
  if (name.length > 32) return 'Must be 32 characters or fewer';
  if (!USERNAME_REGEX.test(name)) return 'Only lowercase letters, numbers, _ and . are allowed';
  if (/^\.|\.$|\.\./.test(name)) return "Can't start or end with a dot, or contain two in a row";
  return null;
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop',
  'iloveyou', 'letmein1', 'welcome1', 'admin123', 'abc12345', 'football1', 'baseball1', 'opencord1',
  'passw0rd', 'trustno1', '11111111', '00000000', '87654321', 'sunshine1', 'princess1', 'monkey123',
]);

/**
 * Problem with a new password, or null if it's fine. A sensible baseline rather than a maze of
 * rules: a minimum length, a letter and a digit, not a well-known password, not the username.
 */
export function passwordProblem(pw: string, opts: { minLength?: number; username?: string } = {}): string | null {
  const min = Math.max(8, opts.minLength ?? 8);
  if (pw.length < min) return `Must be at least ${min} characters`;
  if (pw.length > 128) return 'Must be 128 characters or fewer';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Must contain at least one letter and one number';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'This password is too common';
  if (opts.username && pw.toLowerCase().includes(opts.username.toLowerCase()) && opts.username.length >= 3) return "Can't contain your username";
  if (/^(.)\1+$/.test(pw)) return "Can't be one repeated character";
  return null;
}

export function defaultUserSettings(): import('./types').UserSettings {
  return {
    theme: 'dark',
    message_display: 'cozy',
    zoom: 100,
    font_scale: 16,
    locale: 'en-US',
    time_24h: false,
    developer_mode: false,
    reduced_motion: false,
    saturation: 100,
    underline_links: false,
    role_colors: 'name',
    allow_dms_from_guild_members: true,
    friend_requests_from: { everyone: true, friends_of_friends: true, server_members: true },
    explicit_filter: 'friends',
    show_activity: true,
    desktop_notifications: true,
    notification_sounds: true,
    unread_badge: true,
    input_device: 'default',
    output_device: 'default',
    video_device: 'default',
    input_volume: 100,
    output_volume: 100,
    input_mode: 'vad',
    ptt_key: '',
    vad_threshold: -50,
    echo_cancellation: true,
    noise_suppression: true,
    auto_gain: true,
    keybinds: [],
    stream_resolution: 1080,
    stream_fps: 30,
    stream_optimize: 'motion',
    guild_folders: [],
    guild_positions: [],
    custom_status: null,
    status: 'online',
  };
}
