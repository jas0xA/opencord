import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mic, MicOff, Monitor, Phone, PhoneOff, Video, VideoOff, Headphones, HeadphoneOff, Maximize2, VolumeX } from 'lucide-react';
import { ChannelType, type Channel, type UserSettings } from '@opencord/shared';
import { api } from '../lib/api';
import { closeModal, displayName, getUser, openDm, openModal, updateSettings, useStore } from '../lib/store';
import { streamBitrate, voice } from '../lib/voice';
import { Avatar } from './Avatar';
import { openContextMenu, Tooltip } from './Layers';
import { userControlItems } from './UserControls';

export function useVoice() {
  return useSyncExternalStore(voice.subscribe, voice.getSnapshot);
}

function VideoEl({ stream, muted = true, mirror }: { stream: MediaStream; muted?: boolean; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} style={mirror ? { transform: 'scaleX(-1)' } : undefined} onDoubleClick={(e) => (e.currentTarget as HTMLVideoElement).requestFullscreen?.()} />;
}

/**
 * Picks the column count that gives the largest 16:9 tiles for `count` tiles inside a w×h box, so a
 * crowded call shrinks every tile instead of overflowing the window.
 */
function bestGrid(count: number, w: number, h: number, gap: number) {
  let best = { cols: 1, tileW: 0, tileH: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    let tileW = (w - gap * (cols - 1)) / cols;
    let tileH = (tileW * 9) / 16;
    const maxH = (h - gap * (rows - 1)) / rows;
    if (tileH > maxH) {
      tileH = maxH;
      tileW = (tileH * 16) / 9;
    }
    if (tileW > best.tileW) best = { cols, tileW, tileH };
  }
  return best;
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Grid of participant tiles used for DM calls and voice channels. */
export function CallTiles({ channelId, guildId, full }: { channelId: string; guildId: string | null; full?: boolean }) {
  const snap = useVoice();
  const voiceStates = useStore((s) => s.voiceStates);
  const me = useStore((s) => s.me);
  const [ref, box] = useElementSize<HTMLDivElement>();
  const participants = Object.values(voiceStates).filter((v) => v.channel_id === channelId);
  const entries: { key: string; v: (typeof participants)[number]; video?: { kind: string; stream: MediaStream } }[] = [];
  for (const v of participants) {
    const isMe = v.user_id === me?.id;
    // Only show remote video the user says is on: a stale consumer would otherwise linger as a black tile.
    const videos = isMe
      ? ([snap.camera && { kind: 'camera', stream: snap.camera }, snap.screen && { kind: 'screen', stream: snap.screen }].filter(Boolean) as { kind: string; stream: MediaStream }[])
      : snap.remoteVideo.filter((r) => r.userId === v.user_id && (r.kind === 'screen' ? v.self_stream : v.self_video));
    if (videos.length) for (const vid of videos) entries.push({ key: `${v.user_id}-${vid.kind}`, v, video: vid });
    else entries.push({ key: v.user_id, v });
  }

  const gap = entries.length > 9 ? 6 : 12;
  const panels = full || entries.some((e) => e.video);
  const grid = bestGrid(Math.max(1, entries.length), box.w, box.h, gap);
  // Avatar size follows the tile so crowded calls scale down; the compact strip uses a fixed row height.
  const avatarSize = panels ? Math.max(32, Math.min(96, Math.round(grid.tileH * 0.45))) : Math.max(36, Math.min(80, Math.round((box.w - gap * entries.length) / Math.max(1, entries.length) - 24)));

  const tiles = entries.map(({ key, v, video }) => {
    const user = getUser(v.user_id);
    const isMe = v.user_id === me?.id;
    const speaking = snap.speaking.has(v.user_id);
    const name = displayName(user, guildId);
    const mutedByMe = !isMe && !!me?.settings.user_overrides?.[v.user_id]?.mute_voice;
    // Right-click / long-press a person for their volume, mute and block.
    const menu = isMe
      ? undefined
      : (e: React.MouseEvent) =>
          openContextMenu(e, [
            { label: 'Profile', onClick: () => openModal({ type: 'profile', userId: v.user_id, guildId: guildId ?? undefined }) },
            ...userControlItems(v.user_id),
          ]);
    if (video) {
      return (
        <div key={key} className={`call-tile${speaking ? ' speaking' : ''}`} onContextMenu={menu}>
          <VideoEl stream={video.stream} mirror={isMe && video.kind === 'camera'} />
          <div className="ct-name">
            {(v.self_mute || v.mute) && <MicOff size={14} />}
            {mutedByMe && <VolumeX size={14} />}
            {name}
            {video.kind === 'screen' && ' (screen)'}
          </div>
        </div>
      );
    }
    const badge = Math.max(18, Math.round(avatarSize * 0.3));
    return (
      <div key={key} className={`call-tile${panels ? '' : ' avatar-only'}${speaking && panels ? ' speaking' : ''}`} onContextMenu={menu}>
        <div className="ct-avatar">
          <Avatar user={user} size={avatarSize} speaking={speaking} decoration={false} />
          {(v.self_mute || v.mute || v.self_deaf) && (
            <div style={{ position: 'absolute', right: 2, bottom: 2, width: badge, height: badge, borderRadius: '50%', background: 'var(--red)', display: 'grid', placeItems: 'center', border: '3px solid #000' }}>
              {v.self_deaf ? <HeadphoneOff size={badge * 0.5} color="#fff" /> : <MicOff size={badge * 0.5} color="#fff" />}
            </div>
          )}
        </div>
        <div className="ct-name">
          {mutedByMe && <VolumeX size={14} style={{ verticalAlign: -2, marginRight: 4 }} />}
          {name}
        </div>
      </div>
    );
  });
  const style = panels && box.w > 0 ? ({ ['--tile-w' as string]: `${Math.floor(grid.tileW)}px`, ['--tile-h' as string]: `${Math.floor(grid.tileH)}px`, ['--tile-gap' as string]: `${gap}px` } as React.CSSProperties) : undefined;
  return (
    <div ref={ref} className="call-tiles" style={style}>
      {tiles}
    </div>
  );
}

function CallControls({ channelId, guildId }: { channelId: string; guildId: string | null }) {
  const snap = useVoice();
  const inCall = snap.channelId === channelId;
  if (!inCall) {
    return (
      <div className="call-controls">
        <button className="join" onClick={() => voice.join(channelId, guildId)}>
          <Phone size={18} /> Join Call
        </button>
      </div>
    );
  }
  return (
    <div className="call-controls">
      <Tooltip text={snap.camera ? 'Turn Off Camera' : 'Turn On Camera'}>
        <button className={snap.camera ? '' : ''} onClick={() => voice.setCamera(!snap.camera)}>
          {snap.camera ? <Video size={20} /> : <VideoOff size={20} />}
        </button>
      </Tooltip>
      <Tooltip text={snap.screen ? 'Stream Quality / Stop' : 'Share Screen'}>
        <button onClick={() => openModal({ type: 'screen-share' })}>
          <Monitor size={20} color={snap.screen ? 'var(--green-status)' : undefined} />
        </button>
      </Tooltip>
      <Tooltip text={snap.muted ? 'Unmute' : 'Mute'}>
        <button className={snap.muted ? 'off' : ''} onClick={() => voice.toggleMute()}>
          {snap.muted ? <MicOff size={20} /> : <Mic size={20} />}
        </button>
      </Tooltip>
      <Tooltip text={snap.deafened ? 'Undeafen' : 'Deafen'}>
        <button className={snap.deafened ? 'off' : ''} onClick={() => voice.toggleDeafen()}>
          {snap.deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
        </button>
      </Tooltip>
      <Tooltip text="Disconnect">
        <button className="hangup" onClick={() => voice.leave()}>
          <PhoneOff size={20} />
        </button>
      </Tooltip>
    </div>
  );
}

/** Call strip shown at the top of a DM when a call is active. */
export function DmCallArea({ channel }: { channel: Channel }) {
  const active = useStore((s) => Object.values(s.voiceStates).some((v) => v.channel_id === channel.id));
  const ringing = useStore((s) => s.calls[channel.id]?.ringing.length ?? 0);
  const snap = useVoice();
  const [full, setFull] = useState(false);
  if (!active && snap.channelId !== channel.id) return null;
  return (
    <div className={`call-area${full ? ' full' : ''}`}>
      <button className="icon-btn" style={{ position: 'absolute', top: 8, right: 8, color: '#fff' }} onClick={() => setFull(!full)}>
        <Maximize2 size={18} />
      </button>
      <CallTiles channelId={channel.id} guildId={null} full={full} />
      {ringing > 0 && snap.channelId === channel.id && <div className="call-status">Ringing…</div>}
      <CallControls channelId={channel.id} guildId={null} />
    </div>
  );
}

/** Full view for a guild voice channel. */
export function VoiceChannelView({ channel }: { channel: Channel }) {
  const snap = useVoice();
  const count = useStore((s) => Object.values(s.voiceStates).filter((v) => v.channel_id === channel.id).length);
  return (
    <div className="call-area full" style={{ background: '#000' }}>
      {count === 0 ? (
        <div style={{ textAlign: 'center', color: '#fff' }}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{channel.name}</div>
          <div style={{ color: 'var(--text-secondary)', marginTop: 8 }}>No one is currently in voice</div>
        </div>
      ) : (
        <CallTiles channelId={channel.id} guildId={channel.guild_id} full />
      )}
      <CallControls channelId={channel.id} guildId={channel.guild_id} />
      {snap.channelId === channel.id && snap.ping != null && <div className="call-status">{snap.ping} ms</div>}
    </div>
  );
}

/** Ringing popup for incoming DM calls. */
export function IncomingCall() {
  const me = useStore((s) => s.me);
  const calls = useStore((s) => s.calls);
  const channels = useStore((s) => s.privateChannels);
  const snap = useVoice();
  const entry = Object.entries(calls).find(([cid, c]) => c.ringing.includes(me?.id ?? '') && snap.channelId !== cid);
  if (!entry) return null;
  const [channelId] = entry;
  const ch = channels[channelId];
  if (!ch) return null;
  const caller = ch.recipients?.find((r) => r.id !== me?.id);
  const title = ch.type === ChannelType.GROUP_DM ? ch.name || 'Group Call' : displayName(caller);
  return (
    <div className="incoming-call">
      <div className="ringing-avatar">
        <Avatar user={caller} size={80} decoration={false} />
      </div>
      <div className="ic-name">{title}</div>
      <div className="ic-sub">Incoming Call…</div>
      <div className="ic-actions">
        <Tooltip text="Decline">
          <button style={{ background: 'var(--red)' }} onClick={() => api.post(`/channels/${channelId}/call/stop-ringing`, {})}>
            <PhoneOff size={22} />
          </button>
        </Tooltip>
        <Tooltip text="Join Call">
          <button
            style={{ background: 'var(--green)' }}
            onClick={() => {
              openDm(channelId);
              voice.join(channelId, null);
            }}
          >
            <Phone size={22} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/** Resolution / frame rate / optimisation chips. Changes save to settings and apply live to a running share. */
export function StreamQualityPicker() {
  const st = useStore((s) => s.me?.settings);
  if (!st) return null;
  const set = async (patch: Partial<Pick<UserSettings, 'stream_resolution' | 'stream_fps' | 'stream_optimize'>>) => {
    await updateSettings(patch);
    voice.updateScreenQuality();
  };
  const q = { resolution: st.stream_resolution, fps: st.stream_fps, optimize: st.stream_optimize };
  return (
    <div className="stream-quality">
      <div>
        <div className="label">Resolution</div>
        <div className="chip-row">
          {([720, 1080, 1440, 2160] as const).map((r) => (
            <button key={r} className={`chip${q.resolution === r ? ' active' : ''}`} onClick={() => set({ stream_resolution: r })}>
              {r === 2160 ? '4K' : `${r}p`}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="label">Frame Rate</div>
        <div className="chip-row">
          {([15, 30, 60] as const).map((f) => (
            <button key={f} className={`chip${q.fps === f ? ' active' : ''}`} onClick={() => set({ stream_fps: f })}>
              {f} FPS
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="label">Optimize For</div>
        <div className="chip-row">
          <button className={`chip${q.optimize === 'motion' ? ' active' : ''}`} onClick={() => set({ stream_optimize: 'motion' })}>Smooth motion</button>
          <button className={`chip${q.optimize === 'detail' ? ' active' : ''}`} onClick={() => set({ stream_optimize: 'detail' })}>Sharp text</button>
        </div>
      </div>
      <div className="stream-quality-note">
        Uses up to {(streamBitrate(q) / 1_000_000).toFixed(1)} Mbps upload per viewer. Resolution is capped at your screen's size.
        {q.resolution >= 1440 && q.fps === 60 && ' 1440p/4K at 60 FPS needs a fast connection and CPU.'}
      </div>
    </div>
  );
}

/** Screen/window chooser (Electron desktopCapturer), or quality controls while already live. */
export function ScreenShareModal() {
  const [sources, setSources] = useState<{ id: string; name: string; thumbnail: string }[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [audio, setAudio] = useState(false);
  const snap = useVoice();
  const live = !!snap.screen;
  const browser = !window.native && !!navigator.mediaDevices?.getDisplayMedia;
  useEffect(() => {
    if (live) return;
    if (window.native) window.native.screenSources().then(setSources).catch(() => setSources([]));
    else setSources([]);
  }, [live]);
  return (
    <div className="modal wide" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <h2>{live ? 'Stream Quality' : 'Screen Share'}</h2>
      </div>
      <div className="modal-body scroller thin" style={{ maxHeight: 560 }}>
        {!live && (
          <>
            {sources === null && <div className="empty-state"><div className="spinner" /></div>}
            {sources?.length === 0 && (
              <div className="empty-state">
                {window.native
                  ? "Couldn't list your screens. On Wayland, allow OpenCord in the screen-sharing prompt and try again."
                  : browser
                    ? 'Press Go Live and pick a screen, window or tab in your browser.'
                    : "This browser can't share its screen (most phones can't). Use a desktop browser or the desktop app."}
              </div>
            )}
            <div className="screen-sources">
              {sources?.map((s) => (
                <div key={s.id} className={`screen-source${selected === s.id ? ' selected' : ''}`} onClick={() => setSelected(s.id)}>
                  <img src={s.thumbnail} alt="" />
                  {s.name}
                </div>
              ))}
            </div>
          </>
        )}
        <StreamQualityPicker />
      </div>
      <div className="modal-footer">
        {!live && (
          <label className="left" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <div className={`switch${audio ? ' on' : ''}`} onClick={() => setAudio(!audio)} /> Include audio
          </label>
        )}
        {live ? (
          <>
            <button className="btn danger left" onClick={() => (voice.stopScreenShare(), closeModal())}>Stop Streaming</button>
            <button className="btn" onClick={closeModal}>Done</button>
          </>
        ) : (
          <>
            <button className="btn link" onClick={closeModal}>Cancel</button>
            <button
              className="btn"
              disabled={!selected && !browser}
              onClick={() => {
                if (browser) voice.startDisplayShare(audio);
                else voice.startScreenShare(selected!, audio);
                closeModal();
              }}
            >
              Go Live
            </button>
          </>
        )}
      </div>
    </div>
  );
}
