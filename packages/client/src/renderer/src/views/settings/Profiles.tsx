import { useEffect, useMemo, useState } from 'react';
import { Ban } from 'lucide-react';
import type { MarketplaceCategory, MarketplaceItem, PublicUser } from '@opencord/shared';
import { api, cdn } from '../../lib/api';
import { cropImage, pickAndCropImage } from '../../lib/crop';
import { navigate, toast, useStore } from '../../lib/store';
import { MarketplacePreview } from '../../components/Cosmetics';
import { UserPopout } from '../../components/Profile';
import { SaveBar } from '../server-settings/ServerSettings';

const FONTS = [['default', 'Default'], ['serif', 'Serif'], ['mono', 'Mono'], ['rounded', 'Playful'], ['tall', 'Bold'], ['script', 'Script']];
const EFFECTS = [['solid', 'Solid'], ['gradient', 'Gradient'], ['glow', 'Glow'], ['neon', 'Neon']];

function useOwned(category: MarketplaceCategory) {
  const inventory = useStore((s) => s.me?.inventory ?? []);
  const marketplace = useStore((s) => s.marketplace);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    api
      .get<{ items: MarketplaceItem[] }>(`/marketplace/items?tab=owned&category=${category}`)
      .then((r) => useStore.setState((s) => ({ marketplace: { ...s.marketplace, ...Object.fromEntries(r.items.map((i) => [i.id, i])) } })))
      .finally(() => setLoaded(true));
  }, [category, inventory.length]);
  return { loaded, items: inventory.map((id) => marketplace[id]).filter((i) => i?.category === category) };
}

function CosmeticPicker({ category, value, onChange }: { category: MarketplaceCategory; value: string | null; onChange: (id: string | null) => void }) {
  const { items, loaded } = useOwned(category);
  return (
    <div className="cosmetic-grid">
      <div className={`cosmetic-tile${!value ? ' selected' : ''}`} onClick={() => onChange(null)}>
        <Ban size={28} />
      </div>
      {items.map((it) => (
        <div key={it.id} className={`cosmetic-tile${value === it.id ? ' selected' : ''}`} title={it.name} onClick={() => onChange(it.id)}>
          <div style={{ transform: 'scale(0.55)', display: 'grid', placeItems: 'center', position: 'absolute', inset: 0 }}>
            <MarketplacePreview item={it} size={96} />
          </div>
        </div>
      ))}
      <div className="cosmetic-tile" onClick={() => (useStore.setState({ settings: null }), navigate({ kind: 'home', view: 'marketplace' }))}>
        {loaded ? 'Get more' : '…'}
      </div>
    </div>
  );
}

export function ProfilesPage() {
  const me = useStore((s) => s.me)!;
  const initial = useMemo(
    () => ({
      display_name: me.display_name ?? '',
      pronouns: me.pronouns,
      bio: me.bio,
      banner_color: me.banner_color ?? '#e44d10',
      accent_color: me.accent_color,
      theme_colors: me.theme_colors,
      avatar_decoration: me.avatar_decoration,
      profile_effect: me.profile_effect,
      nameplate: me.nameplate,
      display_name_style: me.display_name_style ?? { font: 'default', effect: 'solid', colors: ['#ffffff', '#5865f2'] },
      banner_market: me.banner?.startsWith('market:') ? me.banner : null,
    }),
    [me],
  );
  const [d, setD] = useState(initial);
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [banner, setBanner] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => setD(initial), [initial]);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial) || avatar !== undefined || banner !== undefined;

  // Live preview user.
  const preview: PublicUser = {
    ...me,
    display_name: d.display_name || null,
    pronouns: d.pronouns,
    bio: d.bio,
    banner_color: d.banner_color,
    theme_colors: d.theme_colors,
    avatar_decoration: d.avatar_decoration,
    profile_effect: d.profile_effect,
    nameplate: d.nameplate,
    display_name_style: d.display_name_style.font === 'default' && d.display_name_style.effect === 'solid' ? null : d.display_name_style,
    avatar: avatar === undefined ? me.avatar : avatar,
    banner: banner === undefined ? (d.banner_market ?? me.banner) : banner,
  };

  const save = async () => {
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {};
      for (const k of ['display_name', 'pronouns', 'bio', 'banner_color', 'avatar_decoration', 'profile_effect', 'nameplate'] as const) {
        if (d[k] !== initial[k]) patch[k] = d[k] === '' && k === 'display_name' ? null : d[k];
      }
      if (JSON.stringify(d.theme_colors) !== JSON.stringify(initial.theme_colors)) patch.theme_colors = d.theme_colors;
      if (JSON.stringify(d.display_name_style) !== JSON.stringify(initial.display_name_style)) patch.display_name_style = preview.display_name_style;
      if (avatar !== undefined) patch.avatar = avatar;
      if (banner !== undefined) patch.banner = banner;
      else if (d.banner_market !== initial.banner_market) patch.banner = d.banner_market;
      await api.patch('/users/@me', patch);
      setAvatar(undefined);
      setBanner(undefined);
    } catch (e: any) {
      toast(Object.values(e.errors ?? {})[0] as string ?? e.message);
    } finally {
      setBusy(false);
    }
  };

  const style = d.display_name_style;
  return (
    <div className="us-page" style={{ width: 960 }}>
      <div className="profile-editor">
        <div className="pe-form">
          <div className="form-row">
            <label className="label">Display Name</label>
            <input className="input" maxLength={32} placeholder={me.username} value={d.display_name} onChange={(e) => setD({ ...d, display_name: e.target.value })} />
          </div>
          <div className="form-row">
            <label className="label">Display Name Style</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              {FONTS.map(([v, l]) => (
                <button key={v} className={`chip${style.font === v ? ' active' : ''}`} onClick={() => setD({ ...d, display_name_style: { ...style, font: v } })}>{l}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {EFFECTS.map(([v, l]) => (
                <button key={v} className={`chip${style.effect === v ? ' active' : ''}`} onClick={() => setD({ ...d, display_name_style: { ...style, effect: v } })}>{l}</button>
              ))}
              {style.colors.map((c, i) => (
                <input key={i} type="color" value={c} onChange={(e) => setD({ ...d, display_name_style: { ...style, colors: style.colors.map((x, j) => (j === i ? e.target.value : x)) } })} style={{ width: 36, height: 32, border: 0, background: 'none' }} />
              ))}
            </div>
          </div>
          <div className="form-row">
            <label className="label">Pronouns</label>
            <input className="input" maxLength={40} placeholder="Add your pronouns" value={d.pronouns} onChange={(e) => setD({ ...d, pronouns: e.target.value })} />
          </div>
          <div className="section-sep" style={{ margin: '24px 0' }} />
          <div className="form-row">
            <label className="label">Avatar</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn sm" onClick={async () => { const v = await pickAndCropImage('circle'); if (v) setAvatar(v); }}>Change Avatar</button>
              {(avatar ?? me.avatar) && (
                <button className="btn sm secondary" onClick={async () => { const v = await cropImage(cdn(avatar ?? me.avatar)!, 'circle'); if (v) setAvatar(v.startsWith('data:') ? v : (me.avatar ?? '').replace(/#.*$/, '') + v.slice(v.indexOf('#'))); }}>Crop / Reposition</button>
              )}
              {(avatar ?? me.avatar) && <button className="btn sm link" onClick={() => setAvatar(null)}>Remove Avatar</button>}
            </div>
          </div>
          <div className="form-row">
            <label className="label">Avatar Decoration</label>
            <CosmeticPicker category="avatar_decoration" value={d.avatar_decoration} onChange={(v) => setD({ ...d, avatar_decoration: v })} />
          </div>
          <div className="form-row">
            <label className="label">Profile Effect</label>
            <CosmeticPicker category="profile_effect" value={d.profile_effect} onChange={(v) => setD({ ...d, profile_effect: v })} />
          </div>
          <div className="form-row">
            <label className="label">Nameplate</label>
            <CosmeticPicker category="nameplate" value={d.nameplate} onChange={(v) => setD({ ...d, nameplate: v })} />
          </div>
          <div className="section-sep" style={{ margin: '24px 0' }} />
          <div className="form-row">
            <label className="label">Profile Banner</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={async () => { const v = await pickAndCropImage('banner'); if (v) setBanner(v); }}>Upload Banner</button>
              {(banner ?? me.banner) && !(banner ?? me.banner)!.startsWith('market:') && !(banner === undefined && d.banner_market) && (
                <button className="btn sm secondary" onClick={async () => { const cur = (banner ?? me.banner)!; const v = await cropImage(cdn(cur)!, 'banner'); if (v) setBanner(v.startsWith('data:') ? v : (me.banner ?? '').replace(/#.*$/, '') + v.slice(v.indexOf('#'))); }}>Crop / Reposition</button>
              )}
              {(banner ?? me.banner) && <button className="btn sm link" onClick={() => (setBanner(null), setD({ ...d, banner_market: null }))}>Remove Banner</button>}
              <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>or color</span>
              <input type="color" value={d.banner_color} onChange={(e) => setD({ ...d, banner_color: e.target.value })} style={{ width: 48, height: 32, border: 0, background: 'none' }} />
            </div>
            <div style={{ marginTop: 12 }}>
              <CosmeticPicker
                category="banner"
                value={d.banner_market?.slice(7) ?? null}
                onChange={(v) => {
                  setBanner(undefined);
                  setD({ ...d, banner_market: v ? `market:${v}` : null });
                }}
              />
            </div>
          </div>
          <div className="form-row">
            <label className="label">Profile Theme</label>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button className={`chip${!d.theme_colors ? ' active' : ''}`} onClick={() => setD({ ...d, theme_colors: null })}>Default</button>
              {(d.theme_colors ?? ['#1a1a2e', '#5865f2']).map((c, i) => (
                <label key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: 12, gap: 4 }}>
                  <input
                    type="color"
                    value={c}
                    onChange={(e) => {
                      const base = d.theme_colors ?? ['#1a1a2e', '#5865f2'];
                      setD({ ...d, theme_colors: base.map((x, j) => (j === i ? e.target.value : x)) as [string, string] });
                    }}
                    style={{ width: 66, height: 50, border: 0, background: 'none' }}
                  />
                  {i === 0 ? 'Primary' : 'Accent'}
                </label>
              ))}
            </div>
          </div>
          <div className="form-row">
            <label className="label">About Me</label>
            <textarea className="textarea" maxLength={190} value={d.bio} onChange={(e) => setD({ ...d, bio: e.target.value })} placeholder="Tell people a bit about yourself" />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'right' }}>{190 - d.bio.length}</div>
          </div>
        </div>
        <div className="pe-preview">
          <label className="label">Preview</label>
          <PreviewCard user={preview} />
        </div>
      </div>
      {dirty && (
        <SaveBar
          busy={busy}
          onReset={() => {
            setD(initial);
            setAvatar(undefined);
            setBanner(undefined);
          }}
          onSave={save}
        />
      )}
    </div>
  );
}

function PreviewCard({ user }: { user: PublicUser }) {
  return (
    <div className="user-popout" style={{ width: 300, border: '1px solid var(--border-card)', borderRadius: 8 }}>
      <UserPopout userId={user.id} preview={user} />
    </div>
  );
}
