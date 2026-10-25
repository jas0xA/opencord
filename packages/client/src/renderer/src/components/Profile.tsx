import { useEffect, useState, type CSSProperties } from 'react';
import { Check, MoreHorizontal, Pencil, Plus, UserPlus, X, MessageCircle, UserCheck, Clock } from 'lucide-react';
import { CONNECTION_PROVIDERS, Permissions, RelationshipType, type Connection, type GuildMember, type PublicUser } from '@opencord/shared';
import { api, cdn } from '../lib/api';
import {
  can, closeModal, displayName, getUser, highestRole, openDmWith, openGuild, openModal, sendMessage, statusOf, toast, useStore,
} from '../lib/store';
import { formatShortDate, copy } from '../lib/utils';
import { Avatar } from './Avatar';
import { ProfileEffect, StyledName, useBannerStyle } from './Cosmetics';
import { GuildIcon } from './GuildRail';
import { BadgeIcon } from './Icons';
import { closeLayers, openContextMenu, Tooltip } from './Layers';
import { openExternal } from '../lib/web';

interface ProfileData {
  user: PublicUser;
  connections: Connection[];
  mutual_guilds: { id: string; nick: string | null }[];
  mutual_friends: PublicUser[];
  guild_member: GuildMember | null;
}

const cache = new Map<string, { at: number; data: ProfileData }>();

const PUBLIC_FIELDS = ['username', 'display_name', 'avatar', 'banner', 'banner_color', 'accent_color', 'theme_colors', 'pronouns', 'bio', 'badges',
  'avatar_decoration', 'profile_effect', 'nameplate', 'display_name_style'] as const;
function profileVersion(u: PublicUser | null | undefined) {
  return u ? JSON.stringify(PUBLIC_FIELDS.map((k) => u[k])) : '';
}

export function useProfile(userId: string, guildId?: string) {
  const key = `${userId}:${guildId ?? ''}`;
  const [data, setData] = useState<ProfileData | null>(cache.get(key)?.data ?? null);
  const user = useStore((s) => (s.me?.id === userId ? s.me : s.users[userId]));
  // Refetch whenever the live user changes (new connections, bio, cosmetics...), else reuse a fresh cache entry.
  const [bump, setBump] = useState(0);
  useEffect(() => {
    const onUpdate = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== userId) return;
      cache.delete(key);
      setBump((b) => b + 1);
    };
    window.addEventListener('opencord:user-update', onUpdate);
    return () => window.removeEventListener('opencord:user-update', onUpdate);
  }, [key]);
  const version = profileVersion(user);
  useEffect(() => {
    const c = cache.get(key);
    if (c && Date.now() - c.at < 30_000 && profileVersion(c.data.user) === version) return setData(c.data);
    api
      .get<ProfileData>(`/users/${userId}/profile${guildId ? `?guild_id=${guildId}` : ''}`)
      .then((d) => {
        cache.set(key, { at: Date.now(), data: d });
        setData(d);
      })
      .catch(() => {});
  }, [key, version, bump]);
  // Live user object wins over the fetched snapshot.
  return { data, user: user ?? data?.user ?? null };
}

export function connectionLogo(type: string, size = 24) {
  const p = CONNECTION_PROVIDERS.find((x) => x.id === type);
  const letters: Record<string, string> = {
    github: 'GH', x: '𝕏', steam: 'ST', spotify: 'SP', twitch: 'TW', youtube: '▶', reddit: 'RD', battlenet: 'BN', bluesky: '🦋',
    paypal: 'PP', ebay: 'eB', crunchyroll: 'CR', playstation: 'PS', xbox: 'XB', amazonmusic: 'AM', leagueoflegends: 'LoL',
    domain: '🌐', epicgames: 'EG', facebook: 'f', flickr: '••', roblox: 'RB',
  };
  return (
    <div className="conn-logo" style={{ background: p?.color ?? '#555', width: size, height: size, fontSize: size * 0.42 }}>
      {letters[type] ?? type.slice(0, 2).toUpperCase()}
    </div>
  );
}

function themeStyle(user: PublicUser | null): CSSProperties | undefined {
  if (!user?.theme_colors) return undefined;
  const [a, b] = user.theme_colors;
  return {
    background: `linear-gradient(180deg, ${a}, ${b})`,
    ['--card-bg' as string]: a,
    ['--status-ring' as string]: a,
  };
}

function RelationshipButtons({ user }: { user: PublicUser }) {
  const rel = useStore((s) => s.relationships[user.id]);
  const isMe = useStore((s) => s.me?.id === user.id);
  if (isMe) return null;
  const add = () => api.put(`/users/@me/relationships/${user.id}`).catch((e) => toast(e.message));
  const more = (e: React.MouseEvent) =>
    openContextMenu(e, [
      rel?.type === RelationshipType.FRIEND && { label: 'Remove Friend', danger: true, onClick: () => api.del(`/users/@me/relationships/${user.id}`) },
      rel?.type === RelationshipType.BLOCKED
        ? { label: 'Unblock', onClick: () => api.del(`/users/@me/relationships/${user.id}`) }
        : { label: 'Block', danger: true, onClick: () => api.put(`/users/@me/relationships/${user.id}`, { type: 2 }) },
      { separator: true },
      { label: 'Copy Username', onClick: () => copy(user.username) },
      useStore.getState().me?.settings.developer_mode && { label: 'Copy User ID', onClick: () => copy(user.id) },
    ]);
  return (
    <div className="pb-actions">
      {!rel && (
        <Tooltip text="Add Friend">
          <button onClick={add}><UserPlus size={16} /></button>
        </Tooltip>
      )}
      {rel?.type === RelationshipType.OUTGOING && (
        <Tooltip text="Friend Request Sent">
          <button><Clock size={16} /></button>
        </Tooltip>
      )}
      {rel?.type === RelationshipType.INCOMING && (
        <Tooltip text="Accept Friend Request">
          <button onClick={add}><UserCheck size={16} /></button>
        </Tooltip>
      )}
      {rel?.type === RelationshipType.FRIEND && (
        <Tooltip text="Friends">
          <button><UserCheck size={16} /></button>
        </Tooltip>
      )}
      <Tooltip text="More">
        <button onClick={more}><MoreHorizontal size={16} /></button>
      </Tooltip>
    </div>
  );
}

function Badges({ user }: { user: PublicUser }) {
  if (!user.badges.length) return null;
  return (
    <span className="profile-badges">
      {user.badges.map((b) => (
        <span key={b} className="pbadge"><BadgeIcon badge={b} size={16} /></span>
      ))}
    </span>
  );
}

function MutualServers({ guilds, onClick }: { guilds: { id: string }[]; onClick?: () => void }) {
  const all = useStore((s) => s.guilds);
  const list = guilds.map((g) => all[g.id]).filter(Boolean);
  if (!list.length) return null;
  return (
    <div className="profile-mutual" onClick={onClick}>
      <span className="mutual-icons">
        {list.slice(0, 3).map((g) => (g.icon ? <img key={g.id} src={cdn(g.icon)!} alt="" /> : <span key={g.id}>{g.name[0]}</span>))}
      </span>
      {list.length} Mutual Server{list.length === 1 ? '' : 's'}
    </div>
  );
}

function RolesSection({ guildId, userId }: { guildId: string; userId: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const member = guild?.members.find((m) => m.user.id === userId);
  if (!guild || !member) return null;
  const manage = can(Permissions.MANAGE_ROLES, guildId);
  const me = useStore.getState().me!;
  const myTop = guild.owner_id === me.id ? Infinity : highestRole(guild, me.id)?.position ?? 0;
  const roles = guild.roles.filter((r) => member.roles.includes(r.id)).sort((a, b) => b.position - a.position);
  const assignable = guild.roles.filter((r) => r.id !== guild.id && !member.roles.includes(r.id) && r.position < myTop && !r.managed);
  const setRoles = (ids: string[]) => api.patch(`/guilds/${guildId}/members/${userId}`, { roles: ids }).catch((e) => toast(e.message));
  return (
    <div className="profile-section">
      <h3>Roles</h3>
      <div className="profile-roles">
        {roles.map((r) => (
          <span key={r.id} className="role-pill">
            <span className="rp-dot" style={{ background: r.color ?? '#99aab5' }} />
            {r.name}
            {manage && r.position < myTop && (
              <button className="rp-x" onClick={() => setRoles(member.roles.filter((x) => x !== r.id))}><X size={12} /></button>
            )}
          </span>
        ))}
        {manage && assignable.length > 0 && (
          <Tooltip text="Add Role">
            <button
              className="role-pill"
              onClick={(e) => openContextMenu(e, assignable.sort((a, b) => b.position - a.position).map((r) => ({ label: r.name, onClick: () => setRoles([...member.roles, r.id]) })))}
            >
              <Plus size={14} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function Note({ userId }: { userId: string }) {
  const note = useStore((s) => s.notes[userId] ?? '');
  const [value, setValue] = useState(note);
  useEffect(() => setValue(note), [note]);
  return (
    <div className="profile-section">
      <h3>Note</h3>
      <textarea
        className="note-input"
        placeholder="Click to add a note"
        value={value}
        maxLength={256}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value === note) return;
          useStore.setState((s) => ({ notes: { ...s.notes, [userId]: value } }));
          api.put(`/users/@me/notes/${userId}`, { note: value });
        }}
      />
    </div>
  );
}

function CustomStatus({ userId }: { userId: string }) {
  const presence = useStore((s) => s.presences[userId]);
  const c = presence?.custom_status;
  const act = presence?.activities[0];
  if (!c && !act) return null;
  return (
    <div className="profile-custom-status">
      {c && (
        <div>
          {c.emoji} {c.text}
        </div>
      )}
      {act && <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>Playing <b>{act.name}</b></div>}
    </div>
  );
}

/** Right-hand DM profile panel (Image 1). */
export function ProfilePanel({ userId }: { userId: string }) {
  const { data, user } = useProfile(userId);
  const banner = useBannerStyle(user, user?.accent_color ?? '#e44d10');
  if (!user) return <div className="profile-panel"><div className="profile-card" /></div>;
  const theme = themeStyle(user);
  return (
    <div className="profile-panel">
      <div className={`profile-card${theme ? ' themed' : ''}`} style={theme}>
        <ProfileEffect id={user.profile_effect} />
        <div className="profile-banner" style={banner}>
          <RelationshipButtons user={user} />
        </div>
        <div className="profile-avatar" onClick={() => openModal({ type: 'profile', userId })}>
          <Avatar user={user} size={80} status ring={theme ? (theme['--card-bg' as keyof CSSProperties] as string) : 'var(--bg-panel)'} />
        </div>
        <div className="profile-info scroller thin">
          <div className="profile-name"><StyledName user={user}>{displayName(user)}</StyledName></div>
          <div className="profile-username">
            <span>{user.username}</span>
            {user.pronouns && <span style={{ color: 'var(--text-secondary)' }}>• {user.pronouns}</span>}
            <Badges user={user} />
          </div>
          <CustomStatus userId={userId} />
          {data && <MutualServers guilds={data.mutual_guilds} onClick={() => openModal({ type: 'profile', userId })} />}
          {user.bio && (
            <div className="profile-section">
              <h3>About Me</h3>
              <div className="ps-body selectable">{user.bio}</div>
            </div>
          )}
          <div className="profile-section">
            <h3>Member Since</h3>
            <div className="ps-body">{formatShortDate(user.created_at)}</div>
          </div>
          {data && data.connections.length > 0 && (
            <div className="profile-section">
              <h3>Connections</h3>
              <div className="profile-connections">
                {data.connections.map((c) => (
                  <div key={c.type + c.name} className="profile-connection" onClick={() => c.url && openExternal(c.url)}>
                    {connectionLogo(c.type, 20)}
                    {c.name}
                    {c.verified && <Check size={14} color="var(--green-status)" />}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="profile-footer">
            <button className="btn secondary full" style={{ height: 40, fontSize: 16 }} onClick={() => openModal({ type: 'profile', userId })}>
              View Full Profile
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small popout shown when clicking a name/avatar. */
export function UserPopout({ userId, guildId, embedded, preview }: { userId: string; guildId?: string; embedded?: boolean; preview?: PublicUser }) {
  const profile = useProfile(userId, guildId);
  const data = profile.data;
  const user = preview ?? profile.user;
  const isMe = useStore((s) => s.me?.id === userId);
  const banner = useBannerStyle(user, user?.accent_color ?? '#5865f2');
  const [msg, setMsg] = useState('');
  if (!user) return <div className="user-popout" style={{ height: 300 }} />;
  const theme = themeStyle(user);
  const nick = guildId ? useStore.getState().guilds[guildId]?.members.find((m) => m.user.id === userId)?.nick : null;
  return (
    <div className="user-popout" style={embedded ? { width: '100%' } : undefined}>
      <div className={`profile-card${theme ? ' themed' : ''}`} style={{ ...theme, ['--card-bg' as string]: theme ? undefined : 'var(--bg-floating)', background: theme?.background ?? 'var(--bg-floating)' }}>
        <ProfileEffect id={user.profile_effect} />
        <div className="profile-banner" style={{ ...banner, height: embedded ? 60 : 105 }}>{!embedded && <RelationshipButtons user={user} />}</div>
        <div className="profile-avatar" style={embedded ? { top: 16 } : undefined} onClick={() => (closeLayers(), openModal({ type: 'profile', userId, guildId }))}>
          <Avatar user={user} size={80} status ring={(theme?.['--card-bg' as keyof CSSProperties] as string) ?? 'var(--bg-floating)'} />
        </div>
        <div className="profile-info" style={{ flex: 'none' }}>
          <div className="profile-name"><StyledName user={user}>{nick || displayName(user)}</StyledName></div>
          <div className="profile-username">
            <span>{user.username}</span>
            {user.pronouns && <span style={{ color: 'var(--text-secondary)' }}>• {user.pronouns}</span>}
            <Badges user={user} />
          </div>
          {!embedded && <CustomStatus userId={userId} />}
          {!embedded && user.bio && (
            <div className="profile-section">
              <div className="ps-body selectable" style={{ maxHeight: 120, overflow: 'hidden' }}>{user.bio}</div>
            </div>
          )}
          {!embedded && data && !isMe && <MutualServers guilds={data.mutual_guilds} onClick={() => (closeLayers(), openModal({ type: 'profile', userId }))} />}
          {!embedded && guildId && <RolesSection guildId={guildId} userId={userId} />}
          {!embedded && isMe && !preview && (
            <button className="btn secondary full" style={{ marginTop: 16 }} onClick={() => (closeLayers(), useStore.setState({ settings: { kind: 'user', section: 'profiles' } }))}>
              <Pencil size={16} /> Edit Profile
            </button>
          )}
          {!embedded && !isMe && (
            <input
              className="input"
              style={{ marginTop: 16, height: 40, fontSize: 14 }}
              placeholder={`Message @${displayName(user)}`}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && msg.trim()) {
                  const text = msg.trim();
                  setMsg('');
                  closeLayers();
                  await openDmWith(userId);
                  const route = useStore.getState().route;
                  if (route.kind === 'home' && route.channelId) sendMessage(route.channelId, text);
                }
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Full profile modal. */
export function ProfileModal({ userId, guildId }: { userId: string; guildId?: string }) {
  const { data, user } = useProfile(userId, guildId);
  const isMe = useStore((s) => s.me?.id === userId);
  const guilds = useStore((s) => s.guilds);
  const banner = useBannerStyle(user, user?.accent_color ?? '#5865f2');
  const [tab, setTab] = useState<'about' | 'servers' | 'friends'>('about');
  if (!user) return null;
  const theme = themeStyle(user);
  return (
    <div className="modal profile-modal" onClick={(e) => e.stopPropagation()} style={{ padding: 0 }}>
      <div className={`profile-card${theme ? ' themed' : ''}`} style={{ ...theme, border: 0 }}>
        <ProfileEffect id={user.profile_effect} />
        <div className="profile-banner" style={banner}>
          <RelationshipButtons user={user} />
        </div>
        <div className="profile-avatar">
          <Avatar user={user} size={120} status ring={(theme?.['--card-bg' as keyof CSSProperties] as string) ?? 'var(--bg-panel)'} />
        </div>
        <div className="profile-info scroller thin" style={{ maxHeight: 'calc(100vh - 360px)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div className="profile-name" style={{ fontSize: 24, lineHeight: '30px' }}><StyledName user={user}>{displayName(user)}</StyledName></div>
              <div className="profile-username">
                <span>{user.username}</span>
                {user.pronouns && <span style={{ color: 'var(--text-secondary)' }}>• {user.pronouns}</span>}
                <Badges user={user} />
              </div>
            </div>
            {!isMe && (
              <button className="btn" onClick={() => (closeModal(), openDmWith(userId))}>
                <MessageCircle size={16} /> Message
              </button>
            )}
            {isMe && (
              <button className="btn secondary" onClick={() => (closeModal(), useStore.setState({ settings: { kind: 'user', section: 'profiles' } }))}>
                <Pencil size={16} /> Edit Profile
              </button>
            )}
          </div>
          <CustomStatus userId={userId} />
          <div className="profile-tabs">
            <button className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}>About Me</button>
            {!isMe && <button className={tab === 'servers' ? 'active' : ''} onClick={() => setTab('servers')}>{data?.mutual_guilds.length ?? 0} Mutual Servers</button>}
            {!isMe && <button className={tab === 'friends' ? 'active' : ''} onClick={() => setTab('friends')}>{data?.mutual_friends.length ?? 0} Mutual Friends</button>}
          </div>
          {tab === 'about' && (
            <>
              {user.bio && (
                <div className="profile-section">
                  <div className="ps-body selectable">{user.bio}</div>
                </div>
              )}
              <div className="profile-section">
                <h3>Member Since</h3>
                <div className="ps-body">{formatShortDate(user.created_at)}</div>
              </div>
              {guildId && <RolesSection guildId={guildId} userId={userId} />}
              {data && data.connections.length > 0 && (
                <div className="profile-section">
                  <h3>Connections</h3>
                  <div className="profile-connections" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                    {data.connections.map((c) => (
                      <div key={c.type + c.name} className="profile-connection" onClick={() => c.url && openExternal(c.url)}>
                        {connectionLogo(c.type, 24)}
                        <span style={{ flex: 1 }}>{c.name}</span>
                        {c.verified && <Check size={14} color="var(--green-status)" />}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!isMe && <Note userId={userId} />}
            </>
          )}
          {tab === 'servers' &&
            data?.mutual_guilds.map((g) =>
              guilds[g.id] ? (
                <div key={g.id} className="dm-item" onClick={() => (closeModal(), openGuild(g.id))}>
                  <GuildIcon guild={guilds[g.id]} size={36} />
                  <div className="dm-text">
                    <div className="dm-name" style={{ color: 'var(--text-strong)' }}>{guilds[g.id].name}</div>
                    {g.nick && <div className="dm-sub">{g.nick}</div>}
                  </div>
                </div>
              ) : null,
            )}
          {tab === 'friends' &&
            data?.mutual_friends.map((f) => (
              <div key={f.id} className="dm-item" onClick={() => openModal({ type: 'profile', userId: f.id })}>
                <Avatar user={getUser(f.id) ?? f} size={36} status={statusOf(f.id)} ring="var(--bg-panel)" />
                <div className="dm-text">
                  <div className="dm-name" style={{ color: 'var(--text-strong)' }}>{displayName(f)}</div>
                  <div className="dm-sub">{f.username}</div>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
