import { useEffect, useState } from 'react';
import { Check, Trash2, X } from 'lucide-react';
import type { MarketplaceItem, PublicUser } from '@opencord/shared';
import { api } from '../../lib/api';
import { displayName, toast, useStore } from '../../lib/store';
import { formatShortDate } from '../../lib/utils';
import { Avatar } from '../../components/Avatar';
import { MarketplacePreview } from '../../components/Cosmetics';
import { Toggle } from '../server-settings/ServerSettings';
import { Row } from './UserSettings';
import { ReportQueue } from '../../components/Modals';

interface Stats {
  users: number; guilds: number; messages: number; marketplace_items: number; online: number;
  registration: 'open' | 'invite_only' | 'allowlist' | 'closed'; community_marketplace: boolean; require_approval: boolean;
}

type AdminUser = PublicUser & { email: string; admin: boolean; disabled: boolean; online: boolean };

export function AdminPage() {
  const me = useStore((s) => s.me)!;
  const [stats, setStats] = useState<Stats | null>(null);
  const [allow, setAllow] = useState<{ email: string; note: string; added_at: number; used_at: number | null }[]>([]);
  const [email, setEmail] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [q, setQ] = useState('');
  const [queue, setQueue] = useState<{ pending: MarketplaceItem[]; reports: { item: MarketplaceItem; count: number; reasons: string }[] } | null>(null);

  const load = () => {
    api.get<Stats>('/admin/stats').then(setStats).catch((e) => toast(e.message));
    api.get('/admin/allowlist').then(setAllow);
    api.get('/admin/marketplace/queue').then(setQueue);
  };
  useEffect(load, []);
  useEffect(() => {
    const t = setTimeout(() => api.get<AdminUser[]>(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(setUsers), 200);
    return () => clearTimeout(t);
  }, [q]);

  const setting = (patch: Record<string, unknown>) => api.patch('/admin/settings', patch).then(load).catch((e) => toast(e.message));
  const moderate = (id: string, status: string) => api.post(`/admin/marketplace/items/${id}/status`, { status }).then(load);

  if (!stats) return <div className="us-page"><div className="empty-state"><div className="spinner" /></div></div>;
  return (
    <div className="us-page">
      <p className="us-desc">Instance administration for <b>{useStore.getState().instance?.name}</b>. Changes here are written to the server's config.toml.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 32 }}>
        {[['Users', stats.users], ['Online', stats.online], ['Servers', stats.guilds], ['Messages', stats.messages], ['Community items', stats.marketplace_items]].map(([l, v]) => (
          <div key={l as string} className="us-card" style={{ textAlign: 'center', marginBottom: 0 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-strong)' }}>{v}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{l}</div>
          </div>
        ))}
      </div>

      <h3>Registration</h3>
      <div className="choice-list" style={{ marginBottom: 24 }}>
        {[
          ['open', 'Open', 'Anyone can create an account.'],
          ['invite_only', 'Invite only', 'A valid server invite is required to sign up.'],
          ['allowlist', 'Allowlist', 'Only emails on the allowlist below can sign up.'],
          ['closed', 'Closed', 'Nobody can create new accounts.'],
        ].map(([v, t, d]) => (
          <button key={v} className={`choice${stats.registration === v ? ' selected' : ''}`} onClick={() => setting({ registration: v })}>
            <span style={{ flex: 1 }}>{t}<div className="ch-desc">{d}</div></span>
            {stats.registration === v && <Check size={18} />}
          </button>
        ))}
      </div>

      <h3>Email Allowlist</h3>
      <form
        style={{ display: 'flex', gap: 8, marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          api.post('/admin/allowlist', { email }).then((l) => (setAllow(l), setEmail(''))).catch((er) => toast(er.message));
        }}
      >
        <input className="input" type="email" placeholder="friend@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn" disabled={!email}>Allow Email</button>
      </form>
      <div className="list-card" style={{ marginBottom: 32 }}>
        {allow.map((a) => (
          <div key={a.email} className="list-row">
            <div className="lr-main"><div className="lr-title" style={{ fontSize: 15 }}>{a.email}</div><div className="lr-sub">{a.used_at ? `Used ${formatShortDate(a.used_at)}` : 'Not used yet'}</div></div>
            <button className="icon-btn danger" onClick={() => api.del(`/admin/allowlist/${encodeURIComponent(a.email)}`).then(setAllow)}><Trash2 size={16} /></button>
          </div>
        ))}
        {allow.length === 0 && <div className="empty-state" style={{ padding: 16 }}>No emails on the allowlist.</div>}
      </div>

      <h3>Community Marketplace</h3>
      <Row title="Enable community publishing" desc="Let users publish their own cosmetics."><Toggle on={stats.community_marketplace} onChange={(v) => setting({ community_marketplace: v })} /></Row>
      <Row title="Require approval" desc="New community items must be approved here before they are listed."><Toggle on={stats.require_approval} onChange={(v) => setting({ require_approval: v })} /></Row>
      {queue && (queue.pending.length > 0 || queue.reports.length > 0) && (
        <div style={{ marginTop: 16 }}>
          {queue.pending.map((it) => (
            <div key={it.id} className="us-card us-card-row">
              <div style={{ width: 64, height: 64, position: 'relative', display: 'grid', placeItems: 'center', overflow: 'hidden', borderRadius: 8, background: '#18181c' }}><div style={{ transform: 'scale(.5)' }}><MarketplacePreview item={it} /></div></div>
              <div className="cr-text"><div className="cr-title">{it.name} <span className="mp-pending">Pending</span></div><div className="cr-sub">{it.category} by {displayName(it.author)}</div></div>
              <button className="btn sm green" onClick={() => moderate(it.id, 'approved')}><Check size={14} /> Approve</button>
              <button className="btn sm danger" onClick={() => moderate(it.id, 'removed')}><X size={14} /> Reject</button>
            </div>
          ))}
          {queue.reports.map((r) => (
            <div key={r.item.id} className="us-card us-card-row">
              <div className="cr-text"><div className="cr-title">{r.item.name} — {r.count} report(s)</div><div className="cr-sub">{r.reasons}</div></div>
              <button className="btn sm secondary" onClick={() => moderate(r.item.id, 'dismiss')}>Dismiss</button>
              <button className="btn sm danger" onClick={() => moderate(r.item.id, 'removed')}>Remove Item</button>
            </div>
          ))}
        </div>
      )}

      <UpdatePanel />
      <NetworkPanel />

      <h3 style={{ marginTop: 32 }}>Message Reports</h3>
      <ReportQueue />

      <h3 style={{ marginTop: 32 }}>Users</h3>
      <input className="input" placeholder="Search users" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />
      <div className="list-card">
        {users.map((u) => (
          <div key={u.id} className="list-row">
            <Avatar user={u} size={32} status={u.online ? 'online' : 'offline'} ring="var(--bg-card)" decoration={false} />
            <div className="lr-main">
              <div className="lr-title" style={{ fontSize: 15 }}>{displayName(u)} {u.admin && <span className="mp-official">Admin</span>} {u.disabled && <span className="mp-pending">Disabled</span>}</div>
              <div className="lr-sub">{u.username} · {u.email} · joined {formatShortDate(u.created_at)}</div>
            </div>
            {u.id !== me.id && (
              <>
                <button className="btn sm secondary" onClick={() => api.patch(`/admin/users/${u.id}`, { admin: !u.admin }).then(() => setQ(q + ''))}>{u.admin ? 'Revoke Admin' : 'Make Admin'}</button>
                <button className={`btn sm ${u.disabled ? 'green' : 'outline-danger'}`} onClick={() => api.patch(`/admin/users/${u.id}`, { disabled: !u.disabled }).then(() => setUsers(users.map((x) => (x.id === u.id ? { ...x, disabled: !u.disabled } : x))))}>
                  {u.disabled ? 'Enable' : 'Disable'}
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface FedStatus {
  configured: boolean;
  running: boolean;
  public_url: string;
  help_host: boolean;
  seeds: string[];
  origin: string | null;
  pubkey: string | null;
  peers: { origin: string; last_ok: number | null; failures: number; pinned: number }[];
  counts: Record<string, number>;
  outbox: number;
}

/** The global OpenCord network: join/leave, help host the directory, bootstrap peers. */
function NetworkPanel() {
  const [st, setSt] = useState<FedStatus | null>(null);
  const [seeds, setSeeds] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [restart, setRestart] = useState(false);
  const load = () =>
    api.get<FedStatus>('/admin/federation').then((s) => {
      setSt(s);
      setSeeds(s.seeds.join('\n'));
      setPublicUrl(s.public_url);
    });
  useEffect(() => void load(), []);
  const patch = async (body: Record<string, unknown>) => {
    try {
      const r = await api.patch<{ restart_required: boolean }>('/admin/federation', body);
      if (r.restart_required) setRestart(true);
      await load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  if (!st) return null;
  return (
    <>
      <h3 style={{ marginTop: 32 }}>Global Network</h3>
      <p className="us-desc">
        Connects this host to every other OpenCord host: usernames are unique everywhere, friends and DMs work across hosts (calls are split between both hosts), and global servers, cosmetics and themes are shared.
      </p>
      {restart && <div className="info-box warn">Restart the server to apply this change.</div>}
      <Row title="Join the global network" desc={st.running ? `Connected as ${st.origin}` : st.configured && !st.public_url ? 'Set a public URL below first.' : 'Not connected.'}>
        <Toggle on={st.configured} onChange={(v) => patch({ enabled: v })} />
      </Row>
      <Row title="Help host the global network" desc="Store the shared directory and serve it to other hosts (on by default). Turning it off still lets your users use the network.">
        <Toggle on={st.help_host} onChange={(v) => patch({ help_host: v })} />
      </Row>
      <div className="form-row" style={{ marginTop: 12 }}>
        <label className="label">Public URL (how other hosts reach this one)</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" placeholder="https://chat.example.com" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} />
          <button className="btn sm" disabled={publicUrl === st.public_url} onClick={() => patch({ public_url: publicUrl })}>Save</button>
        </div>
      </div>
      <div className="form-row">
        <label className="label">Bootstrap hosts (one per line)</label>
        <textarea className="textarea" style={{ minHeight: 70, fontFamily: 'monospace' }} value={seeds} onChange={(e) => setSeeds(e.target.value)} placeholder="https://opencord.example.org" />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn sm" onClick={() => patch({ seeds: seeds.split('\n') })}>Save Hosts</button>
          {st.running && <button className="btn sm secondary" onClick={() => patch({ sync_now: true }).then(() => toast('Synced.', 'info'))}>Sync Now</button>}
        </div>
      </div>
      {st.running && (
        <div className="list-card" style={{ marginTop: 12 }}>
          <div style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)' }}>
            Directory: {st.counts.host ?? 0} hosts · {st.counts.user ?? 0} usernames · {st.counts.guild ?? 0} servers · {st.counts.item ?? 0} cosmetics · {st.counts.theme ?? 0} themes
            {st.outbox > 0 && ` · ${st.outbox} queued deliveries`}
          </div>
          {st.peers.map((p) => (
            <div key={p.origin} className="us-card-row" style={{ padding: '6px 12px' }}>
              <div className="cr-text">
                <div className="cr-title" style={{ fontSize: 14 }}>{p.origin}</div>
                <div className="cr-sub">{p.last_ok ? `last synced ${new Date(p.last_ok).toLocaleString()}` : 'never synced'}{p.failures ? ` · ${p.failures} failures` : ''}</div>
              </div>
              {!!p.pinned && (
                <button className="btn sm link" title="Forget this host's key (after it legitimately changed keys)" onClick={() => patch({ reset_pin: p.origin })}>Reset key</button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Current vs latest release, with update steps for how this server was installed. */
function UpdatePanel() {
  const [u, setU] = useState<{ current: string; latest: string | null; update_available: boolean; url: string | null; checked_at: number | null; install: 'docker' | 'tarball' | 'source' } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api.get('/admin/updates').then(setU).catch(() => {}), []);
  if (!u) return null;
  const steps = {
    docker: 'docker compose pull && docker compose up -d',
    tarball: 'Download the new server package from the release page, extract it over the old folder (keep config.toml and data/), and restart the service.',
    source: 'git pull && npm ci && restart the server',
  }[u.install];
  return (
    <>
      <h3 style={{ marginTop: 32 }}>Version</h3>
      <div className={`info-box${u.update_available ? ' warn' : ''}`}>
        <div>
          OpenCord <b>{u.current}</b>
          {u.update_available ? (
            <>
              {' '}· <b>{u.latest}</b> is available{u.url && <> (<a href={u.url} target="_blank" rel="noreferrer">what's new</a>)</>}
            </>
          ) : u.latest ? (
            ' · up to date'
          ) : (
            ''
          )}
        </div>
        {u.update_available && (
          <div style={{ marginTop: 8 }}>
            To update{u.install === 'docker' ? ', in the folder with docker-compose.yml run' : ''}: <code className="md-code" style={{ userSelect: 'text' }}>{steps}</code>
          </div>
        )}
        <button
          className="btn sm link"
          style={{ paddingLeft: 0, marginTop: 4 }}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setU(await api.get('/admin/updates?refresh=1').catch(() => u));
            setBusy(false);
          }}
        >
          {busy ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
    </>
  );
}
