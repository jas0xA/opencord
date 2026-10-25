import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Smile, Trash2, X, Copy as CopyIcon, Sparkles, Check } from 'lucide-react';
import { BANNER_PRESETS, ChannelType, Permissions, type GuildFull } from '@opencord/shared';
import { api, cdn } from '../../lib/api';
import { ReportQueue } from '../../components/Modals';
import { cropBgStyle, cropImage, cropImgStyle, parseCrop, pickAndCropImage, stripCrop } from '../../lib/crop';
import { can, toast, useStore } from '../../lib/store';
import { acronym, copy, formatMonthYear } from '../../lib/utils';
import { WindowControls } from '../../components/TitleBar';
import { EmojiPicker } from '../../components/Pickers';
import { closeLayers, openPopout } from '../../components/Layers';
import { EmojiSettings, SoundboardSettings, StickerSettings } from './Expressions';
import { AccessSettings, InvitesSettings, MembersSettings, RolesSettings } from './People';
import { AuditLogSettings, AutoModSettings, BansSettings, IntegrationsSettings, SafetySettings } from './Moderation';

/* ───────────── shared bits ───────────── */

export function SaveBar({ onReset, onSave, busy }: { onReset: () => void; onSave: () => void; busy?: boolean }) {
  return (
    <div className="save-bar">
      <span className="grow">Careful — you have unsaved changes!</span>
      <button className="btn link sm" onClick={onReset}>Reset</button>
      <button className="btn green sm" disabled={busy} onClick={onSave}>Save Changes</button>
    </div>
  );
}

export function Section({ title, desc, children, first }: { title: string; desc?: React.ReactNode; children: React.ReactNode; first?: boolean }) {
  return (
    <>
      {!first && <div className="section-sep" />}
      <div className="section" style={first ? { marginTop: 32 } : undefined}>
        <h3 className="section-title">{title}</h3>
        {desc && <p className="section-desc">{desc}</p>}
        {children}
      </div>
    </>
  );
}

export function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <div className={`switch${on ? ' on' : ''}${disabled ? ' disabled' : ''}`} onClick={() => !disabled && onChange(!on)} role="switch" aria-checked={on} />;
}

/** List the server in the server browser, locally and/or on the global network. */
function DiscoverySettings({ guild }: { guild: GuildFull }) {
  const [state, setState] = useState<{ discoverable: boolean; global: boolean; invite: string | null; network: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/guilds/${guild.id}/discovery`).then(setState).catch((e) => toast(e.message));
  }, [guild.id]);
  const save = async (patch: { discoverable?: boolean; global?: boolean }) => {
    setBusy(true);
    try {
      const r = await api.put(`/guilds/${guild.id}/discovery`, patch);
      setState((s) => (s ? { ...s, ...r } : s));
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-page">
      <div className="settings-main">
        <h2 className="page-title">Discovery</h2>
        <p className="page-subtitle">Let people find and join this server from the server browser without an invite.</p>
        {!state ? (
          <div className="spinner" />
        ) : (
          <>
            <SettingRow title="List on this host" desc="Everyone with an account on this OpenCord host can find this server under Explore Servers and join in one click.">
              <Toggle on={state.discoverable} disabled={busy} onChange={(v) => save({ discoverable: v })} />
            </SettingRow>
            <SettingRow
              title="Make this a global server"
              desc={
                state.network
                  ? 'Publishes this server to the global OpenCord network. People on any host can find it and join with their own account; they sign in here automatically.'
                  : "This host isn't part of the global OpenCord network. Its admin can enable [federation] in config.toml."
              }
            >
              <Toggle on={state.global} disabled={busy || !state.network} onChange={(v) => save({ global: v })} />
            </SettingRow>
            {state.invite && (state.discoverable || state.global) && (
              <p className="section-desc" style={{ marginTop: 16 }}>
                Listing invite: <code className="md-code">{state.invite}</code>. It never expires; delete it under Invites to reset it.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function SettingRow({ title, desc, children }: { title: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="sr-text">
        <div className="sr-title">{title}</div>
        {desc && <div className="sr-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

export function useGuildPatch(guild: GuildFull) {
  const [busy, setBusy] = useState(false);
  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.patch(`/guilds/${guild.id}`, patch);
      return true;
    } catch (e: any) {
      toast(e.errors && Object.keys(e.errors).length ? Object.values(e.errors).join(', ') : e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, save };
}

/* ───────────── Server Profile (Image 3) ───────────── */

export function GuildPreviewCard({ guild, name, icon, banner, bannerPreset, description, traits }: {
  guild: GuildFull; name: string; icon: string | null; banner: string | null; bannerPreset: number; description?: string; traits?: { emoji: string | null; label: string }[];
}) {
  const online = useStore((s) => guild.members.filter((m) => (s.presences[m.user.id]?.status ?? 'offline') !== 'offline' || m.user.id === s.me?.id).length);
  const bg = banner ? cropBgStyle(stripCrop(banner), parseCrop(banner)) : { background: BANNER_PRESETS[bannerPreset] ?? BANNER_PRESETS[0] };
  return (
    <div className="guild-preview">
      <div className="gp-banner" style={bg} />
      <div className="gp-body">
        <div className="gp-icon">{icon ? <img src={icon} alt="" style={cropImgStyle(parseCrop(icon))} /> : acronym(name || guild.name)}</div>
        <div className="gp-name">
          {name || guild.name}
          {guild.tag && <span className="tag-preview" style={{ background: guild.tag.color, fontSize: 11, height: 18 }}>{guild.tag.text}</span>}
        </div>
        <div className="gp-meta">
          <span><i className="dot online" />{online} Online</span>
          <span><i className="dot members" />{guild.member_count} Members</span>
        </div>
        <div className="gp-est">Est. {formatMonthYear(guild.created_at)}</div>
        {description && <div className="gp-desc">{description}</div>}
        {traits && traits.some((t) => t.label) && (
          <div className="gp-traits">{traits.filter((t) => t.label).map((t, i) => <span key={i}>{t.emoji} {t.label}</span>)}</div>
        )}
      </div>
    </div>
  );
}

function ServerProfile({ guild }: { guild: GuildFull }) {
  const initial = useMemo(
    () => ({
      name: guild.name,
      icon: cdn(guild.icon),
      banner: cdn(guild.banner),
      banner_preset: guild.banner_preset,
      description: guild.description,
      traits: Array.from({ length: 5 }, (_, i) => guild.traits[i] ?? { emoji: null, label: '' }),
    }),
    [guild],
  );
  const [state, setState] = useState(initial);
  const [iconData, setIconData] = useState<string | null | undefined>(undefined);
  const [bannerData, setBannerData] = useState<string | null | undefined>(undefined);
  const { busy, save } = useGuildPatch(guild);
  useEffect(() => setState(initial), [initial]);
  const dirty = JSON.stringify(state) !== JSON.stringify(initial) || iconData !== undefined || bannerData !== undefined;
  const canManage = can(Permissions.MANAGE_GUILD, guild.id);

  const setTrait = (i: number, t: { emoji: string | null; label: string }) => setState({ ...state, traits: state.traits.map((x, j) => (j === i ? t : x)) });

  return (
    <div className="settings-page">
      <div className="settings-main">
        <h2 className="page-title">Server Profile</h2>
        <p className="page-subtitle">Customize how your server appears in invite links and, if enabled, in Server Discovery and Announcement Channel messages</p>

        <div className="section" style={{ marginTop: 30 }}>
          <h3 className="section-title">Name</h3>
          <input className="input" value={state.name} maxLength={100} disabled={!canManage} onChange={(e) => setState({ ...state, name: e.target.value })} />
        </div>

        <div className="section-sep" />
        <div className="section">
          <h3 className="section-title">Icon</h3>
          <p className="section-desc" style={{ marginBottom: 10 }}>We recommend an image of at least 512x512.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn sm"
              disabled={!canManage}
              onClick={async () => {
                const data = await pickAndCropImage('square');
                if (!data) return;
                setIconData(data);
                setState({ ...state, icon: data });
              }}
            >
              Change Server Icon
            </button>
            {state.icon && (
              <button
                className="btn sm secondary"
                disabled={!canManage}
                onClick={async () => {
                  const v = await cropImage(state.icon!, 'square');
                  if (!v) return;
                  const data = v.startsWith('data:') ? v : (guild.icon ?? '').replace(/#.*$/, '') + v.slice(v.indexOf('#'));
                  setIconData(data);
                  setState({ ...state, icon: v });
                }}
              >
                Crop / Reposition
              </button>
            )}
            {state.icon && (
              <button className="btn link sm" disabled={!canManage} onClick={() => (setIconData(null), setState({ ...state, icon: null }))}>
                Remove Icon
              </button>
            )}
          </div>
        </div>

        <div className="section-sep" />
        <div className="section">
          <h3 className="section-title">Banner</h3>
          <div className="banner-grid">
            {BANNER_PRESETS.map((bg, i) => (
              <div
                key={i}
                className={`banner-swatch${!state.banner && state.banner_preset === i ? ' selected' : ''}`}
                style={{ background: bg }}
                onClick={() => {
                  if (!canManage) return;
                  if (state.banner) setBannerData(null);
                  setState({ ...state, banner_preset: i, banner: null });
                }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              className="btn sm secondary"
              disabled={!canManage}
              onClick={async () => {
                const data = await pickAndCropImage('guild-banner');
                if (!data) return;
                setBannerData(data);
                setState({ ...state, banner: data });
              }}
            >
              Upload Custom Banner
            </button>
            {state.banner && <span style={{ fontSize: 13, color: 'var(--text-muted)', alignSelf: 'center' }}>Custom image selected</span>}
          </div>
        </div>

        <div className="section-sep" />
        <div className="section">
          <h3 className="section-title">Traits</h3>
          <p className="section-desc">Add up to 5 traits to show off your server's interests and personality.</p>
          <div className="traits-grid">
            {state.traits.map((t, i) => (
              <div key={i} className="trait">
                <button
                  disabled={!canManage}
                  onClick={(e) => openPopout(e, `trait-${i}`, () => <EmojiPicker onPick={(p) => ('unicode' in p && setTrait(i, { ...t, emoji: p.unicode }), closeLayers())} />, 'bottom')}
                >
                  {t.emoji ?? <Smile size={20} />}
                </button>
                <input value={t.label} maxLength={24} disabled={!canManage} onChange={(e) => setTrait(i, { ...t, label: e.target.value })} />
              </div>
            ))}
          </div>
        </div>

        <div className="section-sep" />
        <div className="section">
          <h3 className="section-title">Description</h3>
          <p className="section-desc">How did your server get started? Why should people join?</p>
          <textarea className="textarea" style={{ minHeight: 120 }} maxLength={300} placeholder="Tell the world a bit about this server." value={state.description} disabled={!canManage} onChange={(e) => setState({ ...state, description: e.target.value })} />
        </div>
      </div>
      <div className="settings-aside">
        <GuildPreviewCard guild={guild} name={state.name} icon={state.icon} banner={state.banner} bannerPreset={state.banner_preset} description={state.description} traits={state.traits} />
      </div>
      {dirty && (
        <SaveBar
          busy={busy}
          onReset={() => {
            setState(initial);
            setIconData(undefined);
            setBannerData(undefined);
          }}
          onSave={async () => {
            const patch: Record<string, unknown> = {};
            if (state.name !== initial.name) patch.name = state.name.trim();
            if (state.description !== initial.description) patch.description = state.description;
            if (state.banner_preset !== initial.banner_preset) patch.banner_preset = state.banner_preset;
            if (JSON.stringify(state.traits) !== JSON.stringify(initial.traits)) patch.traits = state.traits.filter((t) => t.label.trim()).map((t) => ({ ...t, label: t.label.trim() }));
            if (iconData !== undefined) patch.icon = iconData;
            if (bannerData !== undefined) patch.banner = bannerData;
            if (await save(patch)) {
              setIconData(undefined);
              setBannerData(undefined);
            }
          }}
        />
      )}
    </div>
  );
}

/* ───────────── Server Tag ───────────── */

const TAG_BADGES = ['⚔️', '🛡️', '🔥', '⭐', '💎', '🎮', '🌙', '🌸', '⚡', '👑', '🍀', '🎵'];
const TAG_COLORS = ['#5865f2', '#eb459e', '#ed4245', '#f0b232', '#57f287', '#00a8fc', '#9b59b6', '#2b2d31'];

function ServerTag({ guild }: { guild: GuildFull }) {
  const [tag, setTag] = useState(guild.tag ?? { text: '', badge: 0, color: TAG_COLORS[0] });
  const { busy, save } = useGuildPatch(guild);
  const dirty = JSON.stringify(tag) !== JSON.stringify(guild.tag ?? { text: '', badge: 0, color: TAG_COLORS[0] });
  return (
    <div className="settings-page">
      <div className="settings-main">
        <h2 className="page-title">Server Tag</h2>
        <p className="page-subtitle">A short tag members can show next to their name across this OpenCord server.</p>
        <Section title="Tag" desc="2–4 characters." first>
          <input className="input" style={{ width: 160, textTransform: 'uppercase' }} maxLength={4} value={tag.text} onChange={(e) => setTag({ ...tag, text: e.target.value.toUpperCase() })} />
        </Section>
        <Section title="Badge">
          <div className="color-swatches">
            {TAG_BADGES.map((b, i) => (
              <button key={b} className={`color-swatch big${tag.badge === i ? ' selected' : ''}`} style={{ background: 'var(--bg-card)', fontSize: 24, width: 50 }} onClick={() => setTag({ ...tag, badge: i })}>{b}</button>
            ))}
          </div>
        </Section>
        <Section title="Color">
          <div className="color-swatches">
            {TAG_COLORS.map((c) => (
              <button key={c} className={`color-swatch big${tag.color === c ? ' selected' : ''}`} style={{ background: c }} onClick={() => setTag({ ...tag, color: c })}>{tag.color === c && <Check size={18} />}</button>
            ))}
            <input type="color" value={tag.color} onChange={(e) => setTag({ ...tag, color: e.target.value })} style={{ width: 66, height: 50, background: 'none', border: 0 }} />
          </div>
        </Section>
        {guild.tag && (
          <Section title="Remove">
            <button className="btn outline-danger" onClick={() => save({ tag: null })}>Remove Server Tag</button>
          </Section>
        )}
      </div>
      <div className="settings-aside">
        <label className="label">Preview</label>
        <div className="us-card" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{useStore.getState().me?.display_name ?? useStore.getState().me?.username}</span>
          {tag.text.length >= 2 && (
            <span className="tag-preview" style={{ background: tag.color }}>
              {TAG_BADGES[tag.badge]} {tag.text}
            </span>
          )}
        </div>
      </div>
      {dirty && tag.text.length >= 2 && <SaveBar busy={busy} onReset={() => setTag(guild.tag ?? { text: '', badge: 0, color: TAG_COLORS[0] })} onSave={() => save({ tag })} />}
    </div>
  );
}

/* ───────────── Engagement ───────────── */

function Engagement({ guild }: { guild: GuildFull }) {
  const { save } = useGuildPatch(guild);
  const text = guild.channels.filter((c) => c.type === ChannelType.GUILD_TEXT);
  const voiceCh = guild.channels.filter((c) => c.type === ChannelType.GUILD_VOICE);
  return (
    <div className="settings-page">
      <div className="settings-main">
        <h2 className="page-title">Engagement</h2>
        <p className="page-subtitle">Help new members feel welcome and keep your community active.</p>
        <Section title="System Messages Channel" desc="This is the channel we send system event messages to, like welcome messages for new members." first>
          <select className="input select" value={guild.system_channel_id ?? ''} onChange={(e) => save({ system_channel_id: e.target.value || null })}>
            <option value="">No System Messages</option>
            {text.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </Section>
        <Section title="Default Notification Settings" desc="This will determine whether members who have not explicitly set their notification settings receive a notification for every message sent in this server or not.">
          <div className="choice-list">
            {[[0, 'All Messages'], [1, 'Only @mentions']].map(([v, l]) => (
              <button key={v} className={`choice${guild.default_notifications === v ? ' selected' : ''}`} onClick={() => save({ default_notifications: v })}>{l}</button>
            ))}
          </div>
        </Section>
        <Section title="Inactive Channel" desc="Automatically move members to this channel and mute them when they have been idle for longer than the inactive timeout.">
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="input select" value={guild.afk_channel_id ?? ''} onChange={(e) => save({ afk_channel_id: e.target.value || null })}>
              <option value="">No Inactive Channel</option>
              {voiceCh.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="input select" style={{ width: 180 }} value={guild.afk_timeout} onChange={(e) => save({ afk_timeout: +e.target.value })}>
              {[[60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [1800, '30 minutes'], [3600, '1 hour']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </Section>
      </div>
    </div>
  );
}

/* ───────────── Boost Perks (free) ───────────── */

function BoostPerks() {
  const instance = useStore((s) => s.instance);
  const perks = [
    ['250 emoji slots', 'and 60 sticker slots, for everyone'],
    [`${instance?.max_upload_mb ?? 25} MB uploads`, 'set by your server admin'],
    ['Custom banner & invite background', 'upload any image'],
    ['High-quality voice & screen share', 'peer-to-peer, up to 1080p'],
    ['Vanity invite URL', 'claim one under Access'],
    ['Animated icons', 'GIF server icons and emoji'],
  ];
  return (
    <div className="settings-page">
      <div className="settings-main">
        <h2 className="page-title">Boost Perks</h2>
        <p className="page-subtitle">There's nothing to buy. Every perk is unlocked for every server on OpenCord.</p>
        <div className="promo-card" style={{ marginTop: 24 }}>
          <Sparkles size={40} />
          <div>
            <h4>All perks unlocked</h4>
            <p>OpenCord is free and open source. Self-hosting means no levels, no boosts and no paywalls.</p>
          </div>
        </div>
        <div className="list-card">
          {perks.map(([t, d]) => (
            <div key={t} className="list-row">
              <Check color="var(--green-status)" />
              <div className="lr-main"><div className="lr-title">{t}</div><div className="lr-sub">{d}</div></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────── Community / Template / Delete ───────────── */

function EnableCommunity({ guild }: { guild: GuildFull }) {
  const { save } = useGuildPatch(guild);
  const on = guild.features.includes('COMMUNITY');
  const text = guild.channels.filter((c) => c.type === ChannelType.GUILD_TEXT);
  return (
    <div className="settings-page">
      <div className="settings-main">
        <h2 className="page-title">{on ? 'Community Overview' : 'Enable Community'}</h2>
        <p className="page-subtitle">Community servers get a rules channel, stricter safety defaults, announcement channels and can be featured on this OpenCord server's discovery list.</p>
        {!on ? (
          <>
            <div className="info-box">Enabling community sets verification to "Low" and the explicit media filter to scan all members if they are below that.</div>
            <button
              className="btn"
              onClick={() =>
                save({
                  features: [...new Set([...guild.features, 'COMMUNITY', 'DISCOVERABLE'])],
                  verification_level: Math.max(guild.verification_level, 1),
                  explicit_content_filter: 2,
                  rules_channel_id: guild.rules_channel_id ?? guild.system_channel_id,
                })
              }
            >
              Enable Community
            </button>
          </>
        ) : (
          <>
            <Section title="Rules or Guidelines Channel" first>
              <select className="input select" value={guild.rules_channel_id ?? ''} onChange={(e) => save({ rules_channel_id: e.target.value || null })}>
                <option value="">None</option>
                {text.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
            </Section>
            <Section title="Server Discovery">
              <SettingRow title="Show in discovery" desc="List this server for everyone on this OpenCord instance.">
                <Toggle on={guild.features.includes('DISCOVERABLE')} onChange={(v) => save({ features: v ? [...guild.features, 'DISCOVERABLE'] : guild.features.filter((f) => f !== 'DISCOVERABLE') })} />
              </SettingRow>
            </Section>
            <Section title="Disable Community">
              <button className="btn outline-danger" onClick={() => save({ features: guild.features.filter((f) => f !== 'COMMUNITY' && f !== 'DISCOVERABLE') })}>Disable Community</button>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function ServerTemplate({ guild }: { guild: GuildFull }) {
  const [json, setJson] = useState<string | null>(null);
  return (
    <div className="settings-page">
      <div className="settings-main">
        <h2 className="page-title">Server Template</h2>
        <p className="page-subtitle">Export this server's channels, roles and permissions (no messages or members) so anyone can create a copy.</p>
        <button className="btn" onClick={() => api.get(`/guilds/${guild.id}/template`).then((t) => setJson(JSON.stringify(t, null, 2))).catch((e) => toast(e.message))}>
          Generate Template
        </button>
        {json && (
          <div className="section">
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button className="btn sm secondary" onClick={() => (copy(json), toast('Template copied', 'info'))}><CopyIcon size={14} /> Copy</button>
              <button
                className="btn sm secondary"
                onClick={async () => {
                  const name = `${guild.name} (copy)`;
                  const g = await api.post('/guilds', { name, template: json }).catch((e) => toast(e.message));
                  if (g) toast(`Created ${name}`, 'info');
                }}
              >
                Create a server from this template
              </button>
            </div>
            <textarea className="textarea" readOnly style={{ minHeight: 300, fontFamily: 'var(--font-code)', fontSize: 12 }} value={json} />
          </div>
        )}
      </div>
    </div>
  );
}

function DeleteServerModal({ guild, onClose }: { guild: GuildFull; onClose: () => void }) {
  const [name, setName] = useState('');
  return (
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header"><h2>Delete '{guild.name}'</h2></div>
      <div className="modal-body">
        <div className="info-box warn">Are you sure you want to delete <b>{guild.name}</b>? This action cannot be undone.</div>
        <label className="label">Enter server name</label>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="modal-footer">
        <button className="btn link" onClick={onClose}>Cancel</button>
        <button
          className="btn danger"
          disabled={name !== guild.name}
          onClick={async () => {
            await api.del(`/guilds/${guild.id}`).catch((e) => toast(e.message));
            onClose();
            useStore.setState({ settings: null });
          }}
        >
          Delete Server
        </button>
      </div>
    </div>
  );
}

/* ───────────── layout ───────────── */

type Item = { id: string; label: string; visible: boolean; danger?: boolean; external?: boolean };

export function ServerSettings({ guildId }: { guildId: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const section = useStore((s) => (s.settings?.kind === 'guild' ? s.settings.section : 'profile'));
  const me = useStore((s) => s.me);
  const [deleting, setDeleting] = useState(false);
  if (!guild) return null;
  const P = Permissions;
  const owner = guild.owner_id === me?.id;
  const mg = can(P.MANAGE_GUILD, guildId);
  const groups: { title?: string; items: Item[] }[] = [
    {
      items: [
        { id: 'profile', label: 'Server Profile', visible: true },
        { id: 'tag', label: 'Server Tag', visible: mg },
        { id: 'engagement', label: 'Engagement', visible: mg },
        { id: 'boost', label: 'Boost Perks', visible: true },
      ],
    },
    {
      title: 'Expression',
      items: [
        { id: 'emoji', label: 'Emoji', visible: true },
        { id: 'stickers', label: 'Stickers', visible: true },
        { id: 'soundboard', label: 'Soundboard', visible: true },
      ],
    },
    {
      title: 'People',
      items: [
        { id: 'members', label: 'Members', visible: true },
        { id: 'roles', label: 'Roles', visible: can(P.MANAGE_ROLES, guildId) },
        { id: 'invites', label: 'Invites', visible: mg },
        { id: 'access', label: 'Access', visible: mg },
      ],
    },
    {
      title: 'Apps',
      items: [
        { id: 'integrations', label: 'Integrations', visible: can(P.MANAGE_WEBHOOKS, guildId) },
        { id: 'apps', label: 'App Directory', visible: true, external: true },
      ],
    },
    {
      title: 'Moderation',
      items: [
        { id: 'safety', label: 'Safety Setup', visible: mg },
        { id: 'reports', label: 'Reports', visible: can(P.MANAGE_MESSAGES, guildId) },
        { id: 'audit', label: 'Audit Log', visible: can(P.VIEW_AUDIT_LOG, guildId) },
        { id: 'bans', label: 'Bans', visible: can(P.BAN_MEMBERS, guildId) },
        { id: 'automod', label: 'AutoMod', visible: mg },
      ],
    },
    { items: [{ id: 'community', label: guild.features.includes('COMMUNITY') ? 'Community Overview' : 'Enable Community', visible: mg }, { id: 'discovery', label: 'Discovery', visible: mg }] },
    {
      items: [
        { id: 'template', label: 'Server Template', visible: mg },
        { id: 'delete', label: 'Delete Server', visible: owner, danger: true },
      ],
    },
  ];
  const go = (id: string) => {
    if (id === 'delete') return setDeleting(true);
    if (id === 'apps') return window.native?.openExternal('https://github.com/jas0xa/opencord/blob/main/docs/webhooks.md');
    useStore.setState({ settings: { kind: 'guild', guildId, section: id } });
  };
  const close = () => useStore.setState({ settings: null });

  const pages: Record<string, React.ReactNode> = {
    profile: <ServerProfile guild={guild} />,
    tag: <ServerTag guild={guild} />,
    engagement: <Engagement guild={guild} />,
    boost: <BoostPerks />,
    emoji: <EmojiSettings guild={guild} />,
    stickers: <StickerSettings guild={guild} />,
    soundboard: <SoundboardSettings guild={guild} />,
    members: <MembersSettings guild={guild} />,
    roles: <RolesSettings guild={guild} />,
    invites: <InvitesSettings guild={guild} />,
    access: <AccessSettings guild={guild} />,
    integrations: <IntegrationsSettings guild={guild} />,
    safety: <SafetySettings guild={guild} />,
    reports: (
      <div className="settings-page">
        <div className="settings-main wide">
          <h2 className="page-title">Reports</h2>
          <p className="page-subtitle">Messages members reported in this server. Instance admins see these too.</p>
          <ReportQueue guildId={guild.id} />
        </div>
      </div>
    ),
    audit: <AuditLogSettings guild={guild} />,
    bans: <BansSettings guild={guild} />,
    automod: <AutoModSettings guild={guild} />,
    community: <EnableCommunity guild={guild} />,
    discovery: <DiscoverySettings guild={guild} />,
    template: <ServerTemplate guild={guild} />,
  };

  return (
    <div className="settings-layer">
      <div className="drag-strip" />
      <WindowControls />
      <div className="settings-sidebar">
        <div className="scroller thin">
          <nav className="settings-nav">
            <div className="sn-header">{guild.name}</div>
            {groups.map((g, gi) => {
              const items = g.items.filter((i) => i.visible);
              if (!items.length) return null;
              return (
                <div key={gi}>
                  {gi > 0 && <div className="sn-sep" />}
                  {g.title && <div className="sn-cat">{g.title}</div>}
                  {items.map((i) => (
                    <button key={i.id} className={`sn-item${section === i.id ? ' active' : ''}${i.danger ? ' danger' : ''}`} onClick={() => go(i.id)}>
                      {i.label}
                      {i.external && <span className="sn-right"><ExternalLink size={16} /></span>}
                      {i.danger && <span className="sn-right"><Trash2 size={16} /></span>}
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>
        </div>
      </div>
      <div className="settings-content">
        <div className="scroller" key={section}>{pages[section] ?? pages.profile}</div>
        <div className="settings-close">
          <button onClick={close} aria-label="Close"><X size={18} /></button>
          <span>ESC</span>
        </div>
      </div>
      {deleting && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setDeleting(false)}>
          <DeleteServerModal guild={guild} onClose={() => setDeleting(false)} />
        </div>
      )}
    </div>
  );
}

