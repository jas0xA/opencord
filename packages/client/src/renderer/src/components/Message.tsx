import { memo, useEffect, useState } from 'react';
import { CornerUpLeft, Pencil, Pin, Trash2, SmilePlus, MoreHorizontal, Phone, PhoneMissed, ArrowRight, UserMinus, UserPlus, Download, FileText, ShieldAlert } from 'lucide-react';
import { BANNER_PRESETS, MessageType, Permissions, type Invite, type Message } from '@opencord/shared';
import { api, cdn, getBaseUrl } from '../lib/api';
import { Markdown, plainText } from '../lib/markdown';
import {
  can, displayName, getUser, memberColor, navigate, openGuild, openModal, setReplying, toast, useStore,
} from '../lib/store';
import { QUICK_REACTIONS } from '../lib/emoji';
import { acronym, copy, formatBytes, formatFullDate, formatMonthYear, formatTime, formatTimestamp, humanDuration } from '../lib/utils';
import { Avatar } from './Avatar';
import { StyledName } from './Cosmetics';
import { closeLayers, openContextMenu, openPopout, Tooltip } from './Layers';
import { memberMenu } from './Sidebars';
import { EmojiPicker } from './Pickers';
import { UserPopout } from './Profile';
import { Composer } from './Composer';
import { openExternal } from '../lib/web';

/* ───────────── invite embeds ───────────── */

const INVITE_RE = /(?:https?:\/\/[^\s/]+)?\/invite\/([A-Za-z0-9-]{2,32})|opencord:\/\/invite\/([A-Za-z0-9-]{2,32})/g;
const inviteCache = new Map<string, Promise<Invite | null>>();

export function extractInviteCodes(content: string): string[] {
  const base = getBaseUrl();
  const codes = new Set<string>();
  for (const m of content.matchAll(INVITE_RE)) {
    const full = m[0];
    // Only treat links to this server (or relative/opencord:// links) as invites.
    if (full.startsWith('http') && base && !full.startsWith(base)) continue;
    codes.add(m[1] ?? m[2]);
  }
  return [...codes].slice(0, 3);
}

function InviteEmbed({ code }: { code: string }) {
  const [invite, setInvite] = useState<Invite | null | undefined>(undefined);
  const joined = useStore((s) => (invite ? !!s.guilds[invite.guild.id] : false));
  useEffect(() => {
    if (!inviteCache.has(code)) inviteCache.set(code, api.get<Invite>(`/invites/${code}`).catch(() => null));
    inviteCache.get(code)!.then(setInvite);
  }, [code]);
  if (invite === undefined) return <div className="invite-card" style={{ height: 230 }} />;
  if (!invite) {
    return (
      <div className="invite-card invalid">
        <div className="ic-body" style={{ paddingTop: 16 }}>
          <div className="ic-name" style={{ marginTop: 0 }}>Invalid Invite</div>
          <div className="ic-est">This invite may be expired, or you might not have permission to join.</div>
        </div>
      </div>
    );
  }
  const g = invite.guild;
  const banner = g.banner ? { backgroundImage: `url(${cdn(g.banner)})`, backgroundSize: 'cover', backgroundPosition: 'center' } : { background: BANNER_PRESETS[g.banner_preset] ?? BANNER_PRESETS[0] };
  return (
    <div className="invite-card">
      <div className="ic-banner" style={banner} />
      <div className="ic-body">
        <div className="ic-icon">{g.icon ? <img src={cdn(g.icon)!} alt="" /> : acronym(g.name)}</div>
        <div className="ic-name">{g.name}</div>
        <div className="ic-meta">
          <span><i className="dot online" />{invite.guild.online_count} Online</span>
          <span><i className="dot members" />{invite.guild.member_count} Members</span>
        </div>
        <div className="ic-est">Est. {formatMonthYear(g.created_at)}</div>
        <button
          className="btn green"
          onClick={async () => {
            if (joined) return openGuild(g.id);
            try {
              const r = await api.post<{ guild_id: string; channel_id: string }>(`/invites/${code}`);
              setTimeout(() => navigate({ kind: 'guild', guildId: r.guild_id, channelId: r.channel_id }), 50);
            } catch (e: any) {
              toast(e.message);
            }
          }}
        >
          {joined ? 'Go to Server' : 'Join'}
        </button>
      </div>
    </div>
  );
}

/* ───────────── attachments / embeds ───────────── */

function Accessories({ m }: { m: Message }) {
  const stickers = useStore((s) => s.guilds);
  const invites = extractInviteCodes(m.content);
  const hasAny = m.attachments.length || m.embeds.length || invites.length || m.sticker_ids.length;
  if (!hasAny) return null;
  return (
    <div className="accessories">
      {m.attachments.map((a) => {
        const url = cdn(a.url)!;
        if (a.content_type.startsWith('image/'))
          return (
            <img
              key={a.id}
              className="attachment-image"
              src={url}
              alt={a.filename}
              style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}`, width: Math.min(a.width, 550, (350 * a.width) / a.height) } : undefined}
              onClick={() => openModal({ type: 'image', url })}
              onContextMenu={(e) => openContextMenu(e, [{ label: 'Copy Link', onClick: () => copy(url) }, { label: 'Open Link', onClick: () => openExternal(url) }])}
            />
          );
        if (a.content_type.startsWith('video/')) return <video key={a.id} className="attachment-video" src={url} controls />;
        if (a.content_type.startsWith('audio/'))
          return (
            <div key={a.id} className="attachment-file" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <FileText size={28} color="var(--text-muted)" />
                <div style={{ minWidth: 0 }}>
                  <div className="af-name">{a.filename}</div>
                  <div className="af-size">{formatBytes(a.size)}</div>
                </div>
              </div>
              <audio className="attachment-audio" src={url} controls style={{ width: '100%' }} />
            </div>
          );
        return (
          <div key={a.id} className="attachment-file">
            <FileText size={32} color="var(--text-muted)" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <a className="af-name" href={url} onClick={(e) => (e.preventDefault(), openExternal(url))}>{a.filename}</a>
              <div className="af-size">{formatBytes(a.size)}</div>
            </div>
            <Tooltip text="Download">
              <a className="icon-btn" href={url} download={a.filename}><Download size={20} /></a>
            </Tooltip>
          </div>
        );
      })}
      {m.sticker_ids.map((sid) => {
        const st = Object.values(stickers).flatMap((g) => g.stickers).find((x) => x.id === sid);
        return st ? <img key={sid} className="sticker-img" src={cdn(st.url)!} alt={st.name} title={st.name} /> : null;
      })}
      {m.embeds.map((e, i) =>
        e.type === 'image' ? (
          <img key={i} className="attachment-image" src={e.image!.url} alt="" onClick={() => openModal({ type: 'image', url: e.image!.url })} />
        ) : (
          <div key={i} className="embed" style={e.color ? { borderLeftColor: e.color } : undefined}>
            {e.site_name && <div className="e-site">{e.site_name}</div>}
            {e.title &&
              (e.url ? (
                <a className="e-title" href={e.url} onClick={(ev) => (ev.preventDefault(), openExternal(e.url!))}>{e.title}</a>
              ) : (
                <div className="e-title plain">{e.title}</div>
              ))}
            {e.description && <div className="e-desc">{e.type === 'rich' ? <Markdown content={e.description} guildId={m.guild_id} /> : e.description}</div>}
            {e.thumbnail && <img className="e-thumb" src={e.thumbnail.url} alt="" onClick={() => openModal({ type: 'image', url: e.thumbnail!.url })} />}
          </div>
        ),
      )}
      {invites.map((code) => (
        <InviteEmbed key={code} code={code} />
      ))}
    </div>
  );
}

function Reactions({ m }: { m: Message }) {
  const guilds = useStore((s) => s.guilds);
  if (!m.reactions.length) return null;
  const toggle = (r: Message['reactions'][number]) => {
    const key = encodeURIComponent(r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name);
    const path = `/channels/${m.channel_id}/messages/${m.id}/reactions/${key}/@me`;
    (r.me ? api.del(path) : api.put(path)).catch((e) => toast(e.message));
  };
  return (
    <div className="reactions">
      {m.reactions.map((r) => {
        const custom = r.emoji.id ? Object.values(guilds).flatMap((g) => g.emojis).find((e) => e.id === r.emoji.id) : null;
        return (
          <Tooltip key={`${r.emoji.id}:${r.emoji.name}`} text={`:${r.emoji.name}:`}>
            <button className={`reaction${r.me ? ' me' : ''}`} onClick={() => toggle(r)}>
              {custom ? <img src={cdn(custom.url)!} alt="" /> : r.emoji.id ? `:${r.emoji.name}:` : <span className="r-emoji">{r.emoji.name}</span>}
              {r.count}
            </button>
          </Tooltip>
        );
      })}
      <Tooltip text="Add Reaction">
        <button className="reaction" onClick={(e) => openPopout(e, `react-${m.id}`, () => <EmojiPicker onPick={(p) => react(m, p)} />, 'right')}>
          <SmilePlus size={16} />
        </button>
      </Tooltip>
    </div>
  );
}

function react(m: Message, p: { unicode: string } | { custom: { id: string; name: string } }) {
  const key = 'unicode' in p ? p.unicode : `${p.custom.name}:${p.custom.id}`;
  api.put(`/channels/${m.channel_id}/messages/${m.id}/reactions/${encodeURIComponent(key)}/@me`).catch((e) => toast(e.message));
  closeLayers();
}

/* ───────────── message item ───────────── */

function AuthorName({ m }: { m: Message }) {
  const color = useStore(() => memberColor(m.guild_id, m.author.id));
  const user = useStore((s) => s.users[m.author.id]) ?? m.author;
  // Live nickname: undefined while the member isn't loaded, null when they have none.
  const memberNick = useStore((s) => {
    if (!m.guild_id) return undefined;
    const mem = s.guilds[m.guild_id]?.members.find((x) => x.user.id === m.author.id);
    return mem ? mem.nick ?? displayName(mem.user) : undefined;
  });
  return (
    <span
      className="msg-author"
      style={color ? { color } : undefined}
      onClick={(e) => !m.webhook_id && openPopout(e, `author-${m.id}`, () => <UserPopout userId={m.author.id} guildId={m.guild_id ?? undefined} />)}
      onContextMenu={(e) => {
        if (m.webhook_id) return;
        if (m.guild_id) {
          const g = useStore.getState().guilds[m.guild_id];
          if (g) memberMenu(e, g, m.author.id);
        }
      }}
    >
      <StyledName user={user}>{memberNick ?? m.member?.nick ?? displayName(user)}</StyledName>
    </span>
  );
}

function SystemMessage({ m }: { m: Message }) {
  const me = useStore((s) => s.me);
  const name = (id: string) => (
    <span className="sys-user" onClick={() => openModal({ type: 'profile', userId: id })}>
      {displayName(getUser(id) ?? m.author, m.guild_id)}
    </span>
  );
  let icon: React.ReactNode = <ArrowRight size={18} color="var(--green-status)" />;
  let body: React.ReactNode = null;
  switch (m.type) {
    case MessageType.CALL: {
      const call = m.call!;
      const missed = call.ended_at && !call.participants.includes(me?.id ?? '');
      icon = missed ? <PhoneMissed size={18} color="var(--red-status)" /> : <Phone size={18} color="var(--green-status)" fill="var(--green-status)" />;
      if (missed) body = <>You missed a call from {name(m.author.id)} that lasted {humanDuration((call.ended_at ?? Date.now()) - m.created_at)}.</>;
      else if (call.ended_at) body = <>{name(m.author.id)} started a call that lasted {humanDuration(call.ended_at - m.created_at)}.</>;
      else body = <>{name(m.author.id)} started a call.</>;
      break;
    }
    case MessageType.GUILD_MEMBER_JOIN: {
      const lines = ['joined the party.', 'just landed.', 'is here.', 'hopped into the server.', 'just showed up!', 'arrived. Say hi!'];
      body = <>{name(m.author.id)} {lines[Number(BigInt(m.id) % BigInt(lines.length))]}</>;
      break;
    }
    case MessageType.RECIPIENT_ADD:
      body = <>{name(m.author.id)} added {name(m.mentions[0])} to the group.</>;
      icon = <UserPlus size={18} color="var(--green-status)" />;
      break;
    case MessageType.RECIPIENT_REMOVE:
      body = m.author.id === m.mentions[0] ? <>{name(m.author.id)} left the group.</> : <>{name(m.author.id)} removed {name(m.mentions[0])} from the group.</>;
      icon = <UserMinus size={18} color="var(--red-status)" />;
      break;
    case MessageType.CHANNEL_NAME_CHANGE:
      body = <>{name(m.author.id)} changed the channel name: <b style={{ color: 'var(--text-strong)' }}>{m.content}</b></>;
      icon = <Pencil size={16} color="var(--text-muted)" />;
      break;
    case MessageType.CHANNEL_PINNED_MESSAGE:
      body = <>{name(m.author.id)} pinned a message to this channel. See all <a style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--text-strong)' }} onClick={() => openModal({ type: 'pins', channelId: m.channel_id })}>pinned messages</a>.</>;
      icon = <Pin size={16} color="var(--text-muted)" />;
      break;
    case MessageType.AUTO_MODERATION_ACTION:
      return (
        <div className="message group-start">
          <div className="avatar-slot"><div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--brand)', display: 'grid', placeItems: 'center' }}><ShieldAlert size={22} color="#fff" /></div></div>
          <div className="msg-header"><span className="msg-author">AutoMod</span><span className="msg-bot">SYSTEM</span><span className="msg-time">{formatTimestamp(m.created_at)}</span></div>
          <div className="msg-content">{name(m.author.id)} triggered AutoMod</div>
          <Accessories m={m} />
        </div>
      );
    default:
      body = <>{m.content}</>;
  }
  return (
    <div className="system-message">
      <span className="sys-icon">{icon}</span>
      <span>
        {body}
        <Tooltip text={formatFullDate(m.created_at)}>
          <span className="sys-time">{formatTimestamp(m.created_at)}</span>
        </Tooltip>
      </span>
    </div>
  );
}

interface Props {
  m: Message & { pending?: boolean };
  grouped: boolean;
  canManage: boolean;
}

export const MessageItem = memo(function MessageItem({ m, grouped, canManage }: Props) {
  const me = useStore((s) => s.me);
  const editing = useStore((s) => s.editing?.messageId === m.id);
  const highlightMe = useStore((s) => {
    if (!s.me) return false;
    if (m.mentions.includes(s.me.id) || m.mention_everyone) return true;
    if (m.guild_id && m.mention_roles.length) {
      const mem = s.guilds[m.guild_id]?.members.find((x) => x.user.id === s.me!.id);
      return m.mention_roles.some((r) => mem?.roles.includes(r));
    }
    return false;
  });
  const devMode = me?.settings.developer_mode;
  if (m.type !== MessageType.DEFAULT && m.type !== MessageType.REPLY) return <SystemMessage m={m} />;
  const mine = m.author.id === me?.id;
  const canPin = m.guild_id ? can(Permissions.PIN_MESSAGES, m.guild_id, m.channel_id) : true;
  const canDelete = mine || canManage;

  const del = (e?: React.MouseEvent) => {
    const go = () => api.del(`/channels/${m.channel_id}/messages/${m.id}`).catch((err) => toast(err.message));
    if (e?.shiftKey) return go();
    openModal({ type: 'confirm', title: 'Delete Message', body: 'Are you sure you want to delete this message?', confirm: 'Delete', danger: true, onConfirm: go });
  };
  const pin = () => (m.pinned ? api.del(`/channels/${m.channel_id}/pins/${m.id}`) : api.put(`/channels/${m.channel_id}/pins/${m.id}`)).catch((e) => toast(e.message));
  const startEdit = () => useStore.setState({ editing: { channelId: m.channel_id, messageId: m.id } });

  const menu = (e: React.MouseEvent) => {
    const sel = window.getSelection()?.toString();
    openContextMenu(e, [
      { label: 'Add Reaction', onClick: () => openPopout(new DOMRect(e.clientX, e.clientY, 0, 0), `react-${m.id}`, () => <EmojiPicker onPick={(p) => react(m, p)} />) },
      ...QUICK_REACTIONS.slice(0, 4).map((r) => ({ label: `React ${r}`, onClick: () => react(m, { unicode: r }) })),
      { separator: true },
      mine && { label: 'Edit Message', onClick: startEdit },
      { label: 'Reply', onClick: () => setReplying(m.channel_id, m) },
      sel ? { label: 'Copy', onClick: () => copy(sel) } : { label: 'Copy Text', onClick: () => copy(m.content) },
      canPin && { label: m.pinned ? 'Unpin Message' : 'Pin Message', onClick: pin },
      { label: 'Mark Unread', onClick: () => useStore.setState((s) => ({ readStates: { ...s.readStates, [m.channel_id]: { channel_id: m.channel_id, last_message_id: (BigInt(m.id) - 1n).toString(), mention_count: 0 } } })) },
      { label: 'Copy Message Link', onClick: () => copy(`${getBaseUrl()}/channels/${m.guild_id ?? '@me'}/${m.channel_id}/${m.id}`) },
      { separator: true },
      canDelete && { label: 'Delete Message', danger: true, onClick: () => del() },
      !mine && !m.pending && {
        label: 'Report Message',
        danger: true,
        onClick: () => openModal({ type: 'report-message', channelId: m.channel_id, messageId: m.id, preview: plainText(m.content).slice(0, 200), author: m.author.username }),
      },
      devMode && { separator: true },
      devMode && { label: 'Copy Message ID', onClick: () => copy(m.id) },
    ]);
  };

  const ref = m.referenced_message;
  const showHeader = !grouped || !!ref;
  return (
    <div className={`message${showHeader ? ' group-start' : ''}${highlightMe ? ' mentioned' : ''}${m.pending ? ' pending' : ''}`} onContextMenu={menu} data-id={m.id}>
      {ref && (
        <div className="msg-reply" onClick={() => document.querySelector(`[data-id="${ref.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          <Avatar user={ref.author} size={16} decoration={false} />
          <span className="r-author">@{displayName(ref.author, ref.guild_id)}</span>
          <span className="r-text">{plainText(ref.content, ref.guild_id) || (ref.attachments.length ? 'Click to see attachment' : '')}</span>
        </div>
      )}
      {showHeader ? (
        <div className="avatar-slot" onClick={(e) => !m.webhook_id && openPopout(e, `avatar-${m.id}`, () => <UserPopout userId={m.author.id} guildId={m.guild_id ?? undefined} />)}>
          <Avatar user={m.author} size={40} />
        </div>
      ) : (
        <Tooltip text={formatFullDate(m.created_at)}>
          <span className="hover-time">{formatTime(m.created_at)}</span>
        </Tooltip>
      )}
      {showHeader && (
        <div className="msg-header">
          <AuthorName m={m} />
          {(m.author.bot || m.webhook_id) && <span className="msg-bot">{m.webhook_id ? 'APP' : 'BOT'}</span>}
          <Tooltip text={formatFullDate(m.created_at)}>
            <span className="msg-time">{formatTimestamp(m.created_at)}</span>
          </Tooltip>
        </div>
      )}
      {editing ? (
        <div className="edit-box">
          <Composer channelId={m.channel_id} editing={m} />
        </div>
      ) : (
        m.content && (
          <div className="msg-content">
            <Markdown content={m.content} guildId={m.guild_id} />
            {m.edited_at && (
              <Tooltip text={formatFullDate(m.edited_at)}>
                <span className="msg-edited">(edited)</span>
              </Tooltip>
            )}
          </div>
        )
      )}
      <Accessories m={m} />
      <Reactions m={m} />
      {!m.pending && (
        <div className="msg-toolbar">
          {QUICK_REACTIONS.slice(0, 3).map((r) => (
            <Tooltip key={r} text={`React with ${r}`}>
              <button onClick={() => react(m, { unicode: r })}>{r}</button>
            </Tooltip>
          ))}
          <div className="sep" />
          <Tooltip text="Add Reaction">
            <button onClick={(e) => openPopout(e, `react-${m.id}`, () => <EmojiPicker onPick={(p) => react(m, p)} />, 'left')}><SmilePlus size={18} /></button>
          </Tooltip>
          {mine && (
            <Tooltip text="Edit">
              <button onClick={startEdit}><Pencil size={18} /></button>
            </Tooltip>
          )}
          <Tooltip text="Reply">
            <button onClick={() => setReplying(m.channel_id, m)}><CornerUpLeft size={18} /></button>
          </Tooltip>
          <Tooltip text="More">
            <button onClick={menu}><MoreHorizontal size={18} /></button>
          </Tooltip>
          {canDelete && (
            <Tooltip text="Delete (shift to skip confirm)">
              <button className="danger" onClick={del}><Trash2 size={18} /></button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
});

