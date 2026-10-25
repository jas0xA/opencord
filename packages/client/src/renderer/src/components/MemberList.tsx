import { ChannelType, Permissions, hasPermission, type Channel, type GuildMember, type PublicUser } from '@opencord/shared';
import { channelPermissions, displayName, memberColor, statusOf, useStore } from '../lib/store';
import { Avatar } from './Avatar';
import { Nameplate, StyledName } from './Cosmetics';
import { openPopout } from './Layers';
import { UserPopout } from './Profile';
import { memberMenu } from './Sidebars';
import { Crown } from 'lucide-react';

function Row({ user, guildId, owner, offline }: { user: PublicUser; guildId: string | null; owner?: boolean; offline: boolean }) {
  const presence = useStore((s) => s.presences[user.id]);
  const color = useStore(() => memberColor(guildId, user.id));
  const sub = presence?.custom_status?.text ? `${presence.custom_status.emoji ?? ''} ${presence.custom_status.text}` : presence?.activities[0] ? `Playing ${presence.activities[0].name}` : null;
  return (
    <div
      className={`member-item${offline ? ' offline' : ''}`}
      onClick={(e) => openPopout(e, `member-${user.id}`, () => <UserPopout userId={user.id} guildId={guildId ?? undefined} />, 'left')}
      onContextMenu={(e) => {
        if (!guildId) return;
        const g = useStore.getState().guilds[guildId];
        if (g) memberMenu(e, g, user.id);
      }}
    >
      {user.nameplate && <Nameplate id={user.nameplate} />}
      <div style={{ zIndex: 1 }}>
        <Avatar user={user} size={32} status={offline ? undefined : true} ring="var(--bg-chat)" />
      </div>
      <div className="mi-text">
        <div className="mi-name" style={color ? { color } : undefined}>
          <StyledName user={user}>{displayName(user, guildId)}</StyledName>
          {owner && <Crown size={14} color="#f0b232" fill="#f0b232" />}
          {user.bot && <span className="msg-bot">BOT</span>}
        </div>
        {sub && !offline && <div className="mi-sub">{sub}</div>}
      </div>
    </div>
  );
}

export function MemberList({ channel }: { channel: Channel }) {
  const guild = useStore((s) => (channel.guild_id ? s.guilds[channel.guild_id] : null));
  useStore((s) => s.presences);

  if (channel.type === ChannelType.GROUP_DM) {
    const users = channel.recipients ?? [];
    return (
      <div className="member-list scroller thin">
        <div className="member-group">Members — {users.length}</div>
        {users.map((u) => (
          <Row key={u.id} user={u} guildId={null} owner={channel.owner_id === u.id} offline={statusOf(u.id) === 'offline'} />
        ))}
      </div>
    );
  }
  if (!guild) return null;

  // Only members who can see this channel are listed.
  const visible = guild.members.filter((m) => hasPermission(channelPermissions(guild, channel, m.user.id), Permissions.VIEW_CHANNEL));
  const hoisted = guild.roles.filter((r) => r.hoist && r.id !== guild.id).sort((a, b) => b.position - a.position);
  const groups: { title: string; members: GuildMember[] }[] = hoisted.map((r) => ({ title: r.name, members: [] }));
  const online: GuildMember[] = [];
  const offline: GuildMember[] = [];
  for (const m of visible) {
    if (statusOf(m.user.id) === 'offline') {
      offline.push(m);
      continue;
    }
    const idx = hoisted.findIndex((r) => m.roles.includes(r.id));
    if (idx >= 0) groups[idx].members.push(m);
    else online.push(m);
  }
  const sort = (a: GuildMember, b: GuildMember) => displayName(a.user, guild.id).localeCompare(displayName(b.user, guild.id));
  const sections = [...groups.filter((g) => g.members.length), { title: 'Online', members: online }, { title: 'Offline', members: offline }].filter((g) => g.members.length);

  return (
    <div className="member-list scroller thin">
      {sections.map((sec) => (
        <div key={sec.title}>
          <div className="member-group">{sec.title} — {sec.members.length}</div>
          {sec.members.sort(sort).map((m) => (
            <Row key={m.user.id} user={m.user} guildId={guild.id} owner={guild.owner_id === m.user.id} offline={sec.title === 'Offline'} />
          ))}
        </div>
      ))}
    </div>
  );
}
