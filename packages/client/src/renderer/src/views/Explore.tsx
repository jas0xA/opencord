import { useEffect, useState } from 'react';
import { Compass, Globe, Search, Server, Users } from 'lucide-react';
import { BANNER_PRESETS } from '@opencord/shared';
import { api, cdn } from '../lib/api';
import { cropBgStyle, cropImgStyle, parseCrop, stripCrop } from '../lib/crop';
import { directory, useNetwork, visitHost, type DirectoryEntry } from '../lib/network';
import { openGuild, toast, useStore } from '../lib/store';
import { acronym } from '../lib/utils';

interface LocalGuild {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  banner: string | null;
  banner_preset: number;
  member_count: number;
  online_count: number;
  global: boolean;
  joined: boolean;
}

interface Card {
  key: string;
  name: string;
  description: string;
  icon: string | null;
  banner: string | null;
  banner_preset: number;
  members: number;
  online?: number;
  hostLabel: string | null;
  global: boolean;
  joined: boolean;
  join: () => Promise<void>;
}

function GuildCard({ c }: { c: Card }) {
  const [busy, setBusy] = useState(false);
  const banner = c.banner ? cropBgStyle(stripCrop(cdn(c.banner)!), parseCrop(c.banner)) : { background: BANNER_PRESETS[c.banner_preset] ?? BANNER_PRESETS[0] };
  return (
    <div className="ex-card">
      <div className="ex-banner" style={banner} />
      <div className="ex-icon">{c.icon ? <img src={cdn(c.icon)!} alt="" style={cropImgStyle(parseCrop(c.icon))} /> : acronym(c.name)}</div>
      <div className="ex-body">
        <div className="ex-name">
          {c.name}
          {c.global && (
            <span className="ex-global" title="Global server">
              <Globe size={12} />
            </span>
          )}
        </div>
        {c.hostLabel && (
          <div className="ex-host">
            <Server size={12} /> {c.hostLabel}
          </div>
        )}
        <div className="ex-desc">{c.description || 'No description.'}</div>
        <div className="ex-meta">
          {c.online !== undefined && (
            <span>
              <i className="dot online" />
              {c.online} Online
            </span>
          )}
          <span>
            <Users size={12} /> {c.members} Members
          </span>
        </div>
        <button
          className={`btn full${c.joined ? ' secondary' : ''}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await c.join();
            } catch (e: any) {
              toast(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {c.joined ? 'Open' : busy ? 'Joining…' : 'Join'}
        </button>
      </div>
    </div>
  );
}

/** Server browser: discoverable servers on this host, and global servers from the whole network. */
export function Explore() {
  const network = useNetwork();
  const guilds = useStore((s) => s.guilds);
  const [tab, setTab] = useState<'local' | 'global'>('local');
  const [q, setQ] = useState('');
  const [local, setLocal] = useState<LocalGuild[] | null>(null);
  const [global, setGlobal] = useState<DirectoryEntry[] | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (tab === 'local') {
        setLocal(null);
        api.get<LocalGuild[]>(`/discovery/guilds${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(setLocal).catch(() => setLocal([]));
      } else {
        setGlobal(null);
        directory('guild', q).then(setGlobal).catch(() => setGlobal([]));
      }
    }, 250);
    return () => clearTimeout(t);
  }, [tab, q]);

  const waitForGuild = (id: string) =>
    new Promise<void>((resolve) => {
      if (useStore.getState().guilds[id]) return resolve();
      const unsub = useStore.subscribe((s) => {
        if (s.guilds[id]) {
          unsub();
          resolve();
        }
      });
      setTimeout(() => (unsub(), resolve()), 4000);
    });

  const cards: Card[] =
    tab === 'local'
      ? (local ?? []).map((g) => ({
          key: g.id, name: g.name, description: g.description, icon: g.icon, banner: g.banner, banner_preset: g.banner_preset,
          members: g.member_count, online: g.online_count, hostLabel: null, global: g.global, joined: g.joined || !!guilds[g.id],
          join: async () => {
            if (!g.joined && !guilds[g.id]) {
              await api.post(`/discovery/guilds/${g.id}/join`);
              await waitForGuild(g.id);
            }
            openGuild(g.id);
          },
        }))
      : (global ?? []).map((g) => ({
          key: g.key, name: g.name, description: g.description ?? '', icon: g.icon, banner: g.banner, banner_preset: g.banner_preset ?? 0,
          members: g.member_count ?? 0, hostLabel: g.local ? 'This server' : `${g.host_name ?? ''} · ${new URL(g.host).host}`, global: true,
          joined: g.local && !!guilds[g.id],
          join: async () => {
            if (g.local) {
              if (!guilds[g.id]) {
                await api.post(`/discovery/guilds/${g.id}/join`);
                await waitForGuild(g.id);
              }
              return openGuild(g.id);
            }
            // Sign in to the server's host with this account, join through its listing invite, then switch there.
            await visitHost(g.host, (call) => call('POST', `/invites/${g.invite}`, {}));
          },
        }));
  const loading = tab === 'local' ? local === null : global === null;

  return (
    <div className="main">
      <div className="chat-header">
        <div className="ch-title">
          <Compass size={22} style={{ color: 'var(--text-muted)' }} />
          Explore Servers
        </div>
        <div className="sep" style={{ width: 1, height: 24, background: 'var(--border-strong)', margin: '0 8px' }} />
        <div className="tabs" style={{ display: 'flex', gap: 8 }}>
          <button className={`tab${tab === 'local' ? ' active' : ''}`} onClick={() => setTab('local')}>This Server</button>
          {network?.enabled && (
            <button className={`tab${tab === 'global' ? ' active' : ''}`} onClick={() => setTab('global')}>
              Global Community
            </button>
          )}
        </div>
      </div>
      <div className="marketplace scroller">
        <div className="mp-hero ex-hero">
          <h1>{tab === 'local' ? 'Find your community' : 'Servers across OpenCord'}</h1>
          <p>
            {tab === 'local'
              ? 'Public servers on this host. Join any of them in one click.'
              : `Global servers from every host on the OpenCord network${network?.hosts ? ` (${network.hosts} hosts)` : ''}. Joining one signs you in there with this account.`}
          </p>
          <div className="search-box ex-search">
            <input placeholder="Search servers" value={q} onChange={(e) => setQ(e.target.value)} />
            <Search size={16} />
          </div>
        </div>
        {loading ? (
          <div className="empty-state"><div className="spinner" /></div>
        ) : cards.length === 0 ? (
          <div className="empty-state">
            {tab === 'local' ? 'No public servers yet. Server owners can list theirs in Server Settings → Discovery.' : 'No global servers found.'}
          </div>
        ) : (
          <div className="ex-grid">
            {cards.map((c) => <GuildCard key={c.key} c={c} />)}
          </div>
        )}
      </div>
    </div>
  );
}
