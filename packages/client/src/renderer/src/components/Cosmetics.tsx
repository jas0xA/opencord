// Rendering of marketplace cosmetics. Official items use "builtin:" assets drawn with SVG/CSS;
// community items are images uploaded to the server.
import { useEffect, useMemo, type CSSProperties } from 'react';
import type { MarketplaceItem, PublicUser } from '@opencord/shared';
import { api, cdn } from '../lib/api';
import { cropBgStyle, parseCrop, stripCrop } from '../lib/crop';
import { useStore } from '../lib/store';

const pending = new Set<string>();

/** Returns the marketplace item for an id, fetching it once if it isn't cached. */
export function useItem(id: string | null | undefined): MarketplaceItem | null {
  const item = useStore((s) => (id ? s.marketplace[id] : undefined));
  useEffect(() => {
    if (!id || item || pending.has(id)) return;
    pending.add(id);
    api
      .get<MarketplaceItem>(`/marketplace/items/${id}`)
      .then((it) => useStore.setState((s) => ({ marketplace: { ...s.marketplace, [it.id]: it } })))
      .catch(() => {})
      .finally(() => pending.delete(id));
  }, [id, item]);
  return item ?? null;
}

/* ───────────── avatar decorations ───────────── */

function BuiltinDecoration({ kind }: { kind: string }) {
  const common = { width: '100%', height: '100%', viewBox: '0 0 120 120', style: { overflow: 'visible' } as CSSProperties };
  switch (kind) {
    case 'deco/neon-ring':
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="neon" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#00f0ff" />
              <stop offset="1" stopColor="#ff2fd6" />
            </linearGradient>
            <filter id="neon-glow">
              <feGaussianBlur stdDeviation="2.5" />
            </filter>
          </defs>
          <circle cx="60" cy="60" r="52" fill="none" stroke="url(#neon)" strokeWidth="6" filter="url(#neon-glow)" style={{ animation: 'pulse-glow 2s infinite' }} />
          <circle cx="60" cy="60" r="52" fill="none" stroke="url(#neon)" strokeWidth="3" />
        </svg>
      );
    case 'deco/cat-ears':
      return (
        <svg {...common}>
          <path d="M22 38 18 4l30 18Z" fill="#2b2b33" stroke="#fff" strokeWidth="2" />
          <path d="M26 30 24 12l15 10Z" fill="#ff9fc8" />
          <path d="M98 38l4-34-30 18Z" fill="#2b2b33" stroke="#fff" strokeWidth="2" />
          <path d="M94 30l2-18-15 10Z" fill="#ff9fc8" />
        </svg>
      );
    case 'deco/flame':
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="flame" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stopColor="#ff3d00" />
              <stop offset=".6" stopColor="#ffb300" />
              <stop offset="1" stopColor="#fff176" />
            </linearGradient>
          </defs>
          <g style={{ transformOrigin: '60px 60px', animation: 'flicker .6s ease-in-out infinite' }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <path key={i} d="M60 2c6 8 8 12 4 18-2-3-4-4-4-4s-2 2-4 4c-4-6-2-10 4-18Z" fill="url(#flame)" transform={`rotate(${i * 30} 60 60)`} />
            ))}
          </g>
          <circle cx="60" cy="60" r="51" fill="none" stroke="#ff6d00" strokeWidth="3" />
        </svg>
      );
    case 'deco/sakura':
      return (
        <svg {...common}>
          {[[18, 30, 0], [100, 22, 40], [104, 90, 80], [16, 96, 120], [60, 4, 160], [62, 114, 200]].map(([x, y, r], i) => (
            <g key={i} transform={`translate(${x} ${y}) rotate(${r})`}>
              {[0, 72, 144, 216, 288].map((a) => (
                <ellipse key={a} cx="0" cy="-6" rx="4" ry="7" fill="#ffc1dc" stroke="#ff8fbf" strokeWidth=".8" transform={`rotate(${a})`} />
              ))}
              <circle r="2.5" fill="#ffe066" />
            </g>
          ))}
        </svg>
      );
    case 'deco/pixel':
      return (
        <svg {...common} shapeRendering="crispEdges">
          {Array.from({ length: 28 }).map((_, i) => {
            const a = (i / 28) * Math.PI * 2;
            const x = 60 + Math.cos(a) * 54 - 4;
            const y = 60 + Math.sin(a) * 54 - 4;
            return <rect key={i} x={x} y={y} width="8" height="8" fill={i % 2 ? '#4ade80' : '#22c55e'} />;
          })}
        </svg>
      );
    case 'deco/halo':
      return (
        <svg {...common}>
          <ellipse cx="60" cy="6" rx="30" ry="7" fill="none" stroke="#ffd54f" strokeWidth="5" style={{ animation: 'pulse-glow 2s infinite' }} />
          <circle cx="60" cy="60" r="52" fill="none" stroke="#ffe08266" strokeWidth="3" />
        </svg>
      );
    case 'deco/headphones':
      return (
        <svg {...common}>
          <path d="M14 70V58a46 46 0 0 1 92 0v12" fill="none" stroke="#32323a" strokeWidth="8" strokeLinecap="round" />
          <rect x="4" y="62" width="18" height="32" rx="8" fill="#5865f2" />
          <rect x="98" y="62" width="18" height="32" rx="8" fill="#5865f2" />
        </svg>
      );
    case 'deco/rainbow':
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="rb" x1="0" y1="0" x2="1" y2="0">
              {['#ff004c', '#ff9a00', '#ffe600', '#2bff00', '#00c3ff', '#8a2bff'].map((c, i) => (
                <stop key={c} offset={i / 5} stopColor={c} />
              ))}
            </linearGradient>
          </defs>
          <g style={{ transformOrigin: '60px 60px', animation: 'orbit 4s linear infinite' }}>
            <circle cx="60" cy="60" r="53" fill="none" stroke="url(#rb)" strokeWidth="5" strokeDasharray="40 12" />
          </g>
        </svg>
      );
    default:
      return null;
  }
}

export function Decoration({ id }: { id: string | null | undefined }) {
  const item = useItem(id);
  if (!item) return null;
  return (
    <div className="decoration">
      {item.asset.startsWith('builtin:') ? (
        <BuiltinDecoration kind={item.asset.slice(8)} />
      ) : (
        <img src={cdn(item.asset)!} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      )}
    </div>
  );
}

/* ───────────── profile effects ───────────── */

function particles(kind: string) {
  const n = kind === 'matrix' ? 18 : 22;
  return Array.from({ length: n }, (_, i) => {
    const left = (i * 97) % 100;
    const delay = -((i * 1.37) % 6);
    const dur = 4 + ((i * 7) % 5);
    switch (kind) {
      case 'snow':
        return <i key={i} style={{ left: `${left}%`, width: 3 + (i % 3) * 2, height: 3 + (i % 3) * 2, borderRadius: '50%', background: '#fff', opacity: 0.85, animationDuration: `${dur}s`, animationDelay: `${delay}s` }} />;
      case 'hearts':
        return <i key={i} style={{ left: `${left}%`, top: 'auto', bottom: -20, fontSize: 10 + (i % 3) * 4, color: '#ff5fa2', animationName: 'rise', animationDuration: `${dur}s`, animationDelay: `${delay}s`, fontStyle: 'normal' }}>♥</i>;
      case 'bubbles':
        return <i key={i} style={{ left: `${left}%`, top: 'auto', bottom: -20, width: 6 + (i % 4) * 4, height: 6 + (i % 4) * 4, borderRadius: '50%', border: '1px solid #9be7ff', background: '#9be7ff22', animationName: 'rise', animationDuration: `${dur}s`, animationDelay: `${delay}s` }} />;
      case 'sparkles':
        return <i key={i} style={{ left: `${left}%`, top: `${(i * 53) % 90}%`, fontSize: 8 + (i % 3) * 5, color: '#ffe680', animationName: 'twinkle', animationDuration: `${1.5 + (i % 4) * 0.5}s`, animationDelay: `${delay}s`, fontStyle: 'normal' }}>✦</i>;
      case 'matrix':
        return <i key={i} style={{ left: `${left}%`, color: '#00ff66', fontFamily: 'monospace', fontSize: 11, lineHeight: '11px', width: 8, wordBreak: 'break-all', textShadow: '0 0 4px #00ff66', opacity: 0.8, animationDuration: `${dur}s`, animationDelay: `${delay}s`, fontStyle: 'normal' }}>{'01ﾊﾐﾋｰｳ10'.slice(i % 4, (i % 4) + 5)}</i>;
      default:
        return null;
    }
  });
}

export function ProfileEffect({ id }: { id: string | null | undefined }) {
  const item = useItem(id);
  const nodes = useMemo(() => (item?.asset.startsWith('builtin:effect/') ? particles(item.asset.slice(15)) : null), [item?.asset]);
  if (!item) return null;
  return (
    <div className="effect-layer">
      {nodes ?? <img src={cdn(item.asset)!} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
    </div>
  );
}

/* ───────────── nameplates, banners, themes ───────────── */

export function nameplateStyle(item: MarketplaceItem | null): CSSProperties | null {
  if (!item) return null;
  if (item.asset.startsWith('builtin:') && item.colors) return { background: `linear-gradient(90deg, ${item.colors.join(', ')})` };
  if (item.colors?.length && item.asset === 'builtin:gradient') return { background: `linear-gradient(90deg, ${item.colors.join(', ')})` };
  return { backgroundImage: `url(${cdn(item.asset)})`, backgroundSize: 'cover', backgroundPosition: 'center' };
}

export function Nameplate({ id }: { id: string | null | undefined }) {
  const item = useItem(id);
  const style = nameplateStyle(item);
  if (!style) return null;
  return <div className="nameplate-bg" style={style} />;
}

const BUILTIN_BANNERS: Record<string, string> = {
  'banner/mountains':
    'linear-gradient(180deg, transparent 55%, #1b2735 55.5%), linear-gradient(160deg, transparent 50%, #2c3e50 50.5%), linear-gradient(200deg, transparent 45%, #34495e 45.5%), linear-gradient(180deg, #fd746c, #ff9068)',
  'banner/synthwave':
    'repeating-linear-gradient(90deg, transparent 0 28px, #ff2fd655 28px 30px), linear-gradient(180deg, #2b1055 0%, #7597de 45%, #d53369 46%, #1a0533 47%, #2b1055 100%)',
  'banner/forest': 'linear-gradient(180deg, #e8f5e9 0%, #a5d6a7 30%, #134e5e 70%, #0b2b26 100%)',
  'banner/waves':
    'radial-gradient(ellipse 60% 30% at 20% 100%, #ffffff55, transparent), radial-gradient(ellipse 60% 30% at 80% 90%, #ffffff33, transparent), linear-gradient(180deg, #2193b0, #6dd5ed)',
};

/** CSS background for a user's banner (uploaded image, marketplace banner or banner color). */
export function useBannerStyle(user: PublicUser | null | undefined, fallback?: string): CSSProperties {
  const marketId = user?.banner?.startsWith('market:') ? user.banner.slice(7) : null;
  const item = useItem(marketId);
  if (!user) return { background: fallback ?? 'var(--brand)' };
  if (marketId) {
    if (!item) return { background: '#2b2d31' };
    if (item.asset.startsWith('builtin:')) return { background: BUILTIN_BANNERS[item.asset.slice(8)] ?? `linear-gradient(135deg, ${(item.colors ?? ['#5865f2', '#eb459e']).join(', ')})` };
    if (item.asset === 'builtin:gradient') return { background: `linear-gradient(135deg, ${(item.colors ?? []).join(', ')})` };
    return { backgroundImage: `url(${cdn(item.asset)})`, backgroundSize: 'cover', backgroundPosition: 'center' };
  }
  if (user.banner) return cropBgStyle(stripCrop(cdn(user.banner)!), parseCrop(user.banner));
  return { background: user.banner_color ?? fallback ?? user.accent_color ?? '#5865f2' };
}

export function MarketplacePreview({ item, size = 96 }: { item: MarketplaceItem; size?: number }) {
  const me = useStore((s) => s.me);
  switch (item.category) {
    case 'avatar_decoration':
      return (
        <div className="avatar" style={{ width: size, height: size }}>
          <div className="av-default" style={{ background: '#5865f2' }}>
            <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 32 32" fill="#fff"><circle cx="16" cy="12" r="6" /><path d="M5 28c0-6 5-9 11-9s11 3 11 9" /></svg>
          </div>
          <div className="decoration">
            {item.asset.startsWith('builtin:') ? <BuiltinDecoration kind={item.asset.slice(8)} /> : <img src={cdn(item.asset)!} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
          </div>
        </div>
      );
    case 'profile_effect':
      return (
        <div style={{ position: 'absolute', inset: 0 }}>
          <div className="effect-layer">
            {item.asset.startsWith('builtin:effect/') ? particles(item.asset.slice(15)) : <img src={cdn(item.asset)!} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
          </div>
        </div>
      );
    case 'nameplate':
      return (
        <div style={{ width: '85%', height: 44, borderRadius: 8, position: 'relative', overflow: 'hidden', background: '#1a1a1e', display: 'flex', alignItems: 'center', padding: '0 12px', gap: 10 }}>
          <div className="nameplate-bg" style={{ ...nameplateStyle(item)!, opacity: 0.8 }} />
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#5865f2', zIndex: 1 }} />
          <span style={{ zIndex: 1, fontWeight: 600, color: '#fff' }}>{me?.display_name ?? me?.username ?? 'you'}</span>
        </div>
      );
    case 'banner': {
      const bg = item.asset.startsWith('builtin:') && item.asset !== 'builtin:gradient'
        ? { background: BUILTIN_BANNERS[item.asset.slice(8)] }
        : item.asset === 'builtin:gradient'
          ? { background: `linear-gradient(135deg, ${(item.colors ?? []).join(', ')})` }
          : { backgroundImage: `url(${cdn(item.asset)})`, backgroundSize: 'cover', backgroundPosition: 'center' };
      return <div style={{ position: 'absolute', inset: 0, ...bg }} />;
    }
    case 'profile_theme':
      return (
        <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(180deg, ${(item.colors ?? ['#333', '#111']).join(', ')})`, display: 'grid', placeItems: 'center' }}>
          <div style={{ width: '70%', height: '70%', borderRadius: 8, background: 'rgba(0,0,0,.35)', border: '1px solid rgba(255,255,255,.15)' }} />
        </div>
      );
  }
}

/** Display name with the user's chosen font/effect/colors. */
export function StyledName({ user, children, className, style }: { user: PublicUser | null | undefined; children: React.ReactNode; className?: string; style?: CSSProperties }) {
  const ds = user?.display_name_style;
  if (!ds) return <span className={className} style={style}>{children}</span>;
  const fonts: Record<string, string> = {
    default: 'inherit',
    serif: "Georgia, 'Times New Roman', serif",
    mono: 'var(--font-code)',
    rounded: "'Comic Sans MS', 'Chalkboard SE', cursive",
    tall: "Impact, 'Arial Narrow', sans-serif",
    script: "'Brush Script MT', cursive",
  };
  const s: CSSProperties = { ...style, fontFamily: fonts[ds.font] ?? 'inherit' };
  let cls = className ?? '';
  if (ds.effect === 'gradient' && ds.colors.length >= 2) {
    s.backgroundImage = `linear-gradient(90deg, ${ds.colors.join(', ')})`;
    cls += ' name-style-gradient';
  } else if (ds.colors[0]) s.color = ds.colors[0];
  if (ds.effect === 'glow') cls += ' name-style-glow';
  if (ds.effect === 'neon') cls += ' name-style-neon';
  return <span className={cls} style={s}>{children}</span>;
}
