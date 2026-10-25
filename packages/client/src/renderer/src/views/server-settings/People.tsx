import { useEffect, useMemo, useState } from 'react';
import { Check, Crown, GripVertical, Plus, Search, Trash2, X, MoreHorizontal } from 'lucide-react';
import { PERMISSION_INFO, Permissions, hasPermission, type GuildFull, type Invite, type Role } from '@opencord/shared';
import { api, getBaseUrl } from '../../lib/api';
import { displayName, guildPermissions, highestRole, openModal, toast, useStore } from '../../lib/store';
import { formatShortDate } from '../../lib/utils';
import { Avatar } from '../../components/Avatar';
import { openContextMenu } from '../../components/Layers';
import { memberMenu } from '../../components/Sidebars';
import { SaveBar, Section, SettingRow, Toggle, useGuildPatch } from './ServerSettings';

/* ───────────── Members ───────────── */

export function MembersSettings({ guild }: { guild: GuildFull }) {
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const me = useStore((s) => s.me)!;
  const members = guild.members
    .filter((m) => !q || m.user.username.includes(q.toLowerCase()) || displayName(m.user, guild.id).toLowerCase().includes(q.toLowerCase()))
    .filter((m) => !roleFilter || m.roles.includes(roleFilter))
    .sort((a, b) => b.joined_at - a.joined_at);
  return (
    <div className="settings-page">
      <div className="settings-main wide">
        <h2 className="page-title">Server Members</h2>
        <p className="page-subtitle">{guild.member_count} members. Right-click a member (or use the ⋯ menu) to moderate them.</p>
        <div className="toolbar-row">
          <div className="search-box" style={{ flex: 1, width: 'auto', height: 36 }}>
            <input placeholder="Search by username" value={q} onChange={(e) => setQ(e.target.value)} />
            <Search size={16} />
          </div>
          <select className="input select" style={{ width: 200, height: 36 }} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="">All roles</option>
            {guild.roles.filter((r) => r.id !== guild.id).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="list-card">
          {members.map((m) => {
            const roles = guild.roles.filter((r) => m.roles.includes(r.id)).sort((a, b) => b.position - a.position);
            return (
              <div key={m.user.id} className="list-row" onContextMenu={(e) => memberMenu(e, guild, m.user.id)}>
                <Avatar user={m.user} size={36} decoration={false} />
                <div className="lr-main">
                  <div className="lr-title" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {displayName(m.user, guild.id)}
                    {guild.owner_id === m.user.id && <Crown size={14} color="#f0b232" fill="#f0b232" />}
                    {m.communication_disabled_until && <span className="mp-pending" style={{ background: 'var(--red)', color: '#fff' }}>Timed out</span>}
                  </div>
                  <div className="lr-sub">{m.user.username} · joined {formatShortDate(m.joined_at)}</div>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 260, justifyContent: 'flex-end' }}>
                  {roles.slice(0, 3).map((r) => (
                    <span key={r.id} className="role-pill"><span className="rp-dot" style={{ background: r.color ?? '#99aab5' }} />{r.name}</span>
                  ))}
                  {roles.length > 3 && <span className="role-pill">+{roles.length - 3}</span>}
                </div>
                <button className="icon-btn" onClick={(e) => memberMenu(e, guild, m.user.id)}><MoreHorizontal size={18} /></button>
                {guild.owner_id === me.id && m.user.id !== me.id && (
                  <button
                    className="btn sm outline"
                    onClick={() =>
                      openModal({
                        type: 'confirm',
                        title: 'Transfer Ownership',
                        body: `Transfer ownership of ${guild.name} to ${displayName(m.user)}? You will lose owner privileges.`,
                        confirm: 'Transfer',
                        danger: true,
                        onConfirm: () => api.patch(`/guilds/${guild.id}`, { owner_id: m.user.id }),
                      })
                    }
                  >
                    Make Owner
                  </button>
                )}
              </div>
            );
          })}
          {members.length === 0 && <div className="empty-state">No members match.</div>}
        </div>
      </div>
    </div>
  );
}

/* ───────────── Roles ───────────── */

const ROLE_COLORS = ['#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#607d8b', '#11806a', '#1f8b4c', '#206694', '#71368a', '#ad1457', '#c27c0e', '#a84300', '#992d22', '#979c9f', '#546e7a'];

function RoleEditor({ guild, role }: { guild: GuildFull; role: Role }) {
  const [tab, setTab] = useState<'display' | 'permissions' | 'members'>('display');
  const [draft, setDraft] = useState(role);
  const [memberQ, setMemberQ] = useState('');
  useEffect(() => setDraft(role), [role]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(role);
  const isEveryone = role.id === guild.id;
  const myPerms = guildPermissions(guild);
  const perms = BigInt(draft.permissions);
  const setFlag = (flag: bigint, on: boolean) => setDraft({ ...draft, permissions: (on ? perms | flag : perms & ~flag).toString() });
  const groups = [...new Set(PERMISSION_INFO.map((p) => p.group))];
  const members = guild.members.filter((m) => m.roles.includes(role.id));
  const save = () =>
    api
      .patch(`/guilds/${guild.id}/roles/${role.id}`, { name: draft.name, color: draft.color, hoist: draft.hoist, mentionable: draft.mentionable, permissions: draft.permissions })
      .catch((e) => toast(e.message));
  return (
    <div className="roles-edit">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <h3 className="section-title" style={{ flex: 1, margin: 0 }}>Edit Role — {role.name}</h3>
        {!isEveryone && (
          <button
            className="icon-btn"
            onClick={(e) =>
              openContextMenu(e, [
                {
                  label: 'Delete Role',
                  danger: true,
                  onClick: () => openModal({ type: 'confirm', title: 'Delete Role', body: `Delete the role ${role.name}?`, confirm: 'Delete', danger: true, onConfirm: () => api.del(`/guilds/${guild.id}/roles/${role.id}`) }),
                },
              ])
            }
          >
            <MoreHorizontal size={18} />
          </button>
        )}
      </div>
      <div className="subtabs">
        <button className={tab === 'display' ? 'active' : ''} onClick={() => setTab('display')}>Display</button>
        <button className={tab === 'permissions' ? 'active' : ''} onClick={() => setTab('permissions')}>Permissions</button>
        {!isEveryone && <button className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>Manage Members ({members.length})</button>}
      </div>
      {tab === 'display' && (
        <>
          <div className="form-row">
            <label className="label">Role name <span className="req">*</span></label>
            <input className="input" disabled={isEveryone} value={draft.name} maxLength={100} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          {!isEveryone && (
            <>
              <div className="form-row">
                <label className="label">Role color</label>
                <div className="color-swatches">
                  <button className={`color-swatch big${!draft.color ? ' selected' : ''}`} style={{ background: '#99aab5' }} onClick={() => setDraft({ ...draft, color: null })}>{!draft.color && <Check size={18} />}</button>
                  <input type="color" value={draft.color ?? '#99aab5'} onChange={(e) => setDraft({ ...draft, color: e.target.value })} style={{ width: 66, height: 50, border: 0, background: 'none' }} />
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 24px)', gap: 6 }}>
                    {ROLE_COLORS.map((c) => (
                      <button key={c} className={`color-swatch${draft.color === c ? ' selected' : ''}`} style={{ background: c }} onClick={() => setDraft({ ...draft, color: c })} />
                    ))}
                  </div>
                </div>
              </div>
              <SettingRow title="Display role members separately from online members">
                <Toggle on={draft.hoist} onChange={(v) => setDraft({ ...draft, hoist: v })} />
              </SettingRow>
              <SettingRow title="Allow anyone to @mention this role" desc="Members with Mention @everyone can always ping this role.">
                <Toggle on={draft.mentionable} onChange={(v) => setDraft({ ...draft, mentionable: v })} />
              </SettingRow>
            </>
          )}
        </>
      )}
      {tab === 'permissions' && (
        <>
          <button className="btn sm link" style={{ marginBottom: 8 }} onClick={() => setDraft({ ...draft, permissions: '0' })}>Clear permissions</button>
          {groups.map((g) => (
            <div key={g}>
              <div className="perm-group-title">{g}</div>
              {PERMISSION_INFO.filter((p) => p.group === g).map((p) => {
                const flag = Permissions[p.key];
                const disabled = !hasPermission(myPerms, flag);
                return (
                  <SettingRow key={p.key} title={p.label} desc={p.description}>
                    <Toggle on={(perms & flag) === flag} disabled={disabled} onChange={(v) => setFlag(flag, v)} />
                  </SettingRow>
                );
              })}
            </div>
          ))}
        </>
      )}
      {tab === 'members' && (
        <>
          <div className="toolbar-row">
            <input className="input" placeholder="Search members" value={memberQ} onChange={(e) => setMemberQ(e.target.value)} />
            <button
              className="btn"
              onClick={(e) =>
                openContextMenu(
                  e,
                  guild.members
                    .filter((m) => !m.roles.includes(role.id))
                    .slice(0, 30)
                    .map((m) => ({ label: displayName(m.user, guild.id), onClick: () => api.patch(`/guilds/${guild.id}/members/${m.user.id}`, { roles: [...m.roles, role.id] }).catch((er) => toast(er.message)) })),
                )
              }
            >
              <Plus size={16} /> Add Members
            </button>
          </div>
          <div className="list-card">
            {members
              .filter((m) => !memberQ || m.user.username.includes(memberQ.toLowerCase()))
              .map((m) => (
                <div key={m.user.id} className="list-row">
                  <Avatar user={m.user} size={28} decoration={false} />
                  <div className="lr-main"><div className="lr-title" style={{ fontSize: 14 }}>{displayName(m.user, guild.id)}</div></div>
                  <button className="icon-btn" onClick={() => api.patch(`/guilds/${guild.id}/members/${m.user.id}`, { roles: m.roles.filter((r) => r !== role.id) }).catch((er) => toast(er.message))}>
                    <X size={16} />
                  </button>
                </div>
              ))}
            {members.length === 0 && <div className="empty-state">No members have this role.</div>}
          </div>
        </>
      )}
      {dirty && <SaveBar onReset={() => setDraft(role)} onSave={save} />}
    </div>
  );
}

export function RolesSettings({ guild }: { guild: GuildFull }) {
  const me = useStore((s) => s.me)!;
  const sorted = useMemo(() => [...guild.roles].sort((a, b) => b.position - a.position), [guild.roles]);
  const [selected, setSelected] = useState<string>(sorted[0]?.id ?? guild.id);
  const [dragging, setDragging] = useState<string | null>(null);
  const myTop = guild.owner_id === me.id ? Infinity : highestRole(guild, me.id)?.position ?? 0;
  const role = guild.roles.find((r) => r.id === selected) ?? guild.roles.find((r) => r.id === guild.id)!;

  const drop = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    const movable = sorted.filter((r) => r.id !== guild.id);
    const from = movable.findIndex((r) => r.id === dragging);
    const to = movable.findIndex((r) => r.id === targetId);
    const [moved] = movable.splice(from, 1);
    movable.splice(to, 0, moved);
    const positions = movable.map((r, i) => ({ id: r.id, position: movable.length - i }));
    api.patch(`/guilds/${guild.id}/roles`, positions).catch((e) => toast(e.message));
    setDragging(null);
  };

  return (
    <div className="settings-page" style={{ maxWidth: 1100 }}>
      <div className="settings-main" style={{ width: 860 }}>
        <h2 className="page-title">Roles</h2>
        <p className="page-subtitle">Use roles to group your server members and assign permissions. Drag to reorder — members can only manage roles below their highest role.</p>
        <div className="roles-layout">
          <div className="roles-list">
            <button
              className="btn sm full"
              style={{ marginBottom: 12 }}
              onClick={() => api.post<Role>(`/guilds/${guild.id}/roles`, { name: 'new role' }).then((r) => setSelected(r.id)).catch((e) => toast(e.message))}
            >
              <Plus size={14} /> Create Role
            </button>
            {sorted.map((r) => (
              <div
                key={r.id}
                className={`rl-item${selected === r.id ? ' active' : ''}${dragging === r.id ? ' dragging' : ''}`}
                draggable={r.id !== guild.id && r.position < myTop}
                onDragStart={() => setDragging(r.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => r.id !== guild.id && drop(r.id)}
                onClick={() => setSelected(r.id)}
              >
                {r.id !== guild.id && r.position < myTop && <GripVertical size={14} style={{ marginLeft: -6, opacity: 0.5 }} />}
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: r.color ?? '#99aab5', flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.id === guild.id ? guild.member_count : guild.members.filter((m) => m.roles.includes(r.id)).length}</span>
              </div>
            ))}
          </div>
          {role && (role.position < myTop || role.id === guild.id) ? (
            <RoleEditor key={role.id} guild={guild} role={role} />
          ) : (
            <div className="roles-edit empty-state">You can only edit roles below your highest role.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────── Invites ───────────── */

function remaining(ts: number) {
  const s = Math.max(0, Math.floor((ts - Date.now()) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export function InvitesSettings({ guild }: { guild: GuildFull }) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const { save } = useGuildPatch(guild);
  const load = () => api.get<Invite[]>(`/guilds/${guild.id}/invites`).then(setInvites).catch((e) => toast(e.message));
  useEffect(() => {
    load();
  }, []);
  const paused = guild.features.includes('INVITES_DISABLED');
  return (
    <div className="settings-page">
      <div className="settings-main wide">
        <h2 className="page-title">Invites</h2>
        <p className="page-subtitle">Here's a list of all active invite links. You can revoke any one.</p>
        <SettingRow title="Pause Invites" desc="Temporarily stop anyone from joining with an invite.">
          <Toggle on={paused} onChange={(v) => save({ features: v ? [...guild.features, 'INVITES_DISABLED'] : guild.features.filter((f) => f !== 'INVITES_DISABLED') })} />
        </SettingRow>
        <Section title="Active Invite Links">
          <div className="list-head"><span style={{ flex: 2 }}>Inviter</span><span style={{ flex: 1 }}>Invite Code</span><span style={{ width: 60 }}>Uses</span><span style={{ width: 110 }}>Expires</span><span style={{ width: 32 }} /></div>
          <div className="list-card">
            {invites?.map((i) => (
              <div key={i.code} className="list-row">
                <div style={{ flex: 2, display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                  <Avatar user={i.inviter} size={24} decoration={false} />
                  <span className="lr-title" style={{ fontSize: 14 }}>{displayName(i.inviter)}</span>
                </div>
                <span style={{ flex: 1, fontFamily: 'var(--font-code)', cursor: 'pointer' }} title="Copy" onClick={() => navigator.clipboard.writeText(`${getBaseUrl()}/invite/${i.code}`)}>{i.code}</span>
                <span style={{ width: 60 }}>{i.uses}{i.max_uses ? `/${i.max_uses}` : ''}</span>
                <span style={{ width: 110 }}>{i.expires_at ? remaining(i.expires_at) : '∞'}</span>
                <button className="icon-btn danger" onClick={() => api.del(`/invites/${i.code}`).then(load)}><Trash2 size={16} /></button>
              </div>
            ))}
            {invites?.length === 0 && <div className="empty-state">No active invites.</div>}
          </div>
        </Section>
      </div>
    </div>
  );
}

/* ───────────── Access ───────────── */

export function AccessSettings({ guild }: { guild: GuildFull }) {
  const { save } = useGuildPatch(guild);
  const [vanity, setVanity] = useState(guild.vanity_code ?? '');
  const levels = [
    ['None', 'Unrestricted'],
    ['Low', 'Must have a verified email'],
    ['Medium', 'Must be registered on this server for longer than 5 minutes'],
    ['High', 'Must be a member of the server for longer than 10 minutes'],
    ['Highest', 'Must have two-factor authentication enabled'],
  ];
  return (
    <div className="settings-page">
      <div className="settings-main">
        <h2 className="page-title">Access</h2>
        <p className="page-subtitle">Control who can join and what new members need before they can talk.</p>
        <Section title="Verification Level" desc="Members of the server must meet the following criteria before they can send messages in text channels or initiate a DM." first>
          <div className="choice-list">
            {levels.map(([t, d], i) => (
              <button key={t} className={`choice${guild.verification_level === i ? ' selected' : ''}`} onClick={() => save({ verification_level: i })}>
                <span style={{ flex: 1 }}>{t}<div className="ch-desc">{d}</div></span>
                {guild.verification_level === i && <Check size={18} />}
              </button>
            ))}
          </div>
        </Section>
        <Section title="Vanity URL" desc="A permanent, easy-to-share invite for your server.">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 14, whiteSpace: 'nowrap' }}>{getBaseUrl()}/invite/</span>
            <input className="input" value={vanity} onChange={(e) => setVanity(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} maxLength={32} />
            <button className="btn" onClick={() => save({ vanity_code: vanity || null })}>Save</button>
          </div>
        </Section>
      </div>
    </div>
  );
}

