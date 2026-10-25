import { useEffect, useState } from 'react';
import { Camera, Check, ChevronRight, Hash, Lock, Search, Volume2, X, Megaphone, Folder } from 'lucide-react';
import {
  ChannelType, PERMISSION_INFO, Permissions, RelationshipType, type Channel, type Invite, type Message, type PermissionOverwrite,
} from '@opencord/shared';
import { api, cdn, fileToDataUrl, getBaseUrl, pickFile } from '../lib/api';
import { cropImgStyle, parseCrop, pickAndCropImage } from '../lib/crop';
import {
  closeModal, displayName, findChannel, navigate, openDm, openGuild, toast, updateSettings, useStore, type Modal,
} from '../lib/store';
import { Markdown } from '../lib/markdown';
import { formatTimestamp } from '../lib/utils';
import { Avatar } from './Avatar';
import { EmojiPicker } from './Pickers';
import { openPopout, closeLayers } from './Layers';
import { ProfileModal } from './Profile';
import { ScreenShareModal } from './Voice';
import { PublishItem } from '../views/Marketplace';

function Shell({ title, subtitle, children, footer, wide, center }: { title: string; subtitle?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; wide?: boolean; center?: boolean }) {
  return (
    <div className={`modal${wide ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <div className={`modal-header${center ? ' center' : ''}`}>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
        <button className="modal-close" onClick={closeModal}><X size={24} /></button>
      </div>
      {children && <div className="modal-body scroller thin">{children}</div>}
      {footer && <div className="modal-footer">{footer}</div>}
    </div>
  );
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(e.errors && Object.values(e.errors).length ? `${e.message}: ${Object.values(e.errors).join(', ')}` : e.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

/* ───────────── create / join server ───────────── */

function CreateGuild() {
  const me = useStore((s) => s.me);
  const [step, setStep] = useState<'choose' | 'create' | 'join'>('choose');
  const [name, setName] = useState(`${me?.display_name || me?.username}'s server`);
  const [icon, setIcon] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [template, setTemplate] = useState('');
  const { busy, error, run } = useBusy();

  if (step === 'choose')
    return (
      <Shell title="Create Your Server" subtitle="Your server is where you and your friends hang out. Make yours and start talking." center>
        <div className="choice-list">
          <button className="choice" onClick={() => setStep('create')}>
            <span style={{ fontSize: 28 }}>🛠️</span>
            <span style={{ flex: 1 }}>Create My Own</span>
            <ChevronRight size={20} />
          </button>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '8px 0 0' }}>Start from a template</div>
          {[
            { emoji: '🎮', label: 'Gaming', channels: ['general', 'clips-and-highlights', 'looking-for-group'], voice: ['Lobby', 'Gaming'] },
            { emoji: '🏫', label: 'School Club', channels: ['announcements', 'general', 'meeting-plans', 'off-topic'], voice: ['Meeting Room', 'Lounge'] },
            { emoji: '👥', label: 'Friends', channels: ['general', 'memes', 'events'], voice: ['Hangout'] },
            { emoji: '🎨', label: 'Artists & Creators', channels: ['showcase', 'inspiration', 'feedback'], voice: ['Studio'] },
          ].map((t) => (
            <button
              key={t.label}
              className="choice"
              onClick={() => {
                setTemplate(
                  JSON.stringify({
                    name: '',
                    description: '',
                    roles: [{ id: '0', name: '@everyone', color: null, hoist: false, permissions: '0', mentionable: false }].slice(0, 0),
                    channels: [
                      { id: 'c1', type: 4, name: 'Text Channels', topic: null, parent_id: null, position: 0, nsfw: false, rate_limit_per_user: 0, overwrites: [] },
                      { id: 'c2', type: 4, name: 'Voice Channels', topic: null, parent_id: null, position: 1, nsfw: false, rate_limit_per_user: 0, overwrites: [] },
                      ...t.channels.map((c, i) => ({ id: `t${i}`, type: 0, name: c, topic: null, parent_id: 'c1', position: i, nsfw: false, rate_limit_per_user: 0, overwrites: [] })),
                      ...t.voice.map((c, i) => ({ id: `v${i}`, type: 2, name: c, topic: null, parent_id: 'c2', position: i, nsfw: false, rate_limit_per_user: 0, overwrites: [] })),
                    ],
                    system_channel_id: t.channels.includes('general') ? `t${t.channels.indexOf('general')}` : 't0',
                  }),
                );
                setStep('create');
              }}
            >
              <span style={{ fontSize: 28 }}>{t.emoji}</span>
              <span style={{ flex: 1 }}>{t.label}</span>
              <ChevronRight size={20} />
            </button>
          ))}
        </div>
        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-strong)', marginBottom: 8 }}>Have an invite already?</div>
          <button className="btn secondary full" onClick={() => setStep('join')}>Join a Server</button>
        </div>
      </Shell>
    );

  if (step === 'join')
    return (
      <Shell
        title="Join a Server"
        subtitle="Enter an invite below to join an existing server"
        center
        footer={
          <>
            <button className="btn link left" onClick={() => setStep('choose')}>Back</button>
            <button
              className="btn"
              disabled={busy || !code.trim()}
              onClick={() =>
                run(async () => {
                  const c = code.trim().split('/').pop()!;
                  const r = await api.post<{ guild_id: string; channel_id: string }>(`/invites/${c}`);
                  closeModal();
                  setTimeout(() => navigate({ kind: 'guild', guildId: r.guild_id, channelId: r.channel_id }), 50);
                })
              }
            >
              Join Server
            </button>
          </>
        }
      >
        <label className="label">Invite link <span className="req">*</span>{error && <span className="field-error"> - {error}</span>}</label>
        <input className="input" autoFocus placeholder={`${getBaseUrl()}/invite/hTKzmak`} value={code} onChange={(e) => setCode(e.target.value)} />
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '16px 0 8px' }}>Invites should look like</div>
        <div style={{ fontSize: 14 }}>hTKzmak<br />{getBaseUrl()}/invite/hTKzmak</div>
      </Shell>
    );

  return (
    <Shell
      title="Customize Your Server"
      subtitle="Give your new server a personality with a name and an icon. You can always change it later."
      center
      footer={
        <>
          <button className="btn link left" onClick={() => setStep('choose')}>Back</button>
          <button
            className="btn"
            disabled={busy || name.trim().length < 2}
            onClick={() =>
              run(async () => {
                const g = await api.post('/guilds', { name: name.trim(), icon, template: template || undefined });
                closeModal();
                setTimeout(() => openGuild(g.id), 50);
              })
            }
          >
            Create
          </button>
        </>
      }
    >
      <div
        className="upload-circle"
        onClick={async () => {
          const v = await pickAndCropImage('square');
          if (v) setIcon(v);
        }}
      >
        {icon ? <img src={icon} alt="" style={cropImgStyle(parseCrop(icon))} /> : <div><Camera size={24} /><div className="uc-label">Upload</div></div>}
      </div>
      <label className="label">Server Name{error && <span className="field-error"> - {error}</span>}</label>
      <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoFocus />
    </Shell>
  );
}

/* ───────────── invite ───────────── */

function InviteModal({ guildId, channelId }: { guildId: string; channelId?: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const relationships = useStore((s) => s.relationships);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [maxAge, setMaxAge] = useState(604800);
  const [maxUses, setMaxUses] = useState(0);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const target = channelId ?? guild?.system_channel_id ?? guild?.channels.find((c) => c.type === 0)?.id;
  const create = (age = maxAge, uses = maxUses) =>
    target && api.post<Invite>(`/channels/${target}/invites`, { max_age: age, max_uses: uses }).then(setInvite).catch((e) => toast(e.message));
  useEffect(() => {
    create();
  }, []);
  const link = invite ? `${getBaseUrl()}/invite/${invite.code}` : '';
  const friends = Object.values(relationships).filter((r) => r.type === RelationshipType.FRIEND && (!q || r.user.username.includes(q.toLowerCase())));
  return (
    <Shell title={`Invite friends to ${guild?.name}`} subtitle={channelId ? `# ${findChannel(channelId)?.name}` : undefined}>
      <div className="friends-search" style={{ marginBottom: 8 }}>
        <input placeholder="Search for friends" value={q} onChange={(e) => setQ(e.target.value)} />
        <Search size={18} color="var(--text-muted)" />
      </div>
      <div className="scroller thin" style={{ maxHeight: 200, marginBottom: 16 }}>
        {friends.map((r) => (
          <div key={r.id} className="dm-item" style={{ cursor: 'default' }}>
            <Avatar user={r.user} size={32} decoration={false} />
            <div className="dm-text"><div className="dm-name" style={{ color: 'var(--text-strong)' }}>{displayName(r.user)}</div></div>
            <button
              className={`btn sm ${sent[r.id] ? 'secondary' : 'green'}`}
              disabled={!invite || sent[r.id]}
              onClick={async () => {
                const ch = await api.post<Channel>('/users/@me/channels', { recipient_id: r.id });
                await api.post(`/channels/${ch.id}/messages`, { content: link });
                setSent({ ...sent, [r.id]: true });
              }}
            >
              {sent[r.id] ? 'Sent' : 'Invite'}
            </button>
          </div>
        ))}
        {friends.length === 0 && <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>No friends to show.</div>}
      </div>
      <label className="label">Or, send a server invite link to a friend</label>
      <div style={{ display: 'flex', background: 'var(--bg-input)', border: '1px solid var(--border-input)', borderRadius: 8, padding: 4, alignItems: 'center' }}>
        <input className="input" style={{ border: 0, height: 32 }} readOnly value={link} onFocus={(e) => e.target.select()} />
        <button
          className={`btn sm${copied ? ' green' : ''}`}
          onClick={() => {
            navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <select className="input select" value={maxAge} onChange={(e) => (setMaxAge(+e.target.value), create(+e.target.value, maxUses))}>
          <option value={1800}>Expire after 30 minutes</option>
          <option value={3600}>Expire after 1 hour</option>
          <option value={21600}>Expire after 6 hours</option>
          <option value={43200}>Expire after 12 hours</option>
          <option value={86400}>Expire after 1 day</option>
          <option value={604800}>Expire after 7 days</option>
          <option value={0}>Never expire</option>
        </select>
        <select className="input select" value={maxUses} onChange={(e) => (setMaxUses(+e.target.value), create(maxAge, +e.target.value))}>
          <option value={0}>No limit</option>
          {[1, 5, 10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} use{n > 1 ? 's' : ''}</option>)}
        </select>
      </div>
    </Shell>
  );
}

/* ───────────── create channel ───────────── */

function CreateChannel({ guildId, parentId, channelType }: { guildId: string; parentId: string | null; channelType?: number }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const [type, setType] = useState(channelType ?? ChannelType.GUILD_TEXT);
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(false);
  const { busy, error, run } = useBusy();
  const isCat = type === ChannelType.GUILD_CATEGORY;
  const types = [
    { t: ChannelType.GUILD_TEXT, icon: <Hash size={24} />, label: 'Text', desc: 'Send messages, images, GIFs, emoji, opinions, and puns' },
    { t: ChannelType.GUILD_VOICE, icon: <Volume2 size={24} />, label: 'Voice', desc: 'Hang out together with voice, video, and screen share' },
    { t: ChannelType.GUILD_ANNOUNCEMENT, icon: <Megaphone size={24} />, label: 'Announcement', desc: 'Important updates for people in and out of the server' },
  ];
  return (
    <Shell
      title={isCat ? 'Create Category' : 'Create Channel'}
      subtitle={!isCat && parentId ? `in ${guild?.channels.find((c) => c.id === parentId)?.name}` : undefined}
      footer={
        <>
          <button className="btn link" onClick={closeModal}>Cancel</button>
          <button
            className="btn"
            disabled={busy || !name.trim()}
            onClick={() =>
              run(async () => {
                const overwrites: PermissionOverwrite[] = priv ? [{ id: guildId, type: 0, allow: '0', deny: Permissions.VIEW_CHANNEL.toString() }] : [];
                const ch = await api.post<Channel>(`/guilds/${guildId}/channels`, { name: name.trim(), type, parent_id: isCat ? null : parentId, permission_overwrites: priv ? overwrites : undefined });
                closeModal();
                if (type === ChannelType.GUILD_TEXT || type === ChannelType.GUILD_ANNOUNCEMENT) setTimeout(() => navigate({ kind: 'guild', guildId, channelId: ch.id }), 50);
              })
            }
          >
            {isCat ? 'Create Category' : 'Create Channel'}
          </button>
        </>
      }
    >
      {!isCat && (
        <>
          <label className="label">Channel Type</label>
          <div className="choice-list" style={{ marginBottom: 20 }}>
            {types.map((x) => (
              <button key={x.t} className={`choice${type === x.t ? ' selected' : ''}`} onClick={() => setType(x.t)}>
                {x.icon}
                <span style={{ flex: 1 }}>
                  {x.label}
                  <div className="ch-desc">{x.desc}</div>
                </span>
                <span style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid var(--text-muted)', display: 'grid', placeItems: 'center' }}>
                  {type === x.t && <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--text-strong)' }} />}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      <label className="label">{isCat ? 'Category Name' : 'Channel Name'}{error && <span className="field-error"> - {error}</span>}</label>
      <div style={{ position: 'relative' }}>
        {!isCat && <span style={{ position: 'absolute', left: 12, top: 10, color: 'var(--text-muted)' }}>{type === ChannelType.GUILD_VOICE ? <Volume2 size={18} /> : <Hash size={18} />}</span>}
        <input className="input" style={!isCat ? { paddingLeft: 36 } : undefined} autoFocus placeholder={isCat ? 'New Category' : 'new-channel'} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && (e.currentTarget.closest('.modal')?.querySelector('.modal-footer .btn:last-child') as HTMLButtonElement)?.click()} />
      </div>
      <div className="setting-row" style={{ borderBottom: 0, marginTop: 8 }}>
        <Lock size={18} />
        <div className="sr-text">
          <div className="sr-title">Private {isCat ? 'Category' : 'Channel'}</div>
          <div className="sr-desc">Only selected members and roles will be able to view this {isCat ? 'category' : 'channel'}.</div>
        </div>
        <div className={`switch${priv ? ' on' : ''}`} onClick={() => setPriv(!priv)} />
      </div>
    </Shell>
  );
}

/* ───────────── channel settings (incl. permission overwrites) ───────────── */

function ChannelSettings({ channelId }: { channelId: string }) {
  const channel = useStore(() => findChannel(channelId));
  const guild = useStore((s) => (channel?.guild_id ? s.guilds[channel.guild_id] : null));
  const [tab, setTab] = useState<'overview' | 'permissions'>('overview');
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [slow, setSlow] = useState(channel?.rate_limit_per_user ?? 0);
  const [nsfw, setNsfw] = useState(channel?.nsfw ?? false);
  const [limit, setLimit] = useState(channel?.user_limit ?? 0);
  const [selected, setSelected] = useState<string | null>(guild?.id ?? null);
  const { busy, error, run } = useBusy();
  if (!channel) return null;

  if (channel.type === ChannelType.GROUP_DM) {
    return (
      <Shell
        title="Group Settings"
        footer={
          <>
            <button className="btn link" onClick={closeModal}>Cancel</button>
            <button className="btn" disabled={busy} onClick={() => run(async () => (await api.patch(`/channels/${channelId}`, { name }), closeModal()))}>Save</button>
          </>
        }
      >
        <div
          className="upload-circle"
          onClick={async () => {
            const [f] = await pickFile('image/*');
            if (f) await api.patch(`/channels/${channelId}`, { icon: await fileToDataUrl(f) }).catch((e) => toast(e.message));
          }}
        >
          {channel.icon ? <img src={cdn(channel.icon)!} alt="" /> : <div><Camera size={24} /><div className="uc-label">Icon</div></div>}
        </div>
        <label className="label">Group Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </Shell>
    );
  }

  const isText = channel.type === ChannelType.GUILD_TEXT || channel.type === ChannelType.GUILD_ANNOUNCEMENT;
  const isVoice = channel.type === ChannelType.GUILD_VOICE;
  const overwrites = channel.permission_overwrites;
  const current = overwrites.find((o) => o.id === selected);
  const setPerm = async (flag: bigint, state: 'allow' | 'deny' | 'neutral') => {
    if (!selected || !guild) return;
    const type = guild.roles.some((r) => r.id === selected) ? 0 : 1;
    let allow = BigInt(current?.allow ?? '0');
    let deny = BigInt(current?.deny ?? '0');
    allow &= ~flag;
    deny &= ~flag;
    if (state === 'allow') allow |= flag;
    if (state === 'deny') deny |= flag;
    await api.put(`/channels/${channelId}/permissions/${selected}`, { type, allow: allow.toString(), deny: deny.toString() }).catch((e) => toast(e.message));
  };
  const hidden = ['MANAGE_GUILD', 'VIEW_AUDIT_LOG', 'ADMINISTRATOR', 'MANAGE_EXPRESSIONS', 'MANAGE_NICKNAMES', 'CHANGE_NICKNAME', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS', 'MANAGE_EVENTS'];
  const relevant = PERMISSION_INFO.filter(
    (p) => !hidden.includes(p.key) && (isVoice ? p.group !== 'Text Channel Permissions' : p.group !== 'Voice Channel Permissions'),
  );

  return (
    <div className="modal wide" style={{ width: 760 }} onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <h2>{channel.type === ChannelType.GUILD_CATEGORY ? <Folder size={20} /> : '#'} {channel.name}</h2>
        <button className="modal-close" onClick={closeModal}><X size={24} /></button>
        <div className="subtabs" style={{ marginTop: 16, marginBottom: 0 }}>
          <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
          <button className={tab === 'permissions' ? 'active' : ''} onClick={() => setTab('permissions')}>Permissions</button>
        </div>
      </div>
      <div className="modal-body scroller thin" style={{ maxHeight: '60vh' }}>
        {tab === 'overview' ? (
          <>
            <div className="form-row">
              <label className="label">{channel.type === ChannelType.GUILD_CATEGORY ? 'Category Name' : 'Channel Name'}{error && <span className="field-error"> - {error}</span>}</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {isText && (
              <>
                <div className="form-row">
                  <label className="label">Channel Topic</label>
                  <textarea className="textarea" value={topic} maxLength={1024} onChange={(e) => setTopic(e.target.value)} placeholder="Let everyone know how to use this channel!" />
                </div>
                <div className="form-row">
                  <label className="label">Slowmode — {slow === 0 ? 'Off' : `${slow}s`}</label>
                  <input type="range" min={0} max={8} value={[0, 5, 10, 15, 30, 60, 120, 300, 600].indexOf(slow) === -1 ? 0 : [0, 5, 10, 15, 30, 60, 120, 300, 600].indexOf(slow)} onChange={(e) => setSlow([0, 5, 10, 15, 30, 60, 120, 300, 600][+e.target.value])} style={{ width: '100%' }} />
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Members will be restricted to sending one message per this interval, unless they have Manage Channel or Manage Messages permissions.</div>
                </div>
                <div className="setting-row">
                  <div className="sr-text"><div className="sr-title">Age-Restricted Channel</div><div className="sr-desc">Users will need to confirm they are of over legal age to view the content in this channel.</div></div>
                  <div className={`switch${nsfw ? ' on' : ''}`} onClick={() => setNsfw(!nsfw)} />
                </div>
              </>
            )}
            {isVoice && (
              <div className="form-row">
                <label className="label">User Limit — {limit === 0 ? '∞' : limit}</label>
                <input type="range" min={0} max={99} value={limit} onChange={(e) => setLimit(+e.target.value)} style={{ width: '100%' }} />
              </div>
            )}
          </>
        ) : (
          guild && (
            <div className="roles-layout" style={{ minHeight: 360 }}>
              <div className="roles-list">
                <div className="perm-group-title" style={{ marginTop: 0 }}>Roles / Members</div>
                {[...guild.roles].sort((a, b) => b.position - a.position).map((r) => (
                  <div key={r.id} className={`rl-item${selected === r.id ? ' active' : ''}`} onClick={() => setSelected(r.id)}>
                    <span className="rp-dot" style={{ width: 10, height: 10, borderRadius: '50%', background: r.color ?? '#99aab5' }} />
                    {r.name}
                    {overwrites.some((o) => o.id === r.id) && <Check size={14} style={{ marginLeft: 'auto' }} />}
                  </div>
                ))}
                {overwrites.filter((o) => o.type === 1).map((o) => {
                  const m = guild.members.find((x) => x.user.id === o.id);
                  return (
                    <div key={o.id} className={`rl-item${selected === o.id ? ' active' : ''}`} onClick={() => setSelected(o.id)}>
                      <Avatar user={m?.user} size={18} decoration={false} />
                      {displayName(m?.user, guild.id)}
                    </div>
                  );
                })}
                <button
                  className="rl-item"
                  style={{ color: 'var(--text-link)' }}
                  onClick={(e) =>
                    openPopout(e, 'add-member-ow', () => (
                      <div style={{ width: 240, maxHeight: 300, overflow: 'auto', padding: 6 }}>
                        {guild.members.map((m) => (
                          <button key={m.user.id} className="cm-item" onClick={() => (closeLayers(), setSelected(m.user.id), api.put(`/channels/${channelId}/permissions/${m.user.id}`, { type: 1, allow: '0', deny: '0' }))}>
                            {displayName(m.user, guild.id)}
                          </button>
                        ))}
                      </div>
                    ))
                  }
                >
                  + Add member
                </button>
              </div>
              <div className="roles-edit">
                {selected && (
                  <>
                    {relevant.map((p) => {
                      const flag = Permissions[p.key];
                      const state = BigInt(current?.allow ?? '0') & flag ? 'allow' : BigInt(current?.deny ?? '0') & flag ? 'deny' : 'neutral';
                      return (
                        <div key={p.key} className="setting-row">
                          <div className="sr-text">
                            <div className="sr-title">{p.label}</div>
                            <div className="sr-desc">{p.description}</div>
                          </div>
                          <div className="tri-toggle">
                            <button className={`deny${state === 'deny' ? ' on' : ''}`} onClick={() => setPerm(flag, 'deny')}><X size={16} /></button>
                            <button className={`neutral${state === 'neutral' ? ' on' : ''}`} onClick={() => setPerm(flag, 'neutral')}>/</button>
                            <button className={`allow${state === 'allow' ? ' on' : ''}`} onClick={() => setPerm(flag, 'allow')}><Check size={16} /></button>
                          </div>
                        </div>
                      );
                    })}
                    {current && selected !== guild.id && (
                      <button className="btn outline-danger" style={{ marginTop: 16 }} onClick={() => api.del(`/channels/${channelId}/permissions/${selected}`)}>Remove overwrite</button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        )}
      </div>
      {tab === 'overview' && (
        <div className="modal-footer">
          <button className="btn link" onClick={closeModal}>Cancel</button>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.patch(`/channels/${channelId}`, isText ? { name, topic, rate_limit_per_user: slow, nsfw } : isVoice ? { name, user_limit: limit } : { name });
                closeModal();
              })
            }
          >
            Save Changes
          </button>
        </div>
      )}
    </div>
  );
}

/* ───────────── moderation ───────────── */

function Moderate({ action, guildId, userId }: { action: 'kick' | 'ban' | 'timeout'; guildId: string; userId: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const user = guild?.members.find((m) => m.user.id === userId)?.user ?? useStore.getState().users[userId];
  const [reason, setReason] = useState('');
  const [deleteSecs, setDeleteSecs] = useState(0);
  const [duration, setDuration] = useState(600);
  const { busy, error, run } = useBusy();
  const name = displayName(user, guildId);
  const title = action === 'kick' ? `Kick ${name} from Server` : action === 'ban' ? `Ban ${name}` : `Timeout ${name}`;
  const go = () =>
    run(async () => {
      if (action === 'kick') await api.del(`/guilds/${guildId}/members/${userId}?reason=${encodeURIComponent(reason)}`);
      if (action === 'ban') await api.put(`/guilds/${guildId}/bans/${userId}`, { reason: reason || undefined, delete_message_seconds: deleteSecs });
      if (action === 'timeout') await api.patch(`/guilds/${guildId}/members/${userId}`, { communication_disabled_until: Date.now() + duration * 1000, reason });
      closeModal();
    });
  return (
    <Shell
      title={title}
      footer={
        <>
          <button className="btn link" onClick={closeModal}>Cancel</button>
          <button className="btn danger" disabled={busy} onClick={go}>{action === 'kick' ? 'Kick' : action === 'ban' ? 'Ban' : 'Timeout'}</button>
        </>
      }
    >
      {action === 'kick' && <p style={{ marginTop: 0 }}>Are you sure you want to kick @{user?.username} from the server? They will be able to rejoin again with a new invite.</p>}
      {action === 'ban' && (
        <div className="form-row">
          <label className="label">Delete message history</label>
          <select className="input select" value={deleteSecs} onChange={(e) => setDeleteSecs(+e.target.value)}>
            <option value={0}>Don't delete any</option>
            <option value={3600}>Previous hour</option>
            <option value={21600}>Previous 6 hours</option>
            <option value={43200}>Previous 12 hours</option>
            <option value={86400}>Previous 24 hours</option>
            <option value={259200}>Previous 3 days</option>
            <option value={604800}>Previous 7 days</option>
          </select>
        </div>
      )}
      {action === 'timeout' && (
        <div className="form-row">
          <label className="label">Duration</label>
          <div className="choice-list" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {[[60, '60 secs'], [300, '5 mins'], [600, '10 mins'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week']].map(([s, l]) => (
              <button key={s} className={`chip${duration === s ? ' active' : ''}`} onClick={() => setDuration(s as number)}>{l}</button>
            ))}
          </div>
          <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Members in timeout can read but can't send messages, react, or join voice.</p>
        </div>
      )}
      <label className="label">Reason{error && <span className="field-error"> - {error}</span>}</label>
      <textarea className="textarea" value={reason} maxLength={512} onChange={(e) => setReason(e.target.value)} />
    </Shell>
  );
}

function Nickname({ guildId, userId }: { guildId: string; userId: string }) {
  const member = useStore((s) => s.guilds[guildId]?.members.find((m) => m.user.id === userId));
  const [nick, setNick] = useState(member?.nick ?? '');
  const { busy, error, run } = useBusy();
  return (
    <Shell
      title="Change Nickname"
      footer={
        <>
          <button className="btn link left" onClick={() => setNick('')}>Reset Nickname</button>
          <button className="btn link" onClick={closeModal}>Cancel</button>
          <button className="btn" disabled={busy} onClick={() => run(async () => (await api.patch(`/guilds/${guildId}/members/${userId}`, { nick: nick || null }), closeModal()))}>Save</button>
        </>
      }
    >
      <label className="label">Nickname{error && <span className="field-error"> - {error}</span>}</label>
      <input className="input" autoFocus value={nick} maxLength={32} placeholder={member?.user.display_name ?? member?.user.username} onChange={(e) => setNick(e.target.value)} />
    </Shell>
  );
}

/* ───────────── DMs ───────────── */

function CreateDm() {
  const relationships = useStore((s) => s.relationships);
  const route = useStore((s) => s.route);
  const current = route.kind === 'home' && route.channelId ? useStore.getState().privateChannels[route.channelId] : null;
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const { busy, error, run } = useBusy();
  const friends = Object.values(relationships).filter((r) => r.type === RelationshipType.FRIEND && (!q || r.user.username.includes(q.toLowerCase()) || displayName(r.user).toLowerCase().includes(q.toLowerCase())));
  const addingToGroup = current?.type === ChannelType.GROUP_DM;
  return (
    <Shell
      title={addingToGroup ? 'Add Friends to Group' : 'Select Friends'}
      subtitle={`You can add ${9 - picked.length} more friends.`}
      footer={
        <button
          className="btn full"
          disabled={busy || !picked.length}
          onClick={() =>
            run(async () => {
              if (addingToGroup) {
                for (const id of picked) await api.put(`/channels/${current!.id}/recipients/${id}`);
                closeModal();
                return;
              }
              const ch = await api.post<Channel>('/users/@me/channels', picked.length === 1 ? { recipient_id: picked[0] } : { recipients: picked });
              closeModal();
              setTimeout(() => openDm(ch.id), 50);
            })
          }
        >
          {addingToGroup ? 'Add' : picked.length > 1 ? 'Create Group DM' : 'Create DM'}
        </button>
      }
    >
      {error && <div className="field-error" style={{ marginBottom: 8 }}>{error}</div>}
      <div className="friends-search">
        <input autoFocus placeholder="Type the username of a friend" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="scroller thin" style={{ maxHeight: 300 }}>
        {friends.map((r) => {
          const on = picked.includes(r.id);
          return (
            <div key={r.id} className="dm-item" onClick={() => setPicked(on ? picked.filter((x) => x !== r.id) : picked.length < 9 ? [...picked, r.id] : picked)}>
              <Avatar user={r.user} size={32} status ring="var(--bg-content)" decoration={false} />
              <div className="dm-text">
                <div className="dm-name" style={{ color: 'var(--text-strong)' }}>{displayName(r.user)}</div>
                <div className="dm-sub">{r.user.username}</div>
              </div>
              <span className={`cm-check${on ? ' on' : ''}`}>{on && <Check size={14} />}</span>
            </div>
          );
        })}
        {friends.length === 0 && <div className="empty-state">No friends found.</div>}
      </div>
    </Shell>
  );
}

function Pins({ channelId }: { channelId: string }) {
  const [pins, setPins] = useState<Message[] | null>(null);
  useEffect(() => {
    api.get<Message[]>(`/channels/${channelId}/pins`).then(setPins).catch((e) => toast(e.message));
  }, [channelId]);
  return (
    <Shell title="Pinned Messages" wide>
      {pins === null && <div className="empty-state"><div className="spinner" /></div>}
      {pins?.length === 0 && <div className="empty-state">This channel doesn't have any pinned messages... yet.</div>}
      {pins?.map((m) => (
        <div key={m.id} style={{ background: 'var(--bg-chat)', borderRadius: 8, padding: '10px 12px', marginBottom: 8, display: 'flex', gap: 10 }}>
          <Avatar user={m.author} size={36} decoration={false} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{displayName(m.author, m.guild_id)} <span className="msg-time">{formatTimestamp(m.created_at)}</span></div>
            <div className="msg-content" style={{ fontSize: 15 }}><Markdown content={m.content} guildId={m.guild_id} /></div>
          </div>
          <button className="icon-btn" title="Unpin" onClick={() => api.del(`/channels/${channelId}/pins/${m.id}`).then(() => setPins(pins.filter((p) => p.id !== m.id)))}><X size={16} /></button>
        </div>
      ))}
    </Shell>
  );
}

function LeaveGuild({ guildId }: { guildId: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const { busy, run } = useBusy();
  return (
    <Shell
      title={`Leave '${guild?.name}'`}
      footer={
        <>
          <button className="btn link" onClick={closeModal}>Cancel</button>
          <button className="btn danger" disabled={busy} onClick={() => run(async () => (await api.del(`/users/@me/guilds/${guildId}`), closeModal()))}>Leave Server</button>
        </>
      }
    >
      Are you sure you want to leave <b>{guild?.name}</b>? You won't be able to rejoin this server unless you are re-invited.
    </Shell>
  );
}

function CustomStatus() {
  const me = useStore((s) => s.me)!;
  const cs = me.settings.custom_status;
  const [text, setText] = useState(cs?.text ?? '');
  const [emoji, setEmoji] = useState<string | null>(cs?.emoji ?? null);
  const [clear, setClear] = useState(0);
  return (
    <Shell
      title="Set a custom status"
      footer={
        <>
          <button className="btn link" onClick={closeModal}>Cancel</button>
          <button
            className="btn"
            onClick={() => {
              updateSettings({ custom_status: text || emoji ? { text, emoji, expires_at: clear ? Date.now() + clear * 1000 : null } : null });
              closeModal();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <label className="label">What's cookin', {me.display_name || me.username}?</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="icon-btn"
          style={{ width: 40, height: 40, fontSize: 22, background: 'var(--bg-input)', border: '1px solid var(--border-input)' }}
          onClick={(e) => openPopout(e, 'status-emoji', () => <EmojiPicker onPick={(p) => ('unicode' in p ? setEmoji(p.unicode) : null, closeLayers())} />, 'bottom')}
        >
          {emoji ?? '🙂'}
        </button>
        <input className="input" autoFocus maxLength={128} placeholder="Support has arrived!" value={text} onChange={(e) => setText(e.target.value)} />
        {(text || emoji) && <button className="icon-btn" onClick={() => (setText(''), setEmoji(null))}><X size={18} /></button>}
      </div>
      <label className="label" style={{ marginTop: 20 }}>Clear after</label>
      <select className="input select" value={clear} onChange={(e) => setClear(+e.target.value)}>
        <option value={86400}>Today</option>
        <option value={14400}>4 hours</option>
        <option value={3600}>1 hour</option>
        <option value={1800}>30 minutes</option>
        <option value={0}>Don't clear</option>
      </select>
    </Shell>
  );
}

const REPORT_REASONS: [string, string, string][] = [
  ['spam', 'Spam or scam', 'Unsolicited ads, phishing, fake giveaways'],
  ['harassment', 'Harassment or bullying', 'Targeting, insulting or threatening someone'],
  ['hate', 'Hateful content', 'Attacks based on identity or protected traits'],
  ['nsfw', 'Unwanted sexual content', 'Explicit content outside age-restricted spaces'],
  ['violence', 'Violence or gore', 'Threats or graphic violent content'],
  ['self_harm', 'Self-harm', 'Someone may be at risk'],
  ['illegal', 'Illegal content', 'Content that breaks the law'],
  ['other', 'Something else', ''],
];

function ReportMessage({ m }: { m: Extract<Modal, { type: 'report-message' }> }) {
  const { busy, error, run } = useBusy();
  const [reason, setReason] = useState<string | null>(null);
  const [details, setDetails] = useState('');
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <Shell title="Thanks for letting us know" footer={<button className="btn" onClick={closeModal}>Done</button>}>
        <div>Your report was sent to this server's moderators. The person you reported won't know who reported them.</div>
      </Shell>
    );
  }
  return (
    <Shell
      title="Report Message"
      subtitle={`From @${m.author}`}
      footer={
        <>
          <button className="btn link" onClick={closeModal}>Cancel</button>
          <button
            className="btn danger"
            disabled={!reason || busy}
            onClick={() => run(async () => (await api.post(`/channels/${m.channelId}/messages/${m.messageId}/report`, { reason, details }), setDone(true)))}
          >
            Report
          </button>
        </>
      }
    >
      {m.preview && <div className="report-preview">{m.preview}</div>}
      <label className="label">Why are you reporting this?</label>
      <div className="report-reasons">
        {REPORT_REASONS.map(([k, label, desc]) => (
          <label key={k} className={`report-reason${reason === k ? ' selected' : ''}`}>
            <input type="radio" name="reason" checked={reason === k} onChange={() => setReason(k)} />
            <span>
              <b>{label}</b>
              {desc && <small>{desc}</small>}
            </span>
          </label>
        ))}
      </div>
      <label className="label" style={{ marginTop: 12 }}>Anything else? (optional)</label>
      <textarea className="input" rows={3} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} />
      {error && <div className="field-error" style={{ marginTop: 8 }}>{error}</div>}
    </Shell>
  );
}

/** Report queue used by server moderators (guildId) and instance admins (no guildId). */
export function ReportQueue({ guildId }: { guildId?: string }) {
  const [status, setStatus] = useState<'open' | 'resolved' | 'dismissed'>('open');
  const [reports, setReports] = useState<any[] | null>(null);
  const load = () => {
    setReports(null);
    api.get<any[]>(guildId ? `/guilds/${guildId}/reports?status=${status}` : `/admin/reports?status=${status}`).then(setReports).catch(() => setReports([]));
  };
  useEffect(load, [guildId, status]);
  const act = (id: string, action: string) => api.post(`/reports/${id}/resolve`, { action }).then(load);
  return (
    <div>
      <div className="chip-row" style={{ marginBottom: 12 }}>
        {(['open', 'resolved', 'dismissed'] as const).map((s) => (
          <button key={s} className={`chip${status === s ? ' active' : ''}`} onClick={() => setStatus(s)}>{s[0].toUpperCase() + s.slice(1)}</button>
        ))}
      </div>
      {reports === null && <div className="spinner" />}
      {reports?.length === 0 && <div className="empty-state">No {status} reports.</div>}
      {reports?.map((r) => (
        <div key={r.id} className="report-card">
          <div className="rc-head">
            <span className="rc-reason">{REPORT_REASONS.find(([k]) => k === r.reason)?.[1] ?? r.reason}</span>
            {r.report_count > 1 && <span className="rc-count">{r.report_count} reports</span>}
            <span className="rc-time">{new Date(r.created_at).toLocaleString()}</span>
          </div>
          <div className="rc-msg">
            <b>@{r.message.author?.username ?? 'unknown'}</b>
            {r.message_deleted && <span className="rc-deleted"> (deleted)</span>}
            <div className="rc-content">{r.message.content || <i>(no text)</i>}</div>
            {r.message.attachments?.length > 0 && <div className="rc-att">{r.message.attachments.length} attachment(s)</div>}
          </div>
          {r.details && <div className="rc-details">“{r.details}”</div>}
          <div className="rc-foot">
            <span>Reported by @{r.reporter?.username ?? 'unknown'}</span>
            {status === 'open' && (
              <span style={{ display: 'flex', gap: 8 }}>
                <button className="btn sm link" onClick={() => act(r.id, 'dismiss')}>Dismiss</button>
                {!r.message_deleted && <button className="btn sm danger" onClick={() => act(r.id, 'delete_message')}>Delete Message</button>}
                <button className="btn sm" onClick={() => act(r.id, 'resolve')}>Mark Resolved</button>
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Confirm({ m }: { m: Extract<Modal, { type: 'confirm' }> }) {
  const { busy, error, run } = useBusy();
  return (
    <Shell
      title={m.title}
      footer={
        <>
          <button className="btn link" onClick={closeModal}>Cancel</button>
          <button className={`btn${m.danger ? ' danger' : ''}`} disabled={busy} onClick={() => run(async () => (await m.onConfirm(), closeModal()))}>{m.confirm}</button>
        </>
      }
    >
      <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
      {error && <div className="field-error" style={{ marginTop: 8 }}>{error}</div>}
    </Shell>
  );
}

export function ModalHost() {
  const modal = useStore((s) => s.modal);
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeModal();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);
  if (!modal) return null;
  let content: React.ReactNode = null;
  switch (modal.type) {
    case 'create-guild': content = <CreateGuild />; break;
    case 'invite': content = <InviteModal guildId={modal.guildId} channelId={modal.channelId} />; break;
    case 'create-channel': content = <CreateChannel guildId={modal.guildId} parentId={modal.parentId} channelType={modal.channelType} />; break;
    case 'profile': content = <ProfileModal userId={modal.userId} guildId={modal.guildId} />; break;
    case 'confirm': content = <Confirm m={modal} />; break;
    case 'create-dm': content = <CreateDm />; break;
    case 'image': content = <img className="image-viewer" src={modal.url} alt="" onClick={(e) => e.stopPropagation()} />; break;
    case 'moderate': content = <Moderate action={modal.action} guildId={modal.guildId} userId={modal.userId} />; break;
    case 'nickname': content = <Nickname guildId={modal.guildId} userId={modal.userId} />; break;
    case 'channel-settings': content = <ChannelSettings channelId={modal.channelId} />; break;
    case 'screen-share': content = <ScreenShareModal />; break;
    case 'pins': content = <Pins channelId={modal.channelId} />; break;
    case 'leave-guild': content = <LeaveGuild guildId={modal.guildId} />; break;
    case 'status': content = <CustomStatus />; break;
    case 'publish-item': content = <PublishItem />; break;
    case 'report-message': content = <ReportMessage m={modal} />; break;
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
      {content}
    </div>
  );
}
