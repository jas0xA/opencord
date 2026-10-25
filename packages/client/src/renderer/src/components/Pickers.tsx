import { useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { Emoji } from '@opencord/shared';
import { api, cdn } from '../lib/api';
import { EMOJI_CATEGORIES, searchEmoji } from '../lib/emoji';
import { toast, useStore } from '../lib/store';
import { GuildIcon } from './GuildRail';

export type PickedEmoji = { unicode: string } | { custom: Emoji };

const RECENT_KEY = 'opencord.recentEmoji';
function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function pushRecent(e: string) {
  localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recent().filter((x) => x !== e)].slice(0, 18)));
}

export function EmojiPicker({ onPick }: { onPick: (e: PickedEmoji) => void }) {
  const [q, setQ] = useState('');
  const [hover, setHover] = useState<string>('');
  const guilds = useStore((s) => s.guilds);
  const guildOrder = useStore((s) => s.guildOrder);
  const scrollRef = useRef<HTMLDivElement>(null);
  const withEmoji = guildOrder.map((id) => guilds[id]).filter((g) => g?.emojis.length);
  const pick = (e: PickedEmoji) => {
    pushRecent('unicode' in e ? e.unicode : `<:${e.custom.name}:${e.custom.id}>`);
    onPick(e);
  };
  const recents = recent();
  const allCustom = useMemo(() => withEmoji.flatMap((g) => g.emojis), [withEmoji]);

  const jump = (id: string) => {
    const el = scrollRef.current?.querySelector(`[data-cat="${id}"]`) as HTMLElement | null;
    if (el && scrollRef.current) scrollRef.current.scrollTop = el.offsetTop - 4;
  };

  const results = q ? searchEmoji(q, 63) : null;
  const customResults = q ? allCustom.filter((e) => e.name.toLowerCase().includes(q.toLowerCase())) : null;

  return (
    <div className="emoji-picker">
      <div className="ep-head">
        <div className="search-box" style={{ width: '100%', height: 32, margin: 0 }}>
          <input autoFocus placeholder="Find the perfect emoji" value={q} onChange={(e) => setQ(e.target.value)} />
          <Search size={16} />
        </div>
      </div>
      <div className="ep-body">
        {!q && (
          <div className="ep-cats scroller none">
            {recents.length > 0 && <button onClick={() => jump('recent')}>🕘</button>}
            {withEmoji.map((g) => (
              <button key={g.id} onClick={() => jump(g.id)}>
                <GuildIcon guild={g} size={24} radius={6} />
              </button>
            ))}
            {EMOJI_CATEGORIES.map((c) => (
              <button key={c.id} onClick={() => jump(c.id)}>{c.icon}</button>
            ))}
          </div>
        )}
        <div className="ep-grid scroller thin" ref={scrollRef} style={{ position: 'relative' }}>
          {results && (
            <>
              <div className="ep-cells" style={{ paddingTop: 8 }}>
                {customResults!.map((e) => (
                  <button key={e.id} onMouseEnter={() => setHover(`:${e.name}:`)} onClick={() => pick({ custom: e })}>
                    <img src={cdn(e.url)!} alt={e.name} />
                  </button>
                ))}
                {results.map(([n, e]) => (
                  <button key={n} onMouseEnter={() => setHover(`:${n}:`)} onClick={() => pick({ unicode: e })}>{e}</button>
                ))}
              </div>
              {!results.length && !customResults!.length && <div className="empty-state">No emoji match "{q}"</div>}
            </>
          )}
          {!results && (
            <>
              {recents.length > 0 && (
                <div data-cat="recent">
                  <div className="ep-cat-title">Frequently Used</div>
                  <div className="ep-cells">
                    {recents.map((r) => {
                      const m = /^<:(\w+):(\d+)>$/.exec(r);
                      const custom = m ? allCustom.find((e) => e.id === m[2]) : null;
                      if (m && !custom) return null;
                      return (
                        <button key={r} onClick={() => pick(custom ? { custom } : { unicode: r })}>
                          {custom ? <img src={cdn(custom.url)!} alt="" /> : r}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {withEmoji.map((g) => (
                <div key={g.id} data-cat={g.id}>
                  <div className="ep-cat-title">{g.name}</div>
                  <div className="ep-cells">
                    {g.emojis.map((e) => (
                      <button key={e.id} onMouseEnter={() => setHover(`:${e.name}:`)} onClick={() => pick({ custom: e })}>
                        <img src={cdn(e.url)!} alt={e.name} />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {EMOJI_CATEGORIES.map((c) => (
                <div key={c.id} data-cat={c.id}>
                  <div className="ep-cat-title">{c.label}</div>
                  <div className="ep-cells">
                    {c.emojis.map(([n, e]) => (
                      <button key={n} onMouseEnter={() => setHover(`:${n}:`)} onClick={() => pick({ unicode: e })}>{e}</button>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      <div className="ep-foot">{hover || 'Pick an emoji'}</div>
    </div>
  );
}

export function StickerPicker({ onPick }: { onPick: (id: string) => void }) {
  const guilds = useStore((s) => s.guilds);
  const guildOrder = useStore((s) => s.guildOrder);
  const list = guildOrder.map((id) => guilds[id]).filter((g) => g?.stickers.length);
  return (
    <div className="emoji-picker sticker-picker">
      <div className="ep-grid scroller thin">
        {list.length === 0 && <div className="empty-state">No stickers yet. Server admins can upload stickers in Server Settings → Stickers.</div>}
        {list.map((g) => (
          <div key={g.id}>
            <div className="ep-cat-title">{g.name}</div>
            <div className="ep-cells">
              {g.stickers.map((s) => (
                <button key={s.id} title={s.name} onClick={() => onPick(s.id)}>
                  <img src={cdn(s.url)!} alt={s.name} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Soundboard({ guildId }: { guildId: string }) {
  const sounds = useStore((s) => s.guilds[guildId]?.sounds ?? null);
  return (
    <div style={{ width: 360, padding: 12 }}>
      <div className="ep-cat-title" style={{ position: 'static', background: 'none' }}>Soundboard</div>
      {!sounds?.length && <div className="empty-state" style={{ padding: 16 }}>No sounds in this server yet.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {sounds?.map((s) => (
          <button
            key={s.id}
            className="chip"
            style={{ borderRadius: 8, height: 40, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center', overflow: 'hidden' }}
            onClick={() => api.post(`/guilds/${guildId}/soundboard-sounds/${s.id}/play`).catch((e) => toast(e.message))}
          >
            {s.emoji && <span>{s.emoji}</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
