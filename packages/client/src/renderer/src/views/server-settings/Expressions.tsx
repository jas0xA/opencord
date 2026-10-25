import { useState } from 'react';
import { Play, Trash2, Upload } from 'lucide-react';
import { Permissions, type GuildFull } from '@opencord/shared';
import { api, cdn, fileToDataUrl, pickFile } from '../../lib/api';
import { can, toast } from '../../lib/store';
import { Section } from './ServerSettings';

function useUpload() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      toast(e.errors && Object.keys(e.errors).length ? Object.values(e.errors).join(', ') : e.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function EmojiSettings({ guild }: { guild: GuildFull }) {
  const { busy, run } = useUpload();
  const manage = can(Permissions.MANAGE_EXPRESSIONS, guild.id);
  const upload = () =>
    run(async () => {
      const files = await pickFile('image/png,image/gif,image/jpeg,image/webp', true);
      for (const f of files) {
        const name = f.name.replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_').slice(0, 32).padEnd(2, '_');
        await api.post(`/guilds/${guild.id}/emojis`, { name, image: await fileToDataUrl(f) });
      }
    });
  return (
    <div className="settings-page">
      <div className="settings-main wide">
        <h2 className="page-title">Emoji</h2>
        <p className="page-subtitle">Add up to 250 custom emoji that anyone can use in this server. Animated GIF emoji may be used by everyone too — it's all free.</p>
        <div className="info-box">
          <div>
            <b>Upload requirements</b>
            <div>File type: JPEG, PNG, GIF, WEBP · Max size: 512 KB · Recommended: 128×128 · Naming: at least 2 characters, alphanumeric and underscores only</div>
          </div>
        </div>
        {manage && <button className="btn" disabled={busy} onClick={upload}><Upload size={16} /> Upload Emoji</button>}
        <Section title={`Emoji — ${250 - guild.emojis.length} slots available`}>
          {guild.emojis.length === 0 ? (
            <div className="empty-state">No emoji yet.</div>
          ) : (
            <div className="list-card">
              {guild.emojis.map((e) => (
                <div key={e.id} className="list-row">
                  <img src={cdn(e.url)!} width={32} height={32} style={{ objectFit: 'contain' }} alt="" />
                  <input
                    className="input"
                    style={{ width: 220, height: 32 }}
                    defaultValue={e.name}
                    disabled={!manage}
                    onBlur={(ev) => ev.target.value !== e.name && api.patch(`/guilds/${guild.id}/emojis/${e.id}`, { name: ev.target.value }).catch((er) => toast(er.message))}
                  />
                  <div className="lr-main lr-sub">:{e.name}:</div>
                  {manage && <button className="icon-btn danger" onClick={() => api.del(`/guilds/${guild.id}/emojis/${e.id}`)}><Trash2 size={18} /></button>}
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

export function StickerSettings({ guild }: { guild: GuildFull }) {
  const { busy, run } = useUpload();
  const manage = can(Permissions.MANAGE_EXPRESSIONS, guild.id);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [image, setImage] = useState<string | null>(null);
  return (
    <div className="settings-page">
      <div className="settings-main wide">
        <h2 className="page-title">Stickers</h2>
        <p className="page-subtitle">Upload stickers for everyone in this server to use. 60 slots, all free.</p>
        {manage && (
          <div className="us-card">
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div
                className="upload-circle"
                style={{ borderRadius: 8, width: 120, height: 120, margin: 0 }}
                onClick={async () => {
                  const [f] = await pickFile('image/png,image/apng,image/gif,image/webp');
                  if (f) setImage(await fileToDataUrl(f));
                }}
              >
                {image ? <img src={image} alt="" style={{ objectFit: 'contain' }} /> : <div className="uc-label">Upload<br />320×320</div>}
              </div>
              <div style={{ flex: 1 }}>
                <label className="label">Sticker name</label>
                <input className="input" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
                <label className="label" style={{ marginTop: 12 }}>Description</label>
                <input className="input" value={desc} maxLength={100} onChange={(e) => setDesc(e.target.value)} />
                <button
                  className="btn"
                  style={{ marginTop: 12 }}
                  disabled={busy || !image || name.length < 2}
                  onClick={() =>
                    run(async () => {
                      await api.post(`/guilds/${guild.id}/stickers`, { name, description: desc, image });
                      setName('');
                      setDesc('');
                      setImage(null);
                    })
                  }
                >
                  Upload Sticker
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="expr-grid">
          {guild.stickers.map((s) => (
            <div key={s.id} className="expr-tile">
              <img src={cdn(s.url)!} alt="" style={{ width: 96, height: 96 }} />
              <b>{s.name}</b>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{s.description}</span>
              {manage && <button className="et-del" onClick={() => api.del(`/guilds/${guild.id}/stickers/${s.id}`)}><Trash2 size={16} /></button>}
            </div>
          ))}
        </div>
        {guild.stickers.length === 0 && <div className="empty-state">No stickers yet.</div>}
      </div>
    </div>
  );
}

export function SoundboardSettings({ guild }: { guild: GuildFull }) {
  const { busy, run } = useUpload();
  const manage = can(Permissions.MANAGE_EXPRESSIONS, guild.id);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [volume, setVolume] = useState(100);
  const [sound, setSound] = useState<{ data: string; file: string } | null>(null);
  return (
    <div className="settings-page">
      <div className="settings-main wide">
        <h2 className="page-title">Soundboard</h2>
        <p className="page-subtitle">Upload short sounds (MP3/OGG/WAV, max 512 KB) that members can play in voice channels.</p>
        {manage && (
          <div className="us-card">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label className="label">Sound</label>
                <button
                  className="btn secondary full"
                  onClick={async () => {
                    const [f] = await pickFile('audio/mpeg,audio/ogg,audio/wav');
                    if (f) setSound({ data: await fileToDataUrl(f), file: f.name });
                  }}
                >
                  {sound ? sound.file : 'Choose file'}
                </button>
              </div>
              <div>
                <label className="label">Name</label>
                <input className="input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <label className="label">Emoji</label>
                <input className="input" value={emoji} maxLength={8} onChange={(e) => setEmoji(e.target.value)} placeholder="🔊" />
              </div>
              <div>
                <label className="label">Volume — {volume}%</label>
                <input type="range" min={0} max={100} value={volume} onChange={(e) => setVolume(+e.target.value)} style={{ width: '100%' }} />
              </div>
            </div>
            <button
              className="btn"
              style={{ marginTop: 12 }}
              disabled={busy || !sound || name.length < 2}
              onClick={() =>
                run(async () => {
                  await api.post(`/guilds/${guild.id}/soundboard-sounds`, { name, emoji: emoji || null, volume: volume / 100, sound: sound!.data });
                  setName('');
                  setEmoji('');
                  setSound(null);
                })
              }
            >
              Upload Sound
            </button>
          </div>
        )}
        <div className="list-card">
          {guild.sounds.map((s) => (
            <div key={s.id} className="list-row">
              <button className="icon-btn" onClick={() => { const a = new Audio(cdn(s.url)!); a.volume = s.volume; a.play(); }}><Play size={18} /></button>
              <span style={{ fontSize: 20 }}>{s.emoji}</span>
              <div className="lr-main"><div className="lr-title">{s.name}</div><div className="lr-sub">{Math.round(s.volume * 100)}% volume</div></div>
              {manage && <button className="icon-btn danger" onClick={() => api.del(`/guilds/${guild.id}/soundboard-sounds/${s.id}`)}><Trash2 size={18} /></button>}
            </div>
          ))}
          {guild.sounds.length === 0 && <div className="empty-state">No sounds yet.</div>}
        </div>
      </div>
    </div>
  );
}
