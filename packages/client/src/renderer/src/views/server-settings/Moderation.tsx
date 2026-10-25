import { useEffect, useState } from 'react';
import { Copy, Plus, Search, Trash2, ShieldAlert, Link2, AtSign, Repeat, Webhook as WebhookIcon } from 'lucide-react';
import { ChannelType, type AuditLogEntry, type AutoModRule, type Ban, type GuildFull, type PublicUser, type Webhook } from '@opencord/shared';
import { api, getBaseUrl } from '../../lib/api';
import { displayName, toast } from '../../lib/store';
import { formatTimestamp } from '../../lib/utils';
import { Avatar } from '../../components/Avatar';
import { Section, SettingRow, Toggle, useGuildPatch } from './ServerSettings';

/* ───────────── Safety Setup ───────────── */

export function SafetySettings({ guild }: { guild: GuildFull }) {
  const { save } = useGuildPatch(guild);
  const filters = [
    ["Don't scan any media content", 'Media from everyone will be shown as-is.'],
    ['Scan media content from members without a role', 'Recommended for servers that use roles for trusted members.'],
    ['Scan media content from all members', 'Recommended for public servers.'],
  ];
  return (
    <div className="settings-page">
      <div className="settings-main">
        <h2 className="page-title">Safety Setup</h2>
        <p className="page-subtitle">Keep your server safe with verification, content filtering and AutoMod.</p>
        <Section title="Explicit Media Content Filter" desc="Automatically flag messages from certain members that may contain explicit media." first>
          <div className="choice-list">
            {filters.map(([t, d], i) => (
              <button key={i} className={`choice${guild.explicit_content_filter === i ? ' selected' : ''}`} onClick={() => save({ explicit_content_filter: i })}>
                <span style={{ flex: 1 }}>{t}<div className="ch-desc">{d}</div></span>
              </button>
            ))}
          </div>
        </Section>
        <Section title="Verification">
          <SettingRow title="Require verified email" desc="New members must have a verified email to talk.">
            <Toggle on={guild.verification_level >= 1} onChange={(v) => save({ verification_level: v ? Math.max(1, guild.verification_level) : 0 })} />
          </SettingRow>
          <SettingRow title="Require two-factor authentication for moderators" desc="Moderators must enable 2FA to perform moderation actions.">
            <Toggle on={guild.verification_level >= 4} onChange={(v) => save({ verification_level: v ? 4 : Math.min(guild.verification_level, 3) })} />
          </SettingRow>
        </Section>
      </div>
    </div>
  );
}

/* ───────────── Audit Log ───────────── */

const ACTION_LABEL: Record<string, string> = {
  GUILD_UPDATE: 'updated the server', CHANNEL_CREATE: 'created a channel', CHANNEL_UPDATE: 'updated a channel', CHANNEL_DELETE: 'deleted a channel',
  CHANNEL_OVERWRITE_UPDATE: 'updated channel permissions', MEMBER_KICK: 'kicked', MEMBER_BAN_ADD: 'banned', MEMBER_BAN_REMOVE: 'unbanned',
  MEMBER_UPDATE: 'updated member', MEMBER_ROLE_UPDATE: 'updated roles for', MEMBER_TIMEOUT: 'timed out', ROLE_CREATE: 'created a role',
  ROLE_UPDATE: 'updated a role', ROLE_DELETE: 'deleted a role', INVITE_CREATE: 'created an invite', INVITE_DELETE: 'deleted an invite',
  WEBHOOK_CREATE: 'created a webhook', WEBHOOK_DELETE: 'deleted a webhook', EMOJI_CREATE: 'added an emoji', EMOJI_DELETE: 'removed an emoji',
  STICKER_CREATE: 'added a sticker', STICKER_DELETE: 'removed a sticker', SOUND_CREATE: 'added a sound', SOUND_DELETE: 'removed a sound',
  MESSAGE_DELETE: 'deleted a message by', MESSAGE_BULK_DELETE: 'bulk deleted messages', MESSAGE_PIN: 'pinned a message by', MESSAGE_UNPIN: 'unpinned a message by',
  AUTOMOD_RULE_CREATE: 'created an AutoMod rule', AUTOMOD_RULE_UPDATE: 'updated an AutoMod rule', AUTOMOD_RULE_DELETE: 'deleted an AutoMod rule',
  AUTOMOD_BLOCK_MESSAGE: 'had a message blocked by AutoMod',
};

export function AuditLogSettings({ guild }: { guild: GuildFull }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [users, setUsers] = useState<Record<string, PublicUser>>({});
  const [userFilter, setUserFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const load = (before?: string) => {
    const p = new URLSearchParams({ limit: '50' });
    if (userFilter) p.set('user_id', userFilter);
    if (actionFilter) p.set('action', actionFilter);
    if (before) p.set('before', before);
    api
      .get<{ entries: AuditLogEntry[]; users: PublicUser[] }>(`/guilds/${guild.id}/audit-logs?${p}`)
      .then((r) => {
        setEntries((cur) => (before ? [...cur, ...r.entries] : r.entries));
        setUsers((cur) => ({ ...cur, ...Object.fromEntries(r.users.map((u) => [u.id, u])) }));
        setMore(r.entries.length === 50);
      })
      .catch((e) => toast(e.message));
  };
  useEffect(() => load(), [userFilter, actionFilter]);
  const name = (id: string | null) => {
    if (!id) return '';
    const u = users[id];
    if (u) return displayName(u, guild.id);
    const ch = guild.channels.find((c) => c.id === id);
    if (ch) return `#${ch.name}`;
    const r = guild.roles.find((x) => x.id === id);
    if (r) return `@${r.name}`;
    return id;
  };
  return (
    <div className="settings-page">
      <div className="settings-main wide">
        <h2 className="page-title">Audit Log</h2>
        <div className="toolbar-row">
          <select className="input select" value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
            <option value="">Filter by user: All</option>
            {guild.members.map((m) => <option key={m.user.id} value={m.user.id}>{displayName(m.user, guild.id)}</option>)}
          </select>
          <select className="input select" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
            <option value="">Filter by action: All</option>
            {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="list-card">
          {entries.map((e) => (
            <div key={e.id}>
              <div className="audit-row" style={{ cursor: e.changes.length || e.reason ? 'pointer' : undefined }} onClick={() => setOpen(open === e.id ? null : e.id)}>
                <Avatar user={users[e.user_id]} size={32} decoration={false} />
                <div>
                  <b>{name(e.user_id)}</b> {ACTION_LABEL[e.action] ?? e.action} {e.target_id && e.target_id !== guild.id && <b>{name(e.target_id)}</b>}
                </div>
                <span className="ar-time">{formatTimestamp(e.created_at)}</span>
              </div>
              {open === e.id && (e.changes.length > 0 || e.reason) && (
                <div className="audit-changes">
                  {e.reason && <div>Reason: <b style={{ color: 'var(--text-normal)' }}>{e.reason}</b></div>}
                  {e.changes.map((c, i) => (
                    <div key={i}>
                      <code>{c.key}</code>: {c.old !== undefined && <s>{JSON.stringify(c.old)}</s>} {c.new !== undefined && <>→ {JSON.stringify(c.new)}</>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {entries.length === 0 && <div className="empty-state">No logs yet.</div>}
        </div>
        {more && entries.length > 0 && <button className="btn secondary" style={{ marginTop: 12 }} onClick={() => load(entries[entries.length - 1].id)}>Load more</button>}
      </div>
    </div>
  );
}

/* ───────────── Bans ───────────── */

export function BansSettings({ guild }: { guild: GuildFull }) {
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [q, setQ] = useState('');
  const load = () => api.get<Ban[]>(`/guilds/${guild.id}/bans`).then(setBans).catch((e) => toast(e.message));
  useEffect(() => {
    load();
  }, []);
  const list = (bans ?? []).filter((b) => !q || b.user.username.includes(q.toLowerCase()) || b.user.id === q);
  return (
    <div className="settings-page">
      <div className="settings-main wide">
        <h2 className="page-title">Server Ban List</h2>
        <p className="page-subtitle">Bans by default are by account. Banned users can't rejoin with a new invite.</p>
        <div className="search-box" style={{ width: '100%', height: 36, margin: '0 0 16px' }}>
          <input placeholder="Search bans by username or ID" value={q} onChange={(e) => setQ(e.target.value)} />
          <Search size={16} />
        </div>
        <div className="list-card">
          {list.map((b) => (
            <div key={b.user.id} className="list-row">
              <Avatar user={b.user} size={32} decoration={false} />
              <div className="lr-main">
                <div className="lr-title">{displayName(b.user)}</div>
                <div className="lr-sub">{b.reason ? `Reason: ${b.reason}` : 'No reason given'} · {formatTimestamp(b.created_at)}</div>
              </div>
              <button className="btn sm outline-danger" onClick={() => api.del(`/guilds/${guild.id}/bans/${b.user.id}`).then(load)}>Revoke Ban</button>
            </div>
          ))}
          {bans && list.length === 0 && <div className="empty-state">{q ? 'No bans match.' : 'No bans. You must be a pretty friendly server!'}</div>}
        </div>
      </div>
    </div>
  );
}

/* ───────────── AutoMod ───────────── */

const TRIGGERS: { id: AutoModRule['trigger']; title: string; desc: string; icon: React.ReactNode }[] = [
  { id: 'keyword', title: 'Block Custom Words', desc: 'Block messages with specific words or phrases (wildcards with *).', icon: <ShieldAlert size={22} /> },
  { id: 'spam', title: 'Block Repeated Messages', desc: 'Block members posting the same message over and over.', icon: <Repeat size={22} /> },
  { id: 'mention_spam', title: 'Block Mention Spam', desc: 'Block messages with too many unique @mentions.', icon: <AtSign size={22} /> },
  { id: 'link', title: 'Block Links', desc: 'Block any URL except those in the allow list.', icon: <Link2 size={22} /> },
];

function RuleEditor({ guild, rule, onDone }: { guild: GuildFull; rule: Partial<AutoModRule> & { trigger: AutoModRule['trigger'] }; onDone: () => void }) {
  const [r, setR] = useState({
    name: rule.name ?? TRIGGERS.find((t) => t.id === rule.trigger)!.title,
    enabled: rule.enabled ?? true,
    trigger: rule.trigger,
    keywords: (rule.keywords ?? []).join(', '),
    allow_list: (rule.allow_list ?? []).join(', '),
    mention_limit: rule.mention_limit ?? 5,
    block: rule.actions ? rule.actions.some((a) => a.type === 'block') : true,
    message: rule.actions?.find((a) => a.type === 'block')?.message ?? '',
    alert: rule.actions?.find((a) => a.type === 'alert')?.channel_id ?? '',
    timeout: rule.actions?.find((a) => a.type === 'timeout')?.duration ?? 0,
    exempt_roles: rule.exempt_roles ?? [],
  });
  const save = async () => {
    const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
    const actions: AutoModRule['actions'] = [];
    if (r.block) actions.push({ type: 'block', message: r.message || undefined });
    if (r.alert) actions.push({ type: 'alert', channel_id: r.alert });
    if (r.timeout) actions.push({ type: 'timeout', duration: r.timeout });
    if (!actions.length) return toast('Pick at least one response.');
    const body = { name: r.name, enabled: r.enabled, trigger: r.trigger, keywords: split(r.keywords), allow_list: split(r.allow_list), mention_limit: r.mention_limit, actions, exempt_roles: r.exempt_roles, exempt_channels: [] };
    try {
      if (rule.id) await api.patch(`/guilds/${guild.id}/auto-moderation/rules/${rule.id}`, body);
      else await api.post(`/guilds/${guild.id}/auto-moderation/rules`, body);
      onDone();
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <div className="us-card">
      <div className="form-row">
        <label className="label">Rule name</label>
        <input className="input" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} />
      </div>
      {r.trigger === 'keyword' && (
        <div className="form-row">
          <label className="label">Words (comma separated)</label>
          <textarea className="textarea" value={r.keywords} onChange={(e) => setR({ ...r, keywords: e.target.value })} placeholder="badword, *scam*, free gift" />
        </div>
      )}
      {(r.trigger === 'keyword' || r.trigger === 'link') && (
        <div className="form-row">
          <label className="label">Allow list (comma separated)</label>
          <input className="input" value={r.allow_list} onChange={(e) => setR({ ...r, allow_list: e.target.value })} placeholder={r.trigger === 'link' ? 'youtube.com, github.com' : ''} />
        </div>
      )}
      {r.trigger === 'mention_spam' && (
        <div className="form-row">
          <label className="label">Max mentions per message — {r.mention_limit}</label>
          <input type="range" min={1} max={50} value={r.mention_limit} onChange={(e) => setR({ ...r, mention_limit: +e.target.value })} style={{ width: '100%' }} />
        </div>
      )}
      <div className="perm-group-title">Responses</div>
      <SettingRow title="Block message" desc="Prevents the message from being sent.">
        <Toggle on={r.block} onChange={(v) => setR({ ...r, block: v })} />
      </SettingRow>
      {r.block && <input className="input" style={{ marginTop: 8 }} placeholder="Custom message shown to the member (optional)" value={r.message} onChange={(e) => setR({ ...r, message: e.target.value })} />}
      <div className="setting-row">
        <div className="sr-text"><div className="sr-title">Send alert to channel</div></div>
        <select className="input select" style={{ width: 220 }} value={r.alert} onChange={(e) => setR({ ...r, alert: e.target.value })}>
          <option value="">Don't alert</option>
          {guild.channels.filter((c) => c.type === ChannelType.GUILD_TEXT).map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
      </div>
      <div className="setting-row">
        <div className="sr-text"><div className="sr-title">Time out member</div></div>
        <select className="input select" style={{ width: 220 }} value={r.timeout} onChange={(e) => setR({ ...r, timeout: +e.target.value })}>
          {[[0, "Don't time out"], [60, '60 seconds'], [300, '5 minutes'], [600, '10 minutes'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div className="perm-group-title">Exempt roles</div>
      <div className="profile-roles">
        {guild.roles.filter((x) => x.id !== guild.id).map((role) => {
          const on = r.exempt_roles.includes(role.id);
          return (
            <button key={role.id} className="role-pill" style={on ? { outline: '1px solid var(--brand-light)' } : undefined} onClick={() => setR({ ...r, exempt_roles: on ? r.exempt_roles.filter((x) => x !== role.id) : [...r.exempt_roles, role.id] })}>
              <span className="rp-dot" style={{ background: role.color ?? '#99aab5' }} />{role.name}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button className="btn link" onClick={onDone}>Cancel</button>
        <button className="btn green" onClick={save}>Save Rule</button>
      </div>
    </div>
  );
}

export function AutoModSettings({ guild }: { guild: GuildFull }) {
  const [rules, setRules] = useState<AutoModRule[] | null>(null);
  const [editing, setEditing] = useState<(Partial<AutoModRule> & { trigger: AutoModRule['trigger'] }) | null>(null);
  const load = () => api.get<AutoModRule[]>(`/guilds/${guild.id}/auto-moderation/rules`).then(setRules).catch((e) => toast(e.message));
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="settings-page">
      <div className="settings-main wide">
        <h2 className="page-title">AutoMod</h2>
        <p className="page-subtitle">Set up rules that automatically block, alert on or time out members for unwanted messages. Members with Manage Server are exempt.</p>
        {editing && <RuleEditor guild={guild} rule={editing} onDone={() => (setEditing(null), load())} />}
        {!editing && (
          <>
            <div className="list-card" style={{ marginBottom: 24 }}>
              {TRIGGERS.map((t) => (
                <div key={t.id} className="list-row">
                  {t.icon}
                  <div className="lr-main"><div className="lr-title">{t.title}</div><div className="lr-sub">{t.desc}</div></div>
                  <button className="btn sm" onClick={() => setEditing({ trigger: t.id })}><Plus size={14} /> Create</button>
                </div>
              ))}
            </div>
            <Section title="Your rules" first>
              <div className="list-card">
                {rules?.map((rule) => (
                  <div key={rule.id} className="list-row">
                    <div className="lr-main" style={{ cursor: 'pointer' }} onClick={() => setEditing(rule)}>
                      <div className="lr-title">{rule.name}</div>
                      <div className="lr-sub">{TRIGGERS.find((t) => t.id === rule.trigger)?.title} · {rule.actions.map((a) => a.type).join(', ')}</div>
                    </div>
                    <Toggle on={rule.enabled} onChange={(v) => api.patch(`/guilds/${guild.id}/auto-moderation/rules/${rule.id}`, { enabled: v }).then(load)} />
                    <button className="icon-btn danger" onClick={() => api.del(`/guilds/${guild.id}/auto-moderation/rules/${rule.id}`).then(load)}><Trash2 size={16} /></button>
                  </div>
                ))}
                {rules?.length === 0 && <div className="empty-state">No rules yet.</div>}
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────── Integrations (webhooks) ───────────── */

export function IntegrationsSettings({ guild }: { guild: GuildFull }) {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const textChannels = guild.channels.filter((c) => c.type === ChannelType.GUILD_TEXT || c.type === ChannelType.GUILD_ANNOUNCEMENT);
  const load = () => api.get<Webhook[]>(`/guilds/${guild.id}/webhooks`).then(setHooks).catch((e) => toast(e.message));
  useEffect(() => {
    load();
  }, []);
  const create = async () => {
    const ch = textChannels[0];
    if (!ch) return toast('Create a text channel first.');
    await api.post(`/channels/${ch.id}/webhooks`, { name: `Hook ${(hooks?.length ?? 0) + 1}` }).catch((e) => toast(e.message));
    load();
  };
  return (
    <div className="settings-page">
      <div className="settings-main wide">
        <h2 className="page-title">Integrations</h2>
        <p className="page-subtitle">Webhooks are an easy way to post messages from other apps and bots into your channels.</p>
        <div className="info-box">
          <WebhookIcon size={20} />
          <div>POST JSON like <code className="md-code">{'{"content":"Hello","username":"Bot"}'}</code> to a webhook URL to send a message.</div>
        </div>
        <button className="btn" onClick={create}><Plus size={16} /> New Webhook</button>
        <Section title="Webhooks">
          <div className="list-card">
            {hooks?.map((h) => {
              const url = `${getBaseUrl()}/api/v1/webhooks/${h.id}/${h.token}`;
              return (
                <div key={h.id} className="list-row" style={{ flexWrap: 'wrap' }}>
                  <WebhookIcon size={28} color="var(--text-muted)" />
                  <input className="input" style={{ width: 180, height: 32 }} defaultValue={h.name} onBlur={(e) => e.target.value !== h.name && api.patch(`/webhooks/${h.id}`, { name: e.target.value }).then(load)} />
                  <select className="input select" style={{ width: 180, height: 32 }} value={h.channel_id} onChange={(e) => api.patch(`/webhooks/${h.id}`, { channel_id: e.target.value }).then(load)}>
                    {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                  </select>
                  <div className="lr-main lr-sub">by {displayName(h.creator)}</div>
                  <button className="btn sm secondary" onClick={() => (navigator.clipboard.writeText(url), toast('Webhook URL copied', 'info'))}><Copy size={14} /> Copy URL</button>
                  <button className="icon-btn danger" onClick={() => api.del(`/webhooks/${h.id}`).then(load)}><Trash2 size={16} /></button>
                </div>
              );
            })}
            {hooks?.length === 0 && <div className="empty-state">No webhooks yet.</div>}
          </div>
        </Section>
      </div>
    </div>
  );
}
