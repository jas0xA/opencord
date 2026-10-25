import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, CircleHelp, Copy, Inbox, Minus, Square, X } from 'lucide-react';
import { ChannelType, RelationshipType } from '@opencord/shared';
import { cdn } from '../lib/api';
import { displayName, goBack, goForward, navigate, useStore } from '../lib/store';
import { FriendsIcon, HashIcon, Logo, SpeakerIcon } from './Icons';
import { openPopout, Tooltip } from './Layers';
import { InboxPopout } from './Inbox';
import { openExternal } from '../lib/web';

export function WindowControls() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    window.native?.isMaximized().then(setMax);
    return window.native?.onMaximized(setMax);
  }, []);
  if (!window.native) return null;
  return (
    <div className="window-controls">
      <button onClick={() => window.native!.minimize()} aria-label="Minimize"><Minus size={16} strokeWidth={1.5} /></button>
      <button onClick={() => window.native!.maximize()} aria-label="Maximize">{max ? <Copy size={13} strokeWidth={1.5} style={{ transform: 'scaleX(-1)' }} /> : <Square size={12} strokeWidth={1.5} />}</button>
      <button className="close" onClick={() => window.native!.close()} aria-label="Close"><X size={16} strokeWidth={1.5} /></button>
    </div>
  );
}

function useTitle(): { icon: React.ReactNode; text: string } {
  const route = useStore((s) => s.route);
  const guild = useStore((s) => (s.route.kind === 'guild' ? s.guilds[s.route.guildId] : null));
  const dm = useStore((s) => (s.route.kind === 'home' && s.route.channelId ? s.privateChannels[s.route.channelId] : null));
  const me = useStore((s) => s.me);
  if (route.kind === 'guild' && guild) {
    const ch = guild.channels.find((c) => c.id === route.channelId);
    const icon = guild.icon ? <img src={cdn(guild.icon)!} alt="" /> : ch?.type === ChannelType.GUILD_VOICE ? <SpeakerIcon size={18} /> : <HashIcon size={18} />;
    return { icon, text: guild.name };
  }
  if (route.kind === 'home' && route.view === 'marketplace') return { icon: <Logo size={18} className="tb-icon" />, text: 'Marketplace' };
  if (route.kind === 'home' && route.view === 'explore') return { icon: <Logo size={18} className="tb-icon" />, text: 'Explore Servers' };
  if (dm) {
    const others = (dm.recipients ?? []).filter((r) => r.id !== me?.id);
    return { icon: <Logo size={18} className="tb-icon" />, text: dm.type === ChannelType.GROUP_DM ? dm.name || others.map((u) => displayName(u)).join(', ') : 'Direct Messages' };
  }
  return { icon: <FriendsIcon size={18} />, text: 'Friends' };
}

export function TitleBar() {
  const canBack = useStore((s) => s.history.length > 0);
  const canForward = useStore((s) => s.future.length > 0);
  const pending = useStore((s) => Object.values(s.relationships).filter((r) => r.type === RelationshipType.INCOMING).length);
  const { icon, text } = useTitle();
  return (
    <div className="titlebar">
      <div className="titlebar-nav">
        <button disabled={!canBack} onClick={goBack} aria-label="Back"><ArrowLeft size={18} /></button>
        <button disabled={!canForward} onClick={goForward} aria-label="Forward"><ArrowRight size={18} /></button>
      </div>
      <div className="titlebar-title">
        {icon}
        <span>{text}</span>
      </div>
      <div className="titlebar-right">
        {pending > 0 && (
          <Tooltip text="Pending friend requests" side="bottom">
            <button className="tb-btn" onClick={() => navigate({ kind: 'home', view: 'friends' })}>
              <FriendsIcon size={18} />
              {pending}
            </button>
          </Tooltip>
        )}
        <Tooltip text="Inbox" side="bottom">
          <button className="tb-btn" onClick={(e) => openPopout(e, 'inbox', () => <InboxPopout />, 'bottom')}><Inbox size={18} /></button>
        </Tooltip>
        <Tooltip text="Help" side="bottom">
          <button className="tb-btn" onClick={() => openExternal('https://github.com/jas0xa/opencord#readme')}><CircleHelp size={18} /></button>
        </Tooltip>
        <WindowControls />
      </div>
    </div>
  );
}
