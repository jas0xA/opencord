import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Phone, Video, Pin, UserPlus, Users, CircleUserRound, Search, X, Bell, EyeOff } from 'lucide-react';
import { ChannelType, Permissions, RelationshipType, type Channel, type Message } from '@opencord/shared';
import { api, cdn } from '../lib/api';
import {
  ackChannel, can, displayName, findChannel, loadMessages, navigate, openDm, openModal, statusOf, toast, useStore,
} from '../lib/store';
import { voice } from '../lib/voice';
import { formatDay, isSameDay } from '../lib/utils';
import { Avatar } from './Avatar';
import { addFilesToComposer, Composer } from './Composer';
import { AnnouncementIcon, HashIcon, SpeakerIcon } from './Icons';
import { Tooltip } from './Layers';
import { MemberList } from './MemberList';
import { MessageItem } from './Message';
import { ProfilePanel } from './Profile';
import { DmCallArea, VoiceChannelView } from './Voice';
import { Markdown } from '../lib/markdown';
import { usePhone } from '../lib/web';

const GROUP_WINDOW = 7 * 60 * 1000;

function Welcome({ channel }: { channel: Channel }) {
  const me = useStore((s) => s.me);
  if (channel.type === ChannelType.DM) {
    const other = channel.recipients?.find((r) => r.id !== me?.id) ?? channel.recipients?.[0];
    const rel = useStore.getState().relationships[other?.id ?? ''];
    return (
      <div className="channel-welcome">
        <Avatar user={other} size={80} />
        <h1>{displayName(other)}</h1>
        <div className="cw-name2">{other?.username}</div>
        <div className="cw-sub">
          This is the beginning of your direct message history with <b>{displayName(other)}</b>.
        </div>
        <div className="cw-actions">
          {!rel && other && <button className="btn sm" onClick={() => api.put(`/users/@me/relationships/${other.id}`).catch((e) => toast(e.message))}>Add Friend</button>}
          {rel?.type === 1 && <button className="btn sm secondary" onClick={() => api.del(`/users/@me/relationships/${other!.id}`)}>Remove Friend</button>}
          {other && rel?.type !== 2 && <button className="btn sm secondary" onClick={() => api.put(`/users/@me/relationships/${other.id}`, { type: 2 })}>Block</button>}
        </div>
      </div>
    );
  }
  if (channel.type === ChannelType.GROUP_DM) {
    return (
      <div className="channel-welcome">
        <div className="cw-icon"><Users size={36} /></div>
        <h1>{channel.name || 'Group DM'}</h1>
        <div className="cw-sub">Welcome to the beginning of this group.</div>
      </div>
    );
  }
  return (
    <div className="channel-welcome">
      <div className="cw-icon"><HashIcon size={40} /></div>
      <h1>Welcome to #{channel.name}!</h1>
      <div className="cw-sub">This is the start of the #{channel.name} channel.{channel.topic ? ` ${channel.topic}` : ''}</div>
    </div>
  );
}

function MessageList({ channel }: { channel: Channel }) {
  const cm = useStore((s) => s.messages[channel.id]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevHeight = useRef(0);
  const prevFirst = useRef<string | null>(null);
  const canManage = useStore(() => (channel.guild_id ? can(Permissions.MANAGE_MESSAGES, channel.guild_id, channel.id) : false));
  const readState = useStore((s) => s.readStates[channel.id]);
  const [unreadMarker, setUnreadMarker] = useState<string | null>(null);
  // Messages from blocked or muted users collapse into a "Show" row; this holds the runs opened.
  const myId = useStore((s) => s.me?.id);
  const relationships = useStore((s) => s.relationships);
  const overrides = useStore((s) => s.me?.settings.user_overrides);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const toggleRun = (key: string) =>
    setRevealed((cur) => {
      const next = new Set(cur);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  useEffect(() => {
    stick.current = true;
    setUnreadMarker(readState?.last_message_id && channel.last_message_id !== readState.last_message_id ? readState.last_message_id : null);
    if (!cm?.loaded) loadMessages(channel.id).catch((e) => toast(e.message));
    ackChannel(channel.id);
  }, [channel.id]);

  useEffect(() => {
    if (document.hasFocus() && stick.current) ackChannel(channel.id);
  }, [channel.last_message_id]);

  useEffect(() => {
    const onFocus = () => stick.current && ackChannel(channel.id);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [channel.id]);

  // Keep the scroll anchored: at the bottom for new messages, in place when older ones load.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !cm) return;
    const first = cm.list[0]?.id ?? null;
    if (prevFirst.current && first !== prevFirst.current && prevHeight.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [cm?.list]);

  // Images load after layout; keep stuck to bottom when they do.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      prevHeight.current = el.scrollHeight;
    });
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [channel.id, !!cm?.loaded]);

  const onScroll = () => {
    const el = scrollRef.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (stick.current) ackChannel(channel.id);
    if (el.scrollTop < 400 && cm?.hasMore && !cm.loading && cm.list.length) {
      prevHeight.current = el.scrollHeight;
      loadMessages(channel.id, cm.list[0].id).catch(() => {});
    }
  };

  const list = cm?.list ?? [];
  const items: React.ReactNode[] = [];
  let prev: Message | null = null;
  const blockedAuthor = (m: Message) => relationships[m.author.id]?.type === RelationshipType.BLOCKED;
  const hidden = (m: Message) => m.author.id !== myId && !m.webhook_id && (blockedAuthor(m) || !!overrides?.[m.author.id]?.mute_messages);
  let run: { key: string; slot: number; count: number; blocked: boolean } | null = null;
  const closeRun = () => {
    if (!run) return;
    const { key, count, blocked } = run;
    const open = revealed.has(key);
    items[run.slot] = (
      <div key={`h-${key}`} className="hidden-run">
        <EyeOff size={16} />
        <span>
          {count} {count === 1 ? 'message' : 'messages'} from {blocked ? 'a blocked user' : 'a muted user'}
        </span>
        <button className="btn link sm" onClick={() => toggleRun(key)}>{open ? 'Hide' : 'Show'}</button>
      </div>
    );
    run = null;
  };
  // The day of the last message passed (shown or collapsed), separate from `prev`, which only drives grouping.
  let lastDay: number | null = null;
  for (const m of list) {
    if (lastDay === null || !isSameDay(lastDay, m.created_at)) {
      closeRun();
      items.push(<div key={`d-${m.id}`} className="day-divider"><span>{formatDay(m.created_at)}</span></div>);
      prev = null;
    }
    lastDay = m.created_at;
    if (hidden(m)) {
      if (!run) {
        run = { key: m.id, slot: items.length, count: 0, blocked: false };
        items.push(null);
      }
      run.count++;
      run.blocked ||= blockedAuthor(m);
      if (!revealed.has(run.key)) {
        prev = null;
        continue;
      }
    } else closeRun();
    if (unreadMarker && prev && BigInt(prev.id) <= BigInt(unreadMarker) && BigInt(m.id) > BigInt(unreadMarker) && !m.id.startsWith('pending')) {
      items.push(<div key={`u-${m.id}`} className="day-divider unread-divider"><span>NEW</span></div>);
    }
    const isNormal = (x: Message) => x.type === 0 || x.type === 19;
    const grouped = !!prev && isNormal(prev) && isNormal(m) && prev.author.id === m.author.id && m.created_at - prev.created_at < GROUP_WINDOW && !m.referenced_message && prev.webhook_id === m.webhook_id;
    items.push(<MessageItem key={m.nonce && m.id.startsWith('pending') ? m.nonce : m.id} m={m} grouped={grouped} canManage={canManage} />);
    prev = m;
  }
  closeRun();

  return (
    <div className="messages scroller" ref={scrollRef} onScroll={onScroll}>
      <div className="messages-inner">
        {cm?.loaded && !cm.hasMore && <Welcome channel={channel} />}
        {(!cm?.loaded || cm.loading) && cm?.hasMore !== false && <div className="empty-state" style={{ padding: 20 }}><div className="spinner" /></div>}
        {items}
      </div>
    </div>
  );
}

function TypingIndicator({ channel }: { channel: Channel }) {
  const typing = useStore((s) => s.typing[channel.id]);
  const users = useStore((s) => s.users);
  const ids = Object.keys(typing ?? {}).filter((id) => (typing?.[id] ?? 0) > Date.now());
  const names = ids.map((id) => displayName(users[id], channel.guild_id));
  if (!names.length) return null;
  return (
    <div className="typing">
      {(
        <>
          <span className="typing-dots"><i /><i /><i /></span>
          <span>
            {names.length > 3 ? 'Several people are typing…' : <><b>{names.join(', ')}</b> {names.length === 1 ? 'is' : 'are'} typing…</>}
          </span>
        </>
      )}
    </div>
  );
}

function SearchResults({ channel, query, onClose }: { channel: Channel; query: string; onClose: () => void }) {
  const [res, setRes] = useState<{ total: number; messages: Message[] } | null>(null);
  useEffect(() => {
    setRes(null);
    const params = new URLSearchParams();
    let content = query;
    const from = /from:(\S+)/.exec(query);
    if (from) {
      content = content.replace(from[0], '').trim();
      const u = Object.values(useStore.getState().users).find((x) => x.username === from[1].replace(/^@/, ''));
      if (u) params.set('author_id', u.id);
    }
    const has = /has:(link|file|image)/.exec(query);
    if (has) {
      content = content.replace(has[0], '').trim();
      params.set('has', has[1]);
    }
    if (content) params.set('content', content);
    const path = channel.guild_id ? `/guilds/${channel.guild_id}/messages/search` : `/channels/${channel.id}/messages/search`;
    api.get(`${path}?${params}`).then(setRes).catch((e) => toast(e.message));
  }, [query, channel.id]);
  return (
    <div className="member-list search-results scroller thin" style={{ width: 420, background: 'var(--bg-base)' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '16px 8px 8px', fontWeight: 600 }}>
        <span style={{ flex: 1 }}>{res ? `${res.total} Results` : 'Searching…'}</span>
        <button className="icon-btn" onClick={onClose}><X size={18} /></button>
      </div>
      {res?.messages.map((m) => {
        const ch = findChannel(m.channel_id);
        return (
          <div
            key={m.id}
            style={{ background: 'var(--bg-chat)', borderRadius: 8, padding: '8px 12px', marginBottom: 8, cursor: 'pointer' }}
            onClick={() => {
              if (ch?.guild_id) navigate({ kind: 'guild', guildId: ch.guild_id, channelId: ch.id });
              else openDm(m.channel_id);
              setTimeout(() => document.querySelector(`[data-id="${m.id}"]`)?.scrollIntoView({ block: 'center' }), 300);
            }}
          >
            {ch?.guild_id && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>#{ch.name}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <Avatar user={m.author} size={32} decoration={false} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: 'var(--text-strong)', fontSize: 14 }}>
                  {displayName(m.author, m.guild_id)} <span className="msg-time">{new Date(m.created_at).toLocaleString()}</span>
                </div>
                <div className="msg-content" style={{ fontSize: 14 }}><Markdown content={m.content} guildId={m.guild_id} /></div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ChatView({ channelId }: { channelId: string }) {
  const channel = useStore(() => findChannel(channelId));
  const me = useStore((s) => s.me);
  const showProfile = useStore((s) => s.showProfilePanel);
  const showMembers = useStore((s) => s.showMemberList);
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Phones have no room for a side column: the member list / profile slide over the chat when asked for.
  const phone = usePhone();
  const [phonePanel, setPhonePanel] = useState(false);
  const callActive = useStore((s) => Object.values(s.voiceStates).some((v) => v.channel_id === channelId));

  useEffect(() => {
    setActiveSearch(null);
    setSearch('');
    setPhonePanel(false);
  }, [channelId]);

  if (!channel) return <div className="main"><div className="empty-state">Channel not found.</div></div>;

  const isDm = channel.type === ChannelType.DM;
  const isGroup = channel.type === ChannelType.GROUP_DM;
  const isVoice = channel.type === ChannelType.GUILD_VOICE || channel.type === ChannelType.GUILD_STAGE;
  const other = isDm ? channel.recipients?.find((r) => r.id !== me?.id) ?? channel.recipients?.[0] : null;
  const title = isDm ? displayName(other) : isGroup ? channel.name || (channel.recipients ?? []).filter((r) => r.id !== me?.id).map((r) => displayName(r)).join(', ') : channel.name;

  const startCall = (video: boolean) => {
    voice.join(channel.id, null).then(() => {
      if (video) voice.setCamera(true);
    });
  };

  const profileOpen = phone ? phonePanel : showProfile;
  const membersOpen = phone ? phonePanel : showMembers;

  const Icon = isVoice ? SpeakerIcon : channel.type === ChannelType.GUILD_ANNOUNCEMENT ? AnnouncementIcon : HashIcon;

  return (
    <div
      className="main"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) addFilesToComposer(channel.id, [...e.dataTransfer.files]);
      }}
    >
      <div className="chat-header">
        <div className="ch-title">
          {isDm ? (
            <Avatar user={other} size={24} status={statusOf(other?.id ?? '')} ring="var(--bg-chat)" decoration={false} />
          ) : isGroup ? (
            channel.icon ? <img src={cdn(channel.icon)!} width={24} height={24} style={{ borderRadius: '50%' }} alt="" /> : <Users size={22} color="var(--text-muted)" />
          ) : (
            <Icon size={24} style={{ color: 'var(--text-muted)' }} />
          )}
          <span
            className="ch-name"
            style={{ cursor: isDm ? 'pointer' : undefined }}
            onClick={() => (isDm && other ? openModal({ type: 'profile', userId: other.id }) : isGroup ? openModal({ type: 'channel-settings', channelId: channel.id }) : undefined)}
          >
            {title}
          </span>
        </div>
        {channel.topic && !isDm && (
          <div className="ch-topic" onClick={() => openModal({ type: 'confirm', title: `#${channel.name}`, body: channel.topic!, confirm: 'Close', onConfirm: () => {} })}>
            {channel.topic}
          </div>
        )}
        <div className="tools">
          {(isDm || isGroup) && (
            <>
              <Tooltip text="Start Voice Call" side="bottom">
                <button className="icon-btn" onClick={() => startCall(false)}><Phone size={22} /></button>
              </Tooltip>
              <Tooltip text="Start Video Call" side="bottom">
                <button className="icon-btn" onClick={() => startCall(true)}><Video size={24} /></button>
              </Tooltip>
            </>
          )}
          {!isVoice && (
            <Tooltip text="Pinned Messages" side="bottom">
              <button className="icon-btn" onClick={() => openModal({ type: 'pins', channelId: channel.id })}><Pin size={22} /></button>
            </Tooltip>
          )}
          {channel.guild_id && !isVoice && (
            <Tooltip text="Notification Settings" side="bottom">
              <button className="icon-btn hide-phone" onClick={() => useStore.setState({ settings: { kind: 'user', section: 'notifications' } })}><Bell size={22} /></button>
            </Tooltip>
          )}
          {(isDm || isGroup) && (
            <Tooltip text={isGroup ? 'Add Friends to DM' : 'Add Friends to DM'} side="bottom">
              <button className="icon-btn hide-phone" onClick={() => openModal({ type: 'create-dm' })}><UserPlus size={22} /></button>
            </Tooltip>
          )}
          {isDm && (
            <Tooltip text={showProfile ? 'Hide User Profile' : 'Show User Profile'} side="bottom">
              <button className={`icon-btn${profileOpen ? ' active' : ''}`} onClick={() => (phone ? setPhonePanel(!phonePanel) : useStore.setState({ showProfilePanel: !showProfile }))}>
                <CircleUserRound size={24} />
              </button>
            </Tooltip>
          )}
          {(isGroup || channel.guild_id) && (
            <Tooltip text={showMembers ? 'Hide Member List' : 'Show Member List'} side="bottom">
              <button className={`icon-btn${membersOpen ? ' active' : ''}`} onClick={() => (phone ? setPhonePanel(!phonePanel) : useStore.setState({ showMemberList: !showMembers }))}>
                <Users size={22} />
              </button>
            </Tooltip>
          )}
          <label className="search-box">
            <input
              placeholder={isDm ? `Search ${other?.username ?? ''}` : channel.guild_id ? `Search ${useStore.getState().guilds[channel.guild_id]?.name ?? ''}` : 'Search'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && search.trim()) setActiveSearch(search.trim());
                if (e.key === 'Escape') {
                  setSearch('');
                  setActiveSearch(null);
                }
              }}
            />
            {search ? <X size={16} style={{ cursor: 'pointer' }} onClick={() => (setSearch(''), setActiveSearch(null))} /> : <Search size={16} />}
          </label>
        </div>
      </div>
      <div className="chat-body">
        <div className="chat-column">
          {(isDm || isGroup) && callActive && <DmCallArea channel={channel} />}
          {isVoice ? (
            <VoiceChannelView channel={channel} />
          ) : (
            <>
              <MessageList channel={channel} />
              <Composer channelId={channel.id} />
              <TypingIndicator channel={channel} />
            </>
          )}
          {dragging && (
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(88,101,242,.85)', display: 'grid', placeItems: 'center', zIndex: 40, borderRadius: 8, color: '#fff', fontSize: 20, fontWeight: 700, pointerEvents: 'none' }}>
              Drop files to upload to {isDm ? `@${title}` : `#${title}`}
            </div>
          )}
        </div>
        {activeSearch ? (
          <SearchResults channel={channel} query={activeSearch} onClose={() => (setActiveSearch(null), setSearch(''))} />
        ) : isDm && profileOpen && other ? (
          <ProfilePanel userId={other.id} />
        ) : (isGroup || (channel.guild_id && !isVoice)) && membersOpen ? (
          <MemberList channel={channel} />
        ) : null}
        {phone && (activeSearch || (phonePanel && (isDm || isGroup || (channel.guild_id && !isVoice)))) && (
          <div className="side-sheet-backdrop" onClick={() => (setPhonePanel(false), setActiveSearch(null), setSearch(''))} />
        )}
      </div>
    </div>
  );
}
