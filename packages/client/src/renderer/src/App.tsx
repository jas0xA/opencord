import { useEffect, useState } from 'react';
import { api, configureApi } from './lib/api';
import { loadAccounts, openGuild, saveAccounts, startSession, toast, useStore } from './lib/store';
import { requestNotificationPermission } from './lib/notify';
import { setSoundsEnabled } from './lib/sounds';
import { voice } from './lib/voice';
import { loadActiveTheme, themeRuntime } from './lib/themes';
import { ChatView } from './components/ChatView';
import { FriendsPage } from './components/Friends';
import { GuildRail } from './components/GuildRail';
import { Logo } from './components/Icons';
import { LayerHost } from './components/Layers';
import { ModalHost } from './components/Modals';
import { GuildSidebar, HomeSidebar, UserPanel } from './components/Sidebars';
import { TitleBar } from './components/TitleBar';
import { IncomingCall } from './components/Voice';
import { InstallBanner } from './components/InstallBanner';
import { MobileNav } from './components/MobileNav';
import { isWeb, takePendingInvite } from './lib/web';
import { ConnectScreen } from './views/ConnectScreen';
import { Marketplace } from './views/Marketplace';
import { Explore } from './views/Explore';
import { ServerSettings } from './views/server-settings/ServerSettings';
import { UserSettings } from './views/settings/UserSettings';

function Shell() {
  const route = useStore((s) => s.route);
  const guild = useStore((s) => (s.route.kind === 'guild' ? s.guilds[s.route.guildId] : null));
  const connection = useStore((s) => s.connection);
  const settings = useStore((s) => s.settings);
  const toast = useStore((s) => s.toast);

  let main: React.ReactNode;
  if (route.kind === 'home') {
    if (route.view === 'marketplace') main = <Marketplace />;
    else if (route.view === 'explore') main = <Explore />;
    else if (route.view === 'dm' && route.channelId) main = <ChatView key={route.channelId} channelId={route.channelId} />;
    else main = <FriendsPage />;
  } else if (guild && route.channelId) {
    main = <ChatView key={route.channelId} channelId={route.channelId} />;
  } else {
    main = (
      <div className="main">
        <div className="chat-header" />
        <div className="empty-state" style={{ flex: 1 }}>There are no text channels you can see in this server yet.</div>
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar />
      <MobileNav />
      {connection === 'disconnected' && <div className="connection-banner">Connection lost — reconnecting…</div>}
      <div className="app-body">
        <GuildRail />
        {route.kind === 'guild' && guild ? <GuildSidebar guild={guild} /> : <HomeSidebar />}
        {main}
        <UserPanel />
      </div>
      {settings?.kind === 'user' && <UserSettings />}
      {settings?.kind === 'guild' && <ServerSettings guildId={settings.guildId} />}
      <ModalHost />
      <LayerHost />
      <IncomingCall />
      <InstallBanner />
      {toast && <div className={`toast${toast.kind === 'info' ? ' info' : ''}`}>{toast.text}</div>}
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div className="app">
      <div className="titlebar" style={{ borderBottom: 0 }} />
      <div className="loading-screen">
        <Logo size={64} className="logo-spin" style={{ color: '#5865f2', ['--logo-cut' as string]: 'var(--bg-base)' }} />
        {text}
      </div>
    </div>
  );
}

export function App() {
  const server = useStore((s) => s.server);
  const ready = useStore((s) => s.ready);
  const me = useStore((s) => s.me);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | undefined>();

  // Resume the last session on launch.
  useEffect(() => {
    (async () => {
      const accounts = await loadAccounts();
      const last = accounts.servers.find((s) => s.url === accounts.last && s.token);
      if (last) {
        try {
          configureApi(last.url, last.token!);
          const info = await api.get('/instance');
          await startSession(last, info);
        } catch (e: any) {
          if (e.status === 401) {
            last.token = null;
            await saveAccounts(accounts);
          } else setBootError(`Couldn't reach ${last.name}. ${e.message}`);
        }
      }
      setBooting(false);
    })();
    requestNotificationPermission();
  }, []);

  // Push-to-talk and global shortcuts.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const key = s.me?.settings.ptt_key;
      if (key && s.me?.settings.input_mode === 'ptt' && e.code === key) voice.setPushToTalk(true);
      if (e.key === 'Escape' && s.settings && !s.modal) useStore.setState({ settings: null });
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') voice.toggleMute();
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') voice.toggleDeafen();
    };
    const up = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.me?.settings.ptt_key && e.code === s.me.settings.ptt_key) voice.setPushToTalk(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => {
    if (me) setSoundsEnabled(me.settings.notification_sounds);
  }, [me?.settings.notification_sounds]);

  // Web invite links (/invite/<code> → /?invite=<code>) join once signed in.
  useEffect(() => {
    if (!ready) return;
    const code = takePendingInvite();
    if (!code) return;
    api
      .post<{ guild_id: string }>(`/invites/${encodeURIComponent(code)}`)
      .then((r) => setTimeout(() => openGuild(r.guild_id), 300))
      .catch((e) => toast(e.message));
  }, [ready]);

  // The user's theme (chosen per server on this device), and call events for theme scripts.
  useEffect(() => {
    themeRuntime.apply(server ? loadActiveTheme() : null);
  }, [server?.url]);
  useEffect(() => {
    const unsubscribe = voice.subscribe(() => {
      const snap = voice.getSnapshot();
      themeRuntime.voiceEvent({ in_call: !!snap.channelId, speaking: snap.speaking.size });
    });
    return () => void unsubscribe();
  }, []);

  if (booting) return <Loading text="Starting OpenCord…" />;
  if (!server) return <ConnectScreen initialError={bootError} />;
  if (!ready) return <Loading text={`Connecting to ${server.name}…`} />;
  return <Shell />;
}
