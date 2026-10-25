import { useState } from 'react';
import { Compass, Plus, Store } from 'lucide-react';
import { ChannelType, Permissions, type GuildFull } from '@opencord/shared';
import { cropImgStyle, parseCrop } from '../lib/crop';
import { cdn } from '../lib/api';
import {
  ackChannel, can, canView, displayName, isUnread, mentionCount, navigate, openDm, openGuild, openModal, updateSettings, useStore,
} from '../lib/store';
import { acronym, copy } from '../lib/utils';
import { Avatar } from './Avatar';
import { Logo } from './Icons';
import { openContextMenu, Tooltip } from './Layers';

function guildUnread(g: GuildFull) {
  let unread = false;
  let mentions = 0;
  for (const c of g.channels) {
    if (c.type !== ChannelType.GUILD_TEXT && c.type !== ChannelType.GUILD_ANNOUNCEMENT) continue;
    if (!canView(g, c)) continue;
    if (isUnread(c)) unread = true;
    mentions += mentionCount(c.id);
  }
  return { unread, mentions };
}

export function GuildIcon({ guild, size = 40, radius }: { guild: Pick<GuildFull, 'icon' | 'name'>; size?: number; radius?: number }) {
  const short = acronym(guild.name);
  return (
    <div className={`rail-icon ${guild.icon ? 'has-img' : 'text-icon'}${short.length > 3 ? ' small' : ''}`} style={{ width: size, height: size, borderRadius: radius }}>
      {guild.icon ? <img src={cdn(guild.icon)!} alt="" style={cropImgStyle(parseCrop(guild.icon))} /> : short}
    </div>
  );
}

function GuildItem({ guild, onDragStart, onDrop, dropAbove }: { guild: GuildFull; onDragStart: () => void; onDrop: () => void; dropAbove: boolean }) {
  const active = useStore((s) => s.route.kind === 'guild' && s.route.guildId === guild.id);
  useStore((s) => s.readStates);
  const { unread, mentions } = guildUnread(guild);
  const devMode = useStore((s) => s.me?.settings.developer_mode);
  const isOwner = useStore((s) => s.me?.id === guild.owner_id);
  const [over, setOver] = useState(false);

  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      {
        label: 'Mark As Read',
        onClick: () => guild.channels.forEach((c) => isUnread(c) && ackChannel(c.id)),
      },
      { separator: true },
      can(Permissions.CREATE_INVITE, guild.id) && { label: 'Invite People', onClick: () => openModal({ type: 'invite', guildId: guild.id }) },
      (can(Permissions.MANAGE_GUILD, guild.id) || can(Permissions.MANAGE_ROLES, guild.id) || can(Permissions.BAN_MEMBERS, guild.id) || can(Permissions.VIEW_AUDIT_LOG, guild.id)) && {
        label: 'Server Settings',
        onClick: () => useStore.setState({ settings: { kind: 'guild', guildId: guild.id, section: 'profile' } }),
      },
      can(Permissions.MANAGE_CHANNELS, guild.id) && { label: 'Create Channel', onClick: () => openModal({ type: 'create-channel', guildId: guild.id, parentId: null }) },
      { separator: true },
      !isOwner && { label: 'Leave Server', danger: true, onClick: () => openModal({ type: 'leave-guild', guildId: guild.id }) },
      devMode && { separator: true },
      devMode && { label: 'Copy Server ID', onClick: () => copy(guild.id) },
    ]);

  return (
    <div
      className="rail-item"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop();
      }}
    >
      {over && dropAbove && <div className="rail-drop-indicator" style={{ top: -5 }} />}
      <div className={`rail-pill${active ? ' active' : unread ? ' unread' : ''}`} />
      <Tooltip text={guild.name} side="right">
        <div onClick={() => openGuild(guild.id)} onContextMenu={menu}>
          <GuildIcon guild={guild} />
        </div>
      </Tooltip>
      {mentions > 0 && <span className="badge-count rail-badge">{mentions > 99 ? '99+' : mentions}</span>}
    </div>
  );
}

export function GuildRail() {
  const isHome = useStore((s) => s.route.kind === 'home');
  const guildOrder = useStore((s) => s.guildOrder);
  const guilds = useStore((s) => s.guilds);
  const me = useStore((s) => s.me);
  const privateChannels = useStore((s) => s.privateChannels);
  useStore((s) => s.readStates);
  const [dragging, setDragging] = useState<string | null>(null);

  // DMs with unread messages are surfaced in the rail like on the reference client.
  const unreadDms = Object.values(privateChannels)
    .filter((c) => isUnread(c) && mentionCount(c.id) > 0)
    .sort((a, b) => (BigInt(b.last_message_id ?? 0) > BigInt(a.last_message_id ?? 0) ? 1 : -1))
    .slice(0, 5);

  const reorder = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    const order = guildOrder.filter((id) => id !== dragging);
    order.splice(order.indexOf(targetId), 0, dragging);
    useStore.setState({ guildOrder: order });
    updateSettings({ guild_positions: order });
    setDragging(null);
  };

  return (
    <nav className="guild-rail scroller none">
      <div className="rail-item">
        <div className={`rail-pill${isHome ? ' active' : ''}`} />
        <Tooltip text="Direct Messages" side="right">
          <div className={`rail-icon home${isHome ? ' active' : ''}`} onClick={() => navigate({ kind: 'home', view: 'friends' })}>
            <Logo size={26} style={{ ['--logo-cut' as string]: isHome ? '#5865f2' : 'var(--bg-panel)' }} />
          </div>
        </Tooltip>
      </div>
      {unreadDms.map((c) => {
        const other = c.recipients?.find((r) => r.id !== me?.id) ?? c.recipients?.[0];
        const name = c.type === ChannelType.GROUP_DM ? c.name || (c.recipients ?? []).filter((r) => r.id !== me?.id).map((r) => displayName(r)).join(', ') : displayName(other);
        const n = mentionCount(c.id);
        return (
          <div key={c.id} className="rail-item">
            <div className="rail-pill unread" />
            <Tooltip text={name} side="right">
              <div onClick={() => openDm(c.id)}>
                <Avatar user={other} size={40} decoration={false} />
              </div>
            </Tooltip>
            <span className="badge-count rail-badge">{n}</span>
          </div>
        );
      })}
      <div className="rail-sep" />
      {guildOrder.map((id) =>
        guilds[id] ? (
          <GuildItem key={id} guild={guilds[id]} onDragStart={() => setDragging(id)} onDrop={() => reorder(id)} dropAbove={!!dragging && dragging !== id} />
        ) : null,
      )}
      <div className="rail-item">
        <Tooltip text="Add a Server" side="right">
          <div className="rail-icon action" onClick={() => openModal({ type: 'create-guild' })}>
            <Plus size={22} />
          </div>
        </Tooltip>
      </div>
      <div className="rail-item">
        <Tooltip text="Marketplace" side="right">
          <div className="rail-icon action" onClick={() => navigate({ kind: 'home', view: 'marketplace' })}>
            <Store size={20} />
          </div>
        </Tooltip>
      </div>
      <div className="rail-item">
        <Tooltip text="Explore Servers" side="right">
          <div className="rail-icon action" onClick={() => navigate({ kind: 'home', view: 'explore' })}>
            <Compass size={22} />
          </div>
        </Tooltip>
      </div>
    </nav>
  );
}
