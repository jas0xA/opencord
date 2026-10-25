import { useEffect, useState } from 'react';
import {
  Accessibility, Bell, ChevronLeft, CircleUser, Gamepad2, Keyboard, Laptop, Languages, LogOut, MessageSquareLock, Mic, Monitor, Palette, Pencil, Plug,
  Search, Shield, ShieldCheck, Store, Package, Wrench, X, Activity, Brush,
} from 'lucide-react';
import { CONNECTION_PROVIDERS, GatewayOp, type Connection, type UserSettings as Settings } from '@opencord/shared';
import { api } from '../../lib/api';
import { logout, navigate, sendGateway, toast, updateSettings, useStore } from '../../lib/store';
import { formatShortDate, relativeTime } from '../../lib/utils';
import { Avatar } from '../../components/Avatar';
import { connectionLogo } from '../../components/Profile';
import { Toggle } from '../server-settings/ServerSettings';
import { ProfilesPage } from './Profiles';
import { VoicePage } from './VoiceSettings';
import { AdminPage } from './AdminSettings';
import { AccountPage } from './Account';
import { ThemesPage } from './Themes';
import { openExternal } from '../../lib/web';

export function Row({ title, desc, children }: { title: string; desc?: React.ReactNode; children: React.ReactNode }) {
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

export function SettingToggle({ k, title, desc }: { k: keyof Settings; title: string; desc?: string }) {
  const value = useStore((s) => s.me?.settings[k]);
  return (
    <Row title={title} desc={desc}>
      <Toggle on={!!value} onChange={(v) => updateSettings({ [k]: v } as Partial<Settings>)} />
    </Row>
  );
}

/* ───────────── Connected Apps (Image 4) ───────────── */

function AddConnection({ type, onClose }: { type: string; onClose: () => void }) {
  const provider = CONNECTION_PROVIDERS.find((p) => p.id === type)!;
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header center">
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>{connectionLogo(type, 48)}</div>
          <h2>Connect {provider.name}</h2>
          <p>Add your {provider.name} account to your profile. Connections are shown as unverified unless the server admin has enabled OAuth for {provider.name}.</p>
        </div>
        <div className="modal-body">
          <label className="label">{type === 'domain' ? 'Domain' : 'Account name'}</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          {!provider.profileUrl && (
            <>
              <label className="label" style={{ marginTop: 16 }}>Profile URL (optional)</label>
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn link" onClick={onClose}>Cancel</button>
          <button
            className="btn"
            disabled={!name.trim()}
            onClick={() =>
              api
                .put(`/users/@me/connections/${type}`, { name: name.trim(), url: url.trim() || undefined })
                .then((c) => (useStore.setState((s) => ({ me: s.me && { ...s.me, connections: c } })), onClose()))
                .catch((e) => toast(e.message))
            }
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectionCard({ c }: { c: Connection }) {
  const provider = CONNECTION_PROVIDERS.find((p) => p.id === c.type);
  const set = (patch: Partial<Connection>) =>
    api.patch(`/users/@me/connections/${c.type}/${encodeURIComponent(c.name)}`, patch).then((list) => useStore.setState((s) => ({ me: s.me && { ...s.me, connections: list } })));
  const meta = Object.entries(c.metadata);
  return (
    <div className="conn-card">
      <div className="cc-head">
        {connectionLogo(c.type, 32)}
        <div style={{ flex: 1 }}>
          <div className="cc-name">{c.name}</div>
          <div className="cc-type">{provider?.name ?? c.type}{!c.verified && ' · unverified'}</div>
        </div>
        <button
          className="icon-btn"
          onClick={() => api.del(`/users/@me/connections/${c.type}/${encodeURIComponent(c.name)}`).then((list) => useStore.setState((s) => ({ me: s.me && { ...s.me, connections: list } })))}
        >
          <X size={18} />
        </button>
      </div>
      {meta.length > 0 && (
        <div className="cc-meta">
          {meta.map(([k, v]) => <span key={k}><b style={{ color: 'var(--text-strong)' }}>{v}</b> {k}</span>)}
        </div>
      )}
      {c.url && (
        <div className="cc-meta">
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.url}</span>
          <button className="btn sm secondary" onClick={() => openExternal(c.url!)}>Open</button>
        </div>
      )}
      <div className="cc-toggle">
        Display on profile
        <Toggle on={c.visible} onChange={(v) => set({ visible: v })} />
      </div>
      <div className="cc-toggle">
        Display details on profile
        <Toggle on={c.show_details} onChange={(v) => set({ show_details: v })} />
      </div>
    </div>
  );
}

function ConnectionsPage() {
  const connections = useStore((s) => s.me?.connections ?? []);
  const [adding, setAdding] = useState<string | null>(null);
  return (
    <div className="us-page">
      <p className="us-desc">Connect your accounts to show them on your profile, so friends can find you elsewhere — to share what you're currently listening to, playing and more.</p>
      <h3>Add a new connection</h3>
      <div className="conn-grid">
        {CONNECTION_PROVIDERS.map((p) => (
          <button key={p.id} className="conn-btn" title={p.name} onClick={() => setAdding(p.id)}>
            {connectionLogo(p.id, 26)}
          </button>
        ))}
      </div>
      <h3>Marketplace Rewards <Store size={16} /></h3>
      <div className="promo-card">
        <Package size={48} />
        <div style={{ flex: 1 }}>
          <h4>Every cosmetic is free. Jump in.</h4>
          <p>Decorations, profile effects, nameplates and themes — claim anything from the Marketplace or publish your own.</p>
        </div>
        <button className="btn sm" onClick={() => (useStore.setState({ settings: null }), navigate({ kind: 'home', view: 'marketplace' }))}>
          Open Marketplace
        </button>
      </div>
      <h3>{connections.length} connection{connections.length === 1 ? '' : 's'}</h3>
      {connections.map((c) => <ConnectionCard key={c.type + c.name} c={c} />)}
      {adding && <AddConnection type={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

/* ───────────── simple pages ───────────── */

function PrivacyPage() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="us-page">
      <h3>Privacy</h3>
      <SettingToggle k="show_activity" title="Share your activity status" desc="Let others see what you're playing or listening to." />
      <Row title="Direct message filtering" desc="Automatically blur explicit images sent in direct messages.">
        <select
          className="input select"
          style={{ width: 220 }}
          value={useStore.getState().me?.settings.explicit_filter}
          onChange={(e) => updateSettings({ explicit_filter: e.target.value as Settings['explicit_filter'] })}
        >
          <option value="all">Filter all DMs</option>
          <option value="friends">Filter DMs from non-friends</option>
          <option value="none">Don't filter</option>
        </select>
      </Row>
      <div className="section" style={{ marginTop: 32 }}>
        <h3>Request all of my data</h3>
        <p className="us-desc">Download a copy of your account, messages, connections and inventory stored on this server.</p>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const data = await api.get('/users/@me/data-export');
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'opencord-data.json';
              a.click();
            } finally {
              setBusy(false);
            }
          }}
        >
          Request Data
        </button>
      </div>
    </div>
  );
}

function MessagingPage() {
  const s = useStore((st) => st.me!.settings);
  const fr = s.friend_requests_from;
  return (
    <div className="us-page">
      <h3>Direct Messages</h3>
      <SettingToggle k="allow_dms_from_guild_members" title="Allow direct messages from server members" desc="Applies to people who share a server with you but aren't your friends." />
      <h3 style={{ marginTop: 32 }}>Who can send you a friend request</h3>
      <Row title="Everyone"><Toggle on={fr.everyone} onChange={(v) => updateSettings({ friend_requests_from: { ...fr, everyone: v } })} /></Row>
      <Row title="Friends of Friends"><Toggle on={fr.friends_of_friends || fr.everyone} onChange={(v) => updateSettings({ friend_requests_from: { ...fr, friends_of_friends: v } })} /></Row>
      <Row title="Server Members"><Toggle on={fr.server_members || fr.everyone} onChange={(v) => updateSettings({ friend_requests_from: { ...fr, server_members: v } })} /></Row>
    </div>
  );
}

function NotificationsPage() {
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  return (
    <div className="us-page">
      <SettingToggle k="desktop_notifications" title="Enable Desktop Notifications" desc="Get notified for DMs and mentions while OpenCord isn't focused." />
      {perm !== 'granted' && (
        <div className="info-box warn">
          Desktop notifications are blocked by your system.
          <button className="btn sm" onClick={() => Notification.requestPermission().then(setPerm)}>Allow</button>
        </div>
      )}
      <SettingToggle k="notification_sounds" title="Notification Sounds" desc="Play sounds for messages, calls and voice events." />
      <SettingToggle k="unread_badge" title="Enable Unread Message Badge" desc="Shows a badge on the app icon when you have unread messages." />
    </div>
  );
}

function AppearancePage() {
  const s = useStore((st) => st.me!.settings);
  const themes: { id: Settings['theme']; label: string; bg: string }[] = [
    { id: 'light', label: 'Light', bg: '#ffffff' },
    { id: 'ash', label: 'Ash', bg: '#2a2a2e' },
    { id: 'dark', label: 'Dark', bg: '#1a1a1e' },
    { id: 'onyx', label: 'Onyx', bg: '#0b0b0d' },
    { id: 'sync', label: 'Sync with computer', bg: 'linear-gradient(135deg, #ffffff 50%, #1a1a1e 50%)' },
  ];
  return (
    <div className="us-page">
      <h3>Theme</h3>
      <div style={{ display: 'flex', gap: 16, marginBottom: 32 }}>
        {themes.map((t) => (
          <div key={t.id} style={{ textAlign: 'center', fontSize: 13, cursor: 'pointer' }} onClick={() => updateSettings({ theme: t.id })}>
            <div style={{ width: 60, height: 60, borderRadius: '50%', background: t.bg, border: `2px solid ${s.theme === t.id ? 'var(--brand-light)' : 'var(--border-strong)'}`, marginBottom: 6 }} />
            {t.label}
          </div>
        ))}
      </div>
      <h3>Message Display</h3>
      <div className="choice-list" style={{ marginBottom: 32 }}>
        {(['cozy', 'compact'] as const).map((d) => (
          <button key={d} className={`choice${s.message_display === d ? ' selected' : ''}`} onClick={() => updateSettings({ message_display: d })}>
            {d === 'cozy' ? 'Cozy: Modern, beautiful, and easy on your eyes.' : 'Compact: Fit more messages on screen at one time.'}
          </button>
        ))}
      </div>
      <h3>Chat Font Scaling — {s.font_scale}px</h3>
      <input type="range" min={12} max={24} value={s.font_scale} onChange={(e) => updateSettings({ font_scale: +e.target.value })} style={{ width: '100%', marginBottom: 24 }} />
      <h3>Zoom Level — {s.zoom}%</h3>
      <input type="range" min={50} max={200} step={10} value={s.zoom} onChange={(e) => updateSettings({ zoom: +e.target.value })} style={{ width: '100%', marginBottom: 24 }} />
      <h3>Role Colors</h3>
      <select className="input select" value={s.role_colors} onChange={(e) => updateSettings({ role_colors: e.target.value as Settings['role_colors'] })}>
        <option value="name">Show role colors in names</option>
        <option value="dot">Show role colors next to names</option>
        <option value="hidden">Don't show role colors</option>
      </select>
    </div>
  );
}

function AccessibilityPage() {
  const s = useStore((st) => st.me!.settings);
  return (
    <div className="us-page">
      <h3>Saturation — {s.saturation}%</h3>
      <input type="range" min={0} max={100} value={s.saturation} onChange={(e) => updateSettings({ saturation: +e.target.value })} style={{ width: '100%', marginBottom: 24 }} />
      <SettingToggle k="reduced_motion" title="Enable Reduced Motion" desc="Reduces animations and hover effects." />
      <SettingToggle k="underline_links" title="Always underline links" />
    </div>
  );
}

function SystemPage() {
  const [tray, setTray] = useState(() => localStorage.getItem('opencord.tray') !== 'false');
  return (
    <div className="us-page">
      <Row title="Minimize to Tray" desc="Closing the window keeps OpenCord running in the system tray.">
        <Toggle on={tray} onChange={(v) => (setTray(v), localStorage.setItem('opencord.tray', String(v)), window.native?.setTray(v))} />
      </Row>
      <ShortcutRow />
      <Row title="Server" desc={useStore.getState().server?.url}>
        <button className="btn sm secondary" onClick={() => logout(true).then(() => useStore.setState({ server: null }))}>Switch Server</button>
      </Row>
    </div>
  );
}

/** Adds the running AppImage to the app launcher / switcher, replacing any entry from another version. */
function ShortcutRow() {
  const [status, setStatus] = useState<Awaited<ReturnType<NonNullable<typeof window.native>['shortcutStatus']>> | null>(null);
  useEffect(() => {
    window.native?.shortcutStatus?.().then(setStatus).catch(() => {});
  }, []);
  if (!status?.supported) return null;
  const desc = status.upToDate
    ? 'OpenCord is in your app launcher. Press again to refresh the entry.'
    : status.installed
      ? 'Your launcher entry points to a different OpenCord version. Press to replace it with this one.'
      : 'Adds OpenCord with its icon to your app launcher and app switcher.';
  return (
    <Row title="Desktop Shortcut" desc={desc}>
      <div style={{ display: 'flex', gap: 8 }}>
        {status.installed && (
          <button className="btn sm link" onClick={async () => setStatus(await window.native!.removeShortcut())}>Remove</button>
        )}
        <button
          className="btn sm"
          onClick={async () => {
            try {
              setStatus(await window.native!.installShortcut());
              toast('Shortcut created.');
            } catch (e: any) {
              toast(e.message ?? 'Could not create the shortcut.');
            }
          }}
        >
          {status.installed ? 'Replace Shortcut' : 'Create Shortcut'}
        </button>
      </div>
    </Row>
  );
}

function LanguagePage() {
  const s = useStore((st) => st.me!.settings);
  const locales = [['en-US', 'English, US'], ['en-GB', 'English, UK'], ['nl-NL', 'Nederlands'], ['de-DE', 'Deutsch'], ['fr-FR', 'Français'], ['es-ES', 'Español'], ['pl-PL', 'Polski'], ['pt-BR', 'Português do Brasil'], ['ja-JP', '日本語']];
  return (
    <div className="us-page">
      <h3>Language & Date Formatting</h3>
      <select className="input select" value={s.locale} onChange={(e) => updateSettings({ locale: e.target.value })} style={{ marginBottom: 24 }}>
        {locales.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <SettingToggle k="time_24h" title="24-hour time" desc={`Example: ${new Date().toLocaleTimeString(s.locale, { hour: 'numeric', minute: '2-digit', hour12: !s.time_24h })}`} />
    </div>
  );
}

function GamesPage() {
  const [name, setName] = useState('');
  const presence = useStore((s) => (s.me ? s.presences[s.me.id] : undefined));
  const current = presence?.activities[0];
  return (
    <div className="us-page">
      <p className="us-desc">Show what you're playing on your profile. Set it manually below — it's shown to friends and server members while you're online.</p>
      {current ? (
        <div className="us-card us-card-row">
          <Gamepad2 />
          <div className="cr-text"><div className="cr-title">{current.name}</div><div className="cr-sub">Now playing</div></div>
          <button className="btn sm secondary" onClick={() => sendGateway(GatewayOp.PRESENCE_UPDATE, { activities: [] })}>Clear</button>
        </div>
      ) : (
        <div className="us-card">No game detected.</div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="input" placeholder="Game name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim()} onClick={() => (sendGateway(GatewayOp.PRESENCE_UPDATE, { activities: [{ type: 0, name: name.trim(), started_at: Date.now() }] }), setName(''))}>
          Add it!
        </button>
      </div>
    </div>
  );
}

function KeybindsPage() {
  const binds = [
    ['Toggle Mute', 'Ctrl + Shift + M'],
    ['Toggle Deafen', 'Ctrl + Shift + D'],
    ['Push to Talk', useStore.getState().me?.settings.ptt_key || 'Not set (Voice & Video)'],
    ['Send message', 'Enter'],
    ['New line', 'Shift + Enter'],
    ['Edit last message', '↑ in an empty composer'],
    ['Close / cancel', 'Esc'],
  ];
  return (
    <div className="us-page">
      <div className="list-card">
        {binds.map(([a, k]) => (
          <div key={a} className="list-row">
            <div className="lr-main"><div className="lr-title" style={{ fontSize: 15 }}>{a}</div></div>
            <code className="md-code">{k}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function DevicesPage() {
  const [sessions, setSessions] = useState<{ id: string; current: boolean; user_agent: string; ip: string; last_used: number; created_at: number }[] | null>(null);
  const load = () => api.get('/users/@me/sessions').then(setSessions);
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="us-page">
      <p className="us-desc">Here are all the devices that are currently logged in with your account. Log out of any you don't recognise.</p>
      {sessions?.map((s) => (
        <div key={s.id} className="us-card us-card-row">
          <Laptop />
          <div className="cr-text">
            <div className="cr-title">{/Electron/.test(s.user_agent) ? 'OpenCord Desktop' : s.user_agent.split(' ')[0] || 'Unknown device'}{s.current && ' · This device'}</div>
            <div className="cr-sub">{s.ip} · active {relativeTime(s.last_used)} · since {formatShortDate(s.created_at)}</div>
          </div>
          {!s.current && <button className="icon-btn" onClick={() => api.del(`/users/@me/sessions/${s.id}`).then(load)}><X size={18} /></button>}
        </div>
      ))}
    </div>
  );
}

function AdvancedPage() {
  return (
    <div className="us-page">
      <SettingToggle k="developer_mode" title="Developer Mode" desc="Adds 'Copy ID' to context menus for users, servers, channels and messages." />
    </div>
  );
}

/* ───────────── layout ───────────── */

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: string;
}

export function UserSettings() {
  const me = useStore((s) => s.me)!;
  const section = useStore((s) => (s.settings?.kind === 'user' ? s.settings.section : 'account'));
  const [q, setQ] = useState('');
  // Phone layout: the section list and the open section take turns filling the screen.
  const [phoneNav, setPhoneNav] = useState(section === 'account');
  const [version, setVersion] = useState('');
  useEffect(() => {
    window.native?.version().then(setVersion);
  }, []);

  const groups: { title?: string; items: NavItem[] }[] = [
    {
      items: [
        { id: 'account', label: 'Account', icon: <CircleUser size={20} /> },
        { id: 'privacy', label: 'Data & Privacy', icon: <Shield size={20} /> },
        { id: 'messaging', label: 'Messaging Permissions', icon: <MessageSquareLock size={20} /> },
        { id: 'notifications', label: 'Notifications', icon: <Bell size={20} /> },
        { id: 'devices', label: 'Devices', icon: <Laptop size={20} /> },
      ],
    },
    {
      title: 'Marketplace',
      items: [
        { id: 'shop', label: 'Shop', icon: <Store size={20} /> },
        { id: 'inventory', label: 'Inventory', icon: <Package size={20} /> },
      ],
    },
    {
      title: 'Experience',
      items: [
        { id: 'voice', label: 'Voice & Video', icon: <Mic size={20} /> },
        { id: 'appearance', label: 'Appearance', icon: <Palette size={20} /> },
        { id: 'themes', label: 'Themes', icon: <Brush size={20} />, badge: 'NEW' },
        { id: 'accessibility', label: 'Accessibility', icon: <Accessibility size={20} /> },
        { id: 'system', label: 'System', icon: <Monitor size={20} /> },
        { id: 'language', label: 'Language & Time', icon: <Languages size={20} /> },
        { id: 'keybinds', label: 'Keybinds', icon: <Keyboard size={20} /> },
      ],
    },
    {
      title: 'Games & Apps',
      items: [
        { id: 'games', label: 'Registered Games', icon: <Gamepad2 size={20} /> },
        { id: 'activity', label: 'Activity Privacy', icon: <Activity size={20} /> },
        { id: 'connections', label: 'Connected Apps', icon: <Plug size={20} /> },
        { id: 'advanced', label: 'Advanced', icon: <Wrench size={20} /> },
      ],
    },
  ];
  if (me.admin) groups.push({ title: 'Instance', items: [{ id: 'admin', label: 'Server Admin', icon: <ShieldCheck size={20} /> }] });

  const all = groups.flatMap((g) => g.items);
  const title = section === 'profiles' ? 'Profiles' : all.find((i) => i.id === section)?.label ?? 'Account';
  const go = (id: string) => {
    if (id === 'shop' || id === 'inventory') {
      useStore.setState({ settings: null });
      navigate({ kind: 'home', view: 'marketplace' });
      return;
    }
    useStore.setState({ settings: { kind: 'user', section: id } });
    setPhoneNav(false);
  };
  const close = () => useStore.setState({ settings: null });

  const pages: Record<string, React.ReactNode> = {
    account: <AccountPage />,
    profiles: <ProfilesPage />,
    privacy: <PrivacyPage />,
    messaging: <MessagingPage />,
    notifications: <NotificationsPage />,
    devices: <DevicesPage />,
    voice: <VoicePage />,
    appearance: <AppearancePage />,
    themes: <ThemesPage />,
    accessibility: <AccessibilityPage />,
    system: <SystemPage />,
    language: <LanguagePage />,
    keybinds: <KeybindsPage />,
    games: <GamesPage />,
    activity: <div className="us-page"><SettingToggle k="show_activity" title="Share my activity" desc="Show your current game and custom status to others." /></div>,
    connections: <ConnectionsPage />,
    advanced: <AdvancedPage />,
    admin: <AdminPage />,
  };

  return (
    <div className="us-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`us-modal${phoneNav ? ' phone-nav' : ''}`}>
        <div className="us-nav scroller thin">
          <div className="us-nav-inner">
            <div className="us-me" onClick={() => go('profiles')}>
              <Avatar user={me} size={48} decoration={false} />
              <div style={{ minWidth: 0 }}>
                <div className="us-me-name">{me.display_name || me.username}</div>
                <div className="us-me-edit">Edit Profiles <Pencil size={13} /></div>
              </div>
            </div>
            <div className="us-search">
              <Search size={18} />
              <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {groups.map((g, gi) => {
              const items = g.items.filter((i) => !q || i.label.toLowerCase().includes(q.toLowerCase()));
              if (!items.length) return null;
              return (
                <div key={gi}>
                  {gi > 0 && <div className="us-sep" />}
                  {g.title && <div className="us-cat">{g.title}</div>}
                  {items.map((i) => (
                    <button key={i.id} className={`us-item${section === i.id ? ' active' : ''}`} onClick={() => go(i.id)}>
                      {i.icon}
                      {i.label}
                      {i.badge && <span className="badge-new brand">{i.badge}</span>}
                    </button>
                  ))}
                </div>
              );
            })}
            <div className="us-sep" />
            <button className="us-item danger" onClick={() => logout()}>
              <LogOut size={20} /> Log Out
            </button>
            <div className="us-version">
              OpenCord {version || '0.1.0'}
              <br />
              Server {useStore.getState().instance?.version} · {useStore.getState().server?.url.replace(/^https?:\/\//, '')}
            </div>
          </div>
        </div>
        <div className="us-content">
          <div className="us-topbar">
            <button className="phone-back" onClick={() => setPhoneNav(true)} aria-label="Back"><ChevronLeft size={24} /></button>
            {title}
            <button className="us-close" onClick={close} aria-label="Close"><X size={24} /></button>
          </div>
          <div className="us-scroll scroller" key={section}>{pages[section] ?? pages.account}</div>
        </div>
      </div>
    </div>
  );
}
