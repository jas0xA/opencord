import { useState } from 'react';
import {
  ChevronDown, ChevronRight, FolderPlus, LogOut, Pencil, Plus, Settings, ShieldCheck, Store, UserPlus, Users, X,
  BellOff, Mic, MicOff, Headphones, HeadphoneOff, Video, Monitor, Volume2,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { ChannelType, Permissions, RelationshipType, type Channel, type GuildFull } from '@opencord/shared';
import { api, cdn } from '../lib/api';
import { parseCrop, stripCrop } from '../lib/crop';
import {
  ackChannel, can, canView, displayName, isUnread, navigate, openDm, openDmWith, openModal, setStatus, sortedChannels, toast, useStore,
} from '../lib/store';
import { voice } from '../lib/voice';
import { copy } from '../lib/utils';
import { Avatar } from './Avatar';
import { Nameplate, StyledName } from './Cosmetics';
import { AnnouncementIcon, FriendsIcon, HashIcon, SpeakerIcon } from './Icons';
import { closeLayers, openContextMenu, openPopout, Tooltip } from './Layers';
import { userControlItems } from './UserControls';
import { UserPopout } from './Profile';
import { Soundboard } from './Pickers';
import { useVoice } from './Voice';

/* ───────────────────────── Home (DMs) sidebar ───────────────────────── */

function DmItem({ channel }: { channel: Channel }) {
  const me = useStore((s) => s.me);
  const active = useStore((s) => s.route.kind === 'home' && s.route.channelId === channel.id);
  const unread = useStore(() => isUnread(channel));
  const mentions = useStore((s) => s.readStates[channel.id]?.mention_count ?? 0);
  const other = channel.recipients?.find((r) => r.id !== me?.id) ?? channel.recipients?.[0];
  const presence = useStore((s) => (other ? s.presences[other.id] : undefined));
  const isGroup = channel.type === ChannelType.GROUP_DM;
  const name = isGroup
    ? channel.name || (channel.recipients ?? []).filter((r) => r.id !== me?.id).map((r) => displayName(r)).join(', ') || 'Unnamed'
    : displayName(other);
  const custom = presence?.custom_status;
  const activity = presence?.activities[0];
  const sub = isGroup ? `${channel.recipients?.length ?? 0} Members` : custom ? `${custom.emoji ? custom.emoji + ' ' : ''}${custom.text}` : activity ? `Playing ${activity.name}` : null;

  const close = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isGroup) {
      openModal({
        type: 'confirm',
        title: `Leave '${name}'`,
        body: 'Are you sure you want to leave this group? You won\'t be able to rejoin unless you are re-invited.',
        confirm: 'Leave Group',
        danger: true,
        onConfirm: () => api.del(`/channels/${channel.id}`),
      });
    } else {
      await api.del(`/channels/${channel.id}`);
      if (active) navigate({ kind: 'home', view: 'friends' });
    }
  };

  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { label: 'Mark As Read', onClick: () => ackChannel(channel.id) },
      { separator: true },
      !isGroup && other && { label: 'Profile', onClick: () => openModal({ type: 'profile', userId: other.id }) },
      !isGroup && other && { label: 'Call', onClick: () => (openDm(channel.id), voice.join(channel.id, null)) },
      isGroup && { label: 'Change Icon / Name', onClick: () => openModal({ type: 'channel-settings', channelId: channel.id }) },
      ...(!isGroup && other ? userControlItems(other.id) : []),
      { separator: true },
      { label: isGroup ? 'Leave Group' : 'Close DM', danger: isGroup, onClick: () => close(e) },
      me?.settings.developer_mode && { label: 'Copy Channel ID', onClick: () => copy(channel.id) },
    ]);

  return (
    <div className={`dm-item${active ? ' active' : ''}${unread && !active ? ' unread' : ''}`} onClick={() => openDm(channel.id)} onContextMenu={menu}>
      {!isGroup && other?.nameplate && <Nameplate id={other.nameplate} />}
      {isGroup ? (
        channel.icon ? (
          <img src={cdn(channel.icon)!} alt="" style={{ width: 32, height: 32, borderRadius: '50%', zIndex: 1 }} />
        ) : (
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#e8701a', display: 'grid', placeItems: 'center', zIndex: 1 }}>
            <Users size={18} color="#fff" />
          </div>
        )
      ) : (
        <div style={{ zIndex: 1 }}>
          <Avatar user={other} size={32} status ring={active ? 'var(--bg-selected)' : 'var(--bg-base)'} />
        </div>
      )}
      <div className="dm-text">
        <div className="dm-name">
          <StyledName user={isGroup ? null : other}>{name}</StyledName>
        </div>
        {sub && <div className="dm-sub">{sub}</div>}
      </div>
      {mentions > 0 && !active ? (
        <span className="badge-count">{mentions}</span>
      ) : (
        <button className="dm-close" onClick={close} aria-label="Close">
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export function HomeSidebar() {
  const route = useStore((s) => s.route);
  const channelIds = useStore(
    useShallow((s) =>
      Object.values(s.privateChannels)
        .sort((a, b) => {
          const av = BigInt(a.last_message_id ?? a.id);
          const bv = BigInt(b.last_message_id ?? b.id);
          return av > bv ? -1 : av < bv ? 1 : 0;
        })
        .map((c) => c.id),
    ),
  );
  const channels = useStore((s) => s.privateChannels);
  const pending = useStore((s) => Object.values(s.relationships).filter((r) => r.type === RelationshipType.INCOMING).length);
  const isAdmin = useStore((s) => !!s.me?.admin);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="find-button" onClick={() => openModal({ type: 'create-dm' })}>
          Find or start a conversation
        </button>
      </div>
      <div className="sidebar-scroll scroller thin">
        <div className={`nav-item${route.kind === 'home' && route.view === 'friends' ? ' active' : ''}`} onClick={() => navigate({ kind: 'home', view: 'friends' })}>
          <FriendsIcon size={24} />
          Friends
          {pending > 0 && <span className="badge-count">{pending}</span>}
        </div>
        <div className={`nav-item${route.kind === 'home' && route.view === 'marketplace' ? ' active' : ''}`} onClick={() => navigate({ kind: 'home', view: 'marketplace' })}>
          <Store size={22} />
          Marketplace
          <span className="badge-new">NEW</span>
        </div>
        {isAdmin && (
          <div className="nav-item" onClick={() => useStore.setState({ settings: { kind: 'user', section: 'admin' } })}>
            <ShieldCheck size={22} />
            Server Admin
          </div>
        )}
        <div className="sidebar-sep" />
        <div className="dm-header">
          <span>Direct Messages</span>
          <Tooltip text="Create DM">
            <button onClick={() => openModal({ type: 'create-dm' })}>
              <Plus size={16} />
            </button>
          </Tooltip>
        </div>
        {channelIds.map((id) => channels[id] && <DmItem key={id} channel={channels[id]} />)}
      </div>
    </div>
  );
}

/* ───────────────────────── Guild sidebar ───────────────────────── */

function GuildMenu({ guild }: { guild: GuildFull }) {
  const isOwner = useStore((s) => s.me?.id === guild.owner_id);
  const settings = can(Permissions.MANAGE_GUILD, guild.id) || can(Permissions.MANAGE_ROLES, guild.id) || can(Permissions.BAN_MEMBERS, guild.id) || can(Permissions.VIEW_AUDIT_LOG, guild.id) || can(Permissions.KICK_MEMBERS, guild.id);
  const item = (label: string, icon: React.ReactNode, onClick: () => void, danger?: boolean, brand?: boolean) => (
    <button className={`cm-item${danger ? ' danger' : ''}`} style={brand ? { color: '#949cf7' } : undefined} onClick={() => (closeLayers(), onClick())}>
      {label}
      <span className="cm-right">{icon}</span>
    </button>
  );
  return (
    <div className="context-menu" style={{ position: 'static', width: 220, animation: 'none', border: 0, boxShadow: 'none' }}>
      {can(Permissions.CREATE_INVITE, guild.id) && item('Invite People', <UserPlus size={18} />, () => openModal({ type: 'invite', guildId: guild.id }), false, true)}
      {settings && item('Server Settings', <Settings size={18} />, () => useStore.setState({ settings: { kind: 'guild', guildId: guild.id, section: 'profile' } }))}
      {can(Permissions.MANAGE_CHANNELS, guild.id) && item('Create Channel', <Plus size={18} />, () => openModal({ type: 'create-channel', guildId: guild.id, parentId: null }))}
      {can(Permissions.MANAGE_CHANNELS, guild.id) && item('Create Category', <FolderPlus size={18} />, () => openModal({ type: 'create-channel', guildId: guild.id, parentId: null, channelType: ChannelType.GUILD_CATEGORY }))}
      <div className="cm-sep" />
      {item('Edit Server Profile', <Pencil size={18} />, () => openModal({ type: 'nickname', guildId: guild.id, userId: useStore.getState().me!.id }))}
      {item('Mark As Read', <BellOff size={18} />, () => guild.channels.forEach((c) => isUnread(c) && ackChannel(c.id)))}
      {!isOwner && <div className="cm-sep" />}
      {!isOwner && item('Leave Server', <LogOut size={18} />, () => openModal({ type: 'leave-guild', guildId: guild.id }), true)}
    </div>
  );
}

function ChannelItem({ guild, channel }: { guild: GuildFull; channel: Channel }) {
  const active = useStore((s) => s.route.kind === 'guild' && s.route.channelId === channel.id);
  const unread = useStore(() => isUnread(channel));
  const mentions = useStore((s) => s.readStates[channel.id]?.mention_count ?? 0);
  const devMode = useStore((s) => s.me?.settings.developer_mode);
  const voiceIds = useStore(useShallow((s) => Object.values(s.voiceStates).filter((v) => v.channel_id === channel.id).map((v) => v.user_id)));
  const voiceStates = useStore((s) => s.voiceStates);
  const snap = useVoice();
  const isVoice = channel.type === ChannelType.GUILD_VOICE || channel.type === ChannelType.GUILD_STAGE;
  const manage = can(Permissions.MANAGE_CHANNELS, guild.id, channel.id);
  const Icon = isVoice ? SpeakerIcon : channel.type === ChannelType.GUILD_ANNOUNCEMENT ? AnnouncementIcon : HashIcon;

  const open = () => {
    if (isVoice) {
      if (voice.channelId !== channel.id) {
        if (!can(Permissions.CONNECT, guild.id, channel.id)) return toast('You do not have permission to join this channel.');
        voice.join(channel.id, guild.id);
      }
      navigate({ kind: 'guild', guildId: guild.id, channelId: channel.id });
      useStore.setState({ voiceView: true });
    } else navigate({ kind: 'guild', guildId: guild.id, channelId: channel.id });
  };

  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      !isVoice && { label: 'Mark As Read', onClick: () => ackChannel(channel.id) },
      can(Permissions.CREATE_INVITE, guild.id, channel.id) && { label: 'Invite People', onClick: () => openModal({ type: 'invite', guildId: guild.id, channelId: channel.id }) },
      { separator: true },
      manage && { label: 'Edit Channel', onClick: () => openModal({ type: 'channel-settings', channelId: channel.id }) },
      manage && {
        label: 'Delete Channel',
        danger: true,
        onClick: () =>
          openModal({
            type: 'confirm',
            title: 'Delete Channel',
            body: `Are you sure you want to delete #${channel.name}? This cannot be undone.`,
            confirm: 'Delete Channel',
            danger: true,
            onConfirm: () => api.del(`/channels/${channel.id}`),
          }),
      },
      devMode && { separator: true },
      devMode && { label: 'Copy Channel ID', onClick: () => copy(channel.id) },
    ]);

  return (
    <>
      <div className={`channel-item${active ? ' active' : ''}${unread && !isVoice && !active ? ' unread' : ''}`} onClick={open} onContextMenu={menu}>
        <Icon size={20} className="ch-icon" />
        <span className="ch-name">{channel.name}</span>
        {mentions > 0 && !active && <span className="badge-count">{mentions}</span>}
        <div className="ch-actions">
          {can(Permissions.CREATE_INVITE, guild.id, channel.id) && (
            <Tooltip text="Create Invite">
              <button onClick={(e) => (e.stopPropagation(), openModal({ type: 'invite', guildId: guild.id, channelId: channel.id }))}>
                <UserPlus size={16} />
              </button>
            </Tooltip>
          )}
          {manage && (
            <Tooltip text="Edit Channel">
              <button onClick={(e) => (e.stopPropagation(), openModal({ type: 'channel-settings', channelId: channel.id }))}>
                <Settings size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {isVoice && voiceIds.length > 0 && (
        <div className="voice-members">
          {voiceIds.map((uid) => {
            const v = voiceStates[uid];
            const m = guild.members.find((x) => x.user.id === uid);
            return (
              <div
                key={uid}
                className="voice-member"
                onClick={(e) => openPopout(e, `vm-${uid}`, () => <UserPopout userId={uid} guildId={guild.id} />)}
                onContextMenu={(e) => memberMenu(e, guild, uid)}
              >
                <Avatar user={m?.user} size={24} speaking={snap.speaking.has(uid)} decoration={false} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: snap.speaking.has(uid) ? 'var(--text-strong)' : undefined }}>
                  {displayName(m?.user, guild.id)}
                </span>
                <span className="vm-icons">
                  {v?.self_stream && <span className="live">LIVE</span>}
                  {v?.self_video && <Video size={14} />}
                  {(v?.self_mute || v?.mute) && <MicOff size={14} color={v?.mute ? 'var(--red-status)' : undefined} />}
                  {(v?.self_deaf || v?.deaf) && <HeadphoneOff size={14} color={v?.deaf ? 'var(--red-status)' : undefined} />}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Right-click menu for a guild member (moderation lives here). */
export function memberMenu(e: React.MouseEvent, guild: GuildFull, userId: string) {
  const s = useStore.getState();
  const me = s.me!;
  const self = userId === me.id;
  const v = s.voiceStates[userId];
  const inVoice = v?.guild_id === guild.id;
  const rel = s.relationships[userId];
  const myTop = guild.owner_id === me.id ? Infinity : Math.max(0, ...guild.roles.filter((r) => guild.members.find((m) => m.user.id === me.id)?.roles.includes(r.id)).map((r) => r.position));
  const theirTop = guild.owner_id === userId ? Infinity : Math.max(0, ...guild.roles.filter((r) => guild.members.find((m) => m.user.id === userId)?.roles.includes(r.id)).map((r) => r.position));
  const above = !self && myTop > theirTop;
  const member = guild.members.find((m) => m.user.id === userId);
  openContextMenu(e, [
    { label: 'Profile', onClick: () => openModal({ type: 'profile', userId, guildId: guild.id }) },
    !self && { label: 'Message', onClick: () => openDmWith(userId) },
    !self && !rel && { label: 'Add Friend', onClick: () => api.put(`/users/@me/relationships/${userId}`).catch((err) => toast(err.message)) },
    { separator: true },
    (self ? can(Permissions.CHANGE_NICKNAME, guild.id) : can(Permissions.MANAGE_NICKNAMES, guild.id) && above) && {
      label: self ? 'Edit Server Profile' : 'Change Nickname',
      onClick: () => openModal({ type: 'nickname', guildId: guild.id, userId }),
    },
    inVoice && can(Permissions.MUTE_MEMBERS, guild.id) && { label: v.mute ? 'Server Unmute' : 'Server Mute', onClick: () => api.patch(`/guilds/${guild.id}/members/${userId}`, { mute: !v.mute }) },
    inVoice && can(Permissions.DEAFEN_MEMBERS, guild.id) && { label: v.deaf ? 'Server Undeafen' : 'Server Deafen', onClick: () => api.patch(`/guilds/${guild.id}/members/${userId}`, { deaf: !v.deaf }) },
    inVoice && can(Permissions.MOVE_MEMBERS, guild.id) && !self && { label: 'Disconnect', danger: true, onClick: () => api.patch(`/guilds/${guild.id}/members/${userId}`, { channel_id: null }) },
    { separator: true },
    above && can(Permissions.MODERATE_MEMBERS, guild.id) &&
      (member?.communication_disabled_until
        ? { label: 'Remove Timeout', onClick: () => api.patch(`/guilds/${guild.id}/members/${userId}`, { communication_disabled_until: null }) }
        : { label: `Timeout ${displayName(member?.user, guild.id)}`, danger: true, onClick: () => openModal({ type: 'moderate', action: 'timeout', guildId: guild.id, userId }) }),
    above && can(Permissions.KICK_MEMBERS, guild.id) && { label: `Kick ${displayName(member?.user, guild.id)}`, danger: true, onClick: () => openModal({ type: 'moderate', action: 'kick', guildId: guild.id, userId }) },
    above && can(Permissions.BAN_MEMBERS, guild.id) && { label: `Ban ${displayName(member?.user, guild.id)}`, danger: true, onClick: () => openModal({ type: 'moderate', action: 'ban', guildId: guild.id, userId }) },
    { separator: true },
    can(Permissions.MANAGE_ROLES, guild.id) && { label: 'Roles…', onClick: () => openModal({ type: 'profile', userId, guildId: guild.id }) },
    ...userControlItems(userId),
    me.settings.developer_mode && { separator: true },
    me.settings.developer_mode && { label: 'Copy User ID', onClick: () => copy(userId) },
  ]);
}

export function GuildSidebar({ guild }: { guild: GuildFull }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(`opencord.collapsed.${guild.id}`) ?? '{}');
    } catch {
      return {};
    }
  });
  const [menuOpen, setMenuOpen] = useState(false);
  useStore((s) => s.readStates);
  useStore((s) => s.me?.id);
  const toggle = (id: string) => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    localStorage.setItem(`opencord.collapsed.${guild.id}`, JSON.stringify(next));
  };
  const channels = sortedChannels(guild).filter((c) => canView(guild, c));
  const banner = guild.banner ? `url(${stripCrop(cdn(guild.banner)!)})` : null;
  const bannerCrop = parseCrop(guild.banner);
  const activeId = useStore((s) => (s.route.kind === 'guild' ? s.route.channelId : null));

  const out: React.ReactNode[] = [];
  for (const c of channels) {
    if (c.type === ChannelType.GUILD_CATEGORY) {
      out.push(
        <div
          key={c.id}
          className="channel-category"
          onClick={() => toggle(c.id)}
          onContextMenu={(e) =>
            openContextMenu(e, [
              { label: collapsed[c.id] ? 'Expand Category' : 'Collapse Category', onClick: () => toggle(c.id) },
              can(Permissions.MANAGE_CHANNELS, guild.id) && { label: 'Edit Category', onClick: () => openModal({ type: 'channel-settings', channelId: c.id }) },
              can(Permissions.MANAGE_CHANNELS, guild.id) && {
                label: 'Delete Category',
                danger: true,
                onClick: () => openModal({ type: 'confirm', title: 'Delete Category', body: `Delete ${c.name}? Channels inside will be kept.`, confirm: 'Delete', danger: true, onConfirm: () => api.del(`/channels/${c.id}`) }),
              },
            ])
          }
        >
          {collapsed[c.id] ? <ChevronRight size={12} strokeWidth={3} /> : <ChevronDown size={12} strokeWidth={3} />}
          <span>{c.name}</span>
          {can(Permissions.MANAGE_CHANNELS, guild.id) && (
            <span className="actions">
              <Tooltip text="Create Channel">
                <button onClick={(e) => (e.stopPropagation(), openModal({ type: 'create-channel', guildId: guild.id, parentId: c.id }))}>
                  <Plus size={16} />
                </button>
              </Tooltip>
            </span>
          )}
        </div>,
      );
      continue;
    }
    const parent = c.parent_id ?? null;
    if (parent && collapsed[parent] && c.id !== activeId && !(isUnread(c) && c.type !== ChannelType.GUILD_VOICE)) continue;
    out.push(<ChannelItem key={c.id} guild={guild} channel={c} />);
  }

  return (
    <div className="sidebar">
      <div
        className={`guild-header${banner ? ' with-banner' : ''}`}
        style={banner ? { backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.5), transparent 50%), ${banner}`, backgroundPosition: bannerCrop ? `center, ${bannerCrop.x}% ${bannerCrop.y}%` : undefined } : undefined}
        onClick={(e) => {
          setMenuOpen(true);
          openPopout(e.currentTarget.getBoundingClientRect(), `guild-menu-${guild.id}`, () => <GuildMenu guild={guild} />, 'bottom');
          setTimeout(() => setMenuOpen(false), 0);
        }}
      >
        <span className="name">{guild.name}</span>
        {menuOpen ? <X size={18} /> : <ChevronDown size={18} />}
      </div>
      <div className="channel-list scroller thin">
        {out}
        {channels.length === 0 && <div className="empty-state" style={{ fontSize: 14 }}>No channels you can see.</div>}
      </div>
    </div>
  );
}

/* ───────────────────────── User panel ───────────────────────── */

function StatusMenu() {
  const me = useStore((s) => s.me)!;
  const set = (status: 'online' | 'idle' | 'dnd' | 'invisible') => {
    setStatus(status);
    closeLayers();
  };
  const opts: { id: 'online' | 'idle' | 'dnd' | 'invisible'; label: string; desc?: string }[] = [
    { id: 'online', label: 'Online' },
    { id: 'idle', label: 'Idle' },
    { id: 'dnd', label: 'Do Not Disturb', desc: 'You will not receive desktop notifications' },
    { id: 'invisible', label: 'Invisible', desc: 'You will appear offline' },
  ];
  return (
    <div className="status-menu">
      <UserPopout userId={me.id} embedded />
      <div className="cm-sep" />
      {opts.map((o) => (
        <button key={o.id} className="cm-item" onClick={() => set(o.id)} style={{ alignItems: 'flex-start' }}>
          <span style={{ paddingTop: 3 }}>
            <svg width="12" height="12"><circle cx="6" cy="6" r="6" fill={o.id === 'online' ? '#45a366' : o.id === 'idle' ? '#f0b232' : o.id === 'dnd' ? '#ed4245' : '#82838b'} /></svg>
          </span>
          <span>
            {o.label}
            {o.desc && <div style={{ fontSize: 12, opacity: 0.8 }}>{o.desc}</div>}
          </span>
        </button>
      ))}
      <div className="cm-sep" />
      <button className="cm-item" onClick={() => (closeLayers(), openModal({ type: 'status' }))}>
        {me.settings.custom_status ? 'Edit Custom Status' : 'Set Custom Status'}
      </button>
    </div>
  );
}

function VoicePanel() {
  const snap = useVoice();
  const channel = useStore((s) => {
    if (!snap.channelId) return null;
    if (snap.guildId) return s.guilds[snap.guildId]?.channels.find((c) => c.id === snap.channelId) ?? null;
    return s.privateChannels[snap.channelId] ?? null;
  });
  const guild = useStore((s) => (snap.guildId ? s.guilds[snap.guildId] : null));
  const me = useStore((s) => s.me);
  if (!snap.channelId) return null;
  const connected = snap.rtc === 'connected';
  const name = guild ? `${channel?.name ?? 'Voice'} / ${guild.name}` : channel?.type === ChannelType.GROUP_DM ? channel.name || 'Group Call' : displayName(channel?.recipients?.find((r) => r.id !== me?.id));
  return (
    <div className="voice-panel">
      <div className="vp-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="vp-status" style={snap.rtc === 'failed' ? { color: 'var(--red-status)' } : !connected ? { color: 'var(--yellow-status)' } : undefined}>
            <Volume2 size={16} />
            {connected ? 'Voice Connected' : snap.rtc === 'failed' ? 'No Route' : 'Connecting…'}
            {snap.ping != null && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>{snap.ping} ms</span>}
          </div>
          <div
            className="vp-channel"
            onClick={() => {
              if (snap.guildId) navigate({ kind: 'guild', guildId: snap.guildId, channelId: snap.channelId });
              else openDm(snap.channelId!);
              if (snap.guildId) useStore.setState({ voiceView: true });
            }}
          >
            {name}
          </div>
        </div>
        <Tooltip text="Disconnect">
          <button className="icon-btn" onClick={() => voice.leave()}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M21.1 13.4c-.6.6-1.6.7-2.3.2l-1.6-1.1c-.5-.4-.8-1-.7-1.6l.1-.9c-2.9-.8-6.2-.8-9.1 0l.1.9c.1.6-.2 1.2-.7 1.6l-1.6 1.1c-.7.5-1.7.4-2.3-.2l-.9-.9c-.6-.6-.6-1.5 0-2.1 5-4.6 13-4.6 18 0 .6.6.6 1.5 0 2.1l-.9.9Z" /></svg>
          </button>
        </Tooltip>
      </div>
      <div className="vp-buttons">
        <Tooltip text={snap.camera ? 'Turn Off Camera' : 'Turn On Camera'}>
          <button className={snap.camera ? 'on' : ''} onClick={() => voice.setCamera(!snap.camera)}>
            <Video size={18} />
          </button>
        </Tooltip>
        <Tooltip text={snap.screen ? 'Stream Quality / Stop' : 'Share Your Screen'}>
          <button className={snap.screen ? 'on' : ''} onClick={() => openModal({ type: 'screen-share' })}>
            <Monitor size={18} />
          </button>
        </Tooltip>
        <Tooltip text="Soundboard">
          <button
            disabled={!snap.guildId}
            style={!snap.guildId ? { opacity: 0.4 } : undefined}
            onClick={(e) => snap.guildId && openPopout(e, 'soundboard', () => <Soundboard guildId={snap.guildId!} />, 'top')}
          >
            <span style={{ fontSize: 16 }}>🔊</span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

export function UserPanel() {
  const me = useStore((s) => s.me);
  const status = useStore((s) => (s.me ? s.presences[s.me.id]?.status ?? s.me.settings.status : 'online'));
  const snap = useVoice();
  if (!me) return null;
  const custom = me.settings.custom_status;
  return (
    <div className="user-panel-wrap">
      <VoicePanel />
      <div className="user-panel">
        <div className="who" onClick={(e) => openPopout((e.currentTarget as HTMLElement).getBoundingClientRect(), 'status-menu', () => <StatusMenu />, 'top')}>
          <Avatar user={me} size={32} status={status} ring="var(--bg-content)" />
          <div className="who-text">
            <div className="who-name"><StyledName user={me}>{me.display_name || me.username}</StyledName></div>
            <div className="who-status">{custom?.text ? `${custom.emoji ? custom.emoji + ' ' : ''}${custom.text}` : status === 'invisible' ? 'Invisible' : status === 'dnd' ? 'Do Not Disturb' : status === 'idle' ? 'Idle' : 'Online'}</div>
          </div>
        </div>
        <div className="controls">
          <div className="split-btn">
            <Tooltip text={snap.muted ? 'Unmute' : 'Mute'}>
              <button className={`main${snap.muted ? ' off' : ''}`} onClick={() => voice.toggleMute()}>
                {snap.muted ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
            </Tooltip>
            <button className="chev" onClick={() => useStore.setState({ settings: { kind: 'user', section: 'voice' } })}>
              <ChevronDown size={14} />
            </button>
          </div>
          <div className="split-btn">
            <Tooltip text={snap.deafened ? 'Undeafen' : 'Deafen'}>
              <button className={`main${snap.deafened ? ' off' : ''}`} onClick={() => voice.toggleDeafen()}>
                {snap.deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
              </button>
            </Tooltip>
            <button className="chev" onClick={() => useStore.setState({ settings: { kind: 'user', section: 'voice' } })}>
              <ChevronDown size={14} />
            </button>
          </div>
          <Tooltip text="User Settings">
            <button className="icon-btn" onClick={() => useStore.setState({ settings: { kind: 'user', section: 'account' } })}>
              <Settings size={20} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

