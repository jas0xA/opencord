import { useEffect, useState } from 'react';
import { Heart, Plus, Search, Trash2, Flag, Check, Upload, Globe, Lock } from 'lucide-react';
import type { MarketplaceCategory, MarketplaceItem } from '@opencord/shared';
import { api, fileToDataUrl, pickFile } from '../lib/api';
import { closeModal, displayName, openModal, toast, useStore } from '../lib/store';
import { MarketplacePreview } from '../components/Cosmetics';
import { Logo } from '../components/Icons';
import { openContextMenu } from '../components/Layers';
import { directory, useNetwork, type DirectoryEntry } from '../lib/network';

const CATEGORIES: { id: MarketplaceCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'avatar_decoration', label: 'Avatar Decorations' },
  { id: 'profile_effect', label: 'Profile Effects' },
  { id: 'nameplate', label: 'Nameplates' },
  { id: 'banner', label: 'Banners' },
  { id: 'profile_theme', label: 'Profile Themes' },
];

type Tab = 'official' | 'community' | 'global' | 'owned' | 'mine';

/** Equips (or unequips) a claimed item on the current user. */
export async function equip(item: MarketplaceItem, on: boolean) {
  const patch: Record<string, unknown> = {};
  switch (item.category) {
    case 'avatar_decoration':
    case 'profile_effect':
    case 'nameplate':
      patch[item.category] = on ? item.id : null;
      break;
    case 'banner':
      patch.banner = on ? `market:${item.id}` : null;
      break;
    case 'profile_theme':
      patch.theme_colors = on && item.colors ? [item.colors[0], item.colors[1] ?? item.colors[0]] : null;
      break;
  }
  await api.patch('/users/@me', patch);
}

export function isEquipped(item: MarketplaceItem) {
  const me = useStore.getState().me;
  if (!me) return false;
  switch (item.category) {
    case 'avatar_decoration':
    case 'profile_effect':
    case 'nameplate':
      return me[item.category] === item.id;
    case 'banner':
      return me.banner === `market:${item.id}`;
    case 'profile_theme':
      return !!item.colors && me.theme_colors?.[0] === item.colors[0] && me.theme_colors?.[1] === (item.colors[1] ?? item.colors[0]);
  }
}

function reportItems(id: string) {
  return ['Inappropriate or offensive', 'Stolen artwork', 'Spam or low effort', 'Other'].map((reason) => ({
    label: `Report: ${reason}`,
    danger: true,
    onClick: () => api.post(`/marketplace/items/${id}/report`, { reason }).then(() => toast('Thanks — an admin will review it.', 'info')).catch((e) => toast(e.message)),
  }));
}

function ItemCard({ item }: { item: MarketplaceItem }) {
  const me = useStore((s) => s.me);
  const live = useStore((s) => s.marketplace[item.id]) ?? item;
  const owned = me?.inventory.includes(live.id);
  const equipped = useStore(() => isEquipped(live));
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const update = (it: MarketplaceItem) => useStore.setState((s) => ({ marketplace: { ...s.marketplace, [it.id]: it } }));
  const canDelete = !live.official && (live.author?.id === me?.id || me?.admin);
  return (
    <div
      className="mp-item"
      onContextMenu={(e) =>
        openContextMenu(e, [
          ...(!live.official && live.author?.id !== me?.id ? reportItems(live.id) : []),
          ...(live.author?.id === me?.id && !live.official
            ? [
                { label: live.visibility === 'private' ? 'Make Public' : 'Make Private (only me)', onClick: () => act(async () => update(await api.patch(`/marketplace/items/${live.id}`, { visibility: live.visibility === 'private' ? 'public' : 'private' }))) },
                { label: live.allow_copy === false ? 'Allow Copies' : "Don't Allow Copies", onClick: () => act(async () => update(await api.patch(`/marketplace/items/${live.id}`, { allow_copy: live.allow_copy === false }))) },
                live.visibility !== 'private' && { label: live.global ? 'Remove from Global Network' : 'List on Global Network', onClick: () => act(async () => update(await api.patch(`/marketplace/items/${live.id}`, { global: !live.global }))) },
              ]
            : []),
          canDelete && { label: 'Delete Item', danger: true, onClick: () => api.del(`/marketplace/items/${live.id}`) },
        ])
      }
    >
      <div className="mp-preview">
        <MarketplacePreview item={live} />
      </div>
      <div className="mp-info">
        <div className="mp-name">
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{live.name}</span>
          {live.official && <span className="mp-official">Official</span>}
          {live.status === 'pending' && <span className="mp-pending">Pending</span>}
          {live.visibility === 'private' && <span className="mp-pending" title="Only you can see and use this"><Lock size={10} /> Private</span>}
          {live.global && <span className="mp-official" title="Listed on the global network"><Globe size={10} /> Global</span>}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, minHeight: 34 }}>{live.description}</div>
        <div className="mp-meta">
          <span className="grow">{live.author ? `by ${displayName(live.author)}` : 'by OpenCord'}</span>
          <button className={`mp-like${live.liked ? ' on' : ''}`} onClick={() => act(async () => update(await (live.liked ? api.del(`/marketplace/items/${live.id}/like`) : api.put(`/marketplace/items/${live.id}/like`))))}>
            <Heart size={14} fill={live.liked ? 'currentColor' : 'none'} /> {live.likes}
          </button>
          <span>· {live.owners} owned</span>
        </div>
        <div className="mp-actions">
          {!owned ? (
            <button className="btn" disabled={busy || live.status !== 'approved'} onClick={() => act(async () => update(await api.put(`/marketplace/items/${live.id}/claim`)))}>
              Get for Free
            </button>
          ) : equipped ? (
            <button className="btn secondary" disabled={busy} onClick={() => act(() => equip(live, false))}>
              <Check size={16} /> Equipped
            </button>
          ) : (
            <button className="btn green" disabled={busy} onClick={() => act(() => equip(live, true))}>
              Equip
            </button>
          )}
          {owned && !equipped && live.author?.id !== me?.id && (
            <button className="btn outline" style={{ flex: 'none', width: 40, minWidth: 0, padding: 0 }} title="Remove from inventory" onClick={() => act(async () => update(await api.del(`/marketplace/items/${live.id}/claim`)))}>
              <Trash2 size={16} />
            </button>
          )}
          {!live.official && live.author?.id !== me?.id && (
            <button className="btn outline" style={{ flex: 'none', width: 40, minWidth: 0, padding: 0 }} title="Report" onClick={(e) => openContextMenu(e, reportItems(live.id))}>
              <Flag size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A cosmetic listed on the global network (possibly from another host). */
function GlobalItemCard({ entry }: { entry: DirectoryEntry }) {
  const me = useStore((s) => s.me);
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState<MarketplaceItem | null>(null);
  const item: MarketplaceItem = {
    id: entry.key, category: entry.category, name: entry.name, description: entry.description ?? '', asset: entry.asset ?? 'builtin:gradient',
    preview: entry.preview ?? null, colors: entry.colors ?? null, official: false, author: null, status: 'approved', likes: 0, liked: false, owners: 0,
    tags: entry.tags ?? [], created_at: entry.ts,
  };
  const owned = claimed && me?.inventory.includes(claimed.id);
  return (
    <div className="mp-item">
      <div className="mp-preview">
        <MarketplacePreview item={item} />
      </div>
      <div className="mp-info">
        <div className="mp-name">
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
          <span className="mp-official"><Globe size={10} /> Global</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, minHeight: 34 }}>{item.description}</div>
        <div className="mp-meta">
          <span className="grow">{entry.author ? `by ${entry.author}` : new URL(entry.host).host}</span>
        </div>
        <div className="mp-actions">
          {owned ? (
            <button className="btn green" disabled={busy} onClick={async () => (setBusy(true), await equip(claimed!, true).catch((e) => toast(e.message)), setBusy(false))}>
              Equip
            </button>
          ) : (
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const it = await api.post<MarketplaceItem>('/marketplace/global/claim', { key: entry.key });
                  useStore.setState((s) => ({ marketplace: { ...s.marketplace, [it.id]: it } }));
                  setClaimed(it);
                  toast('Added to your inventory.', 'info');
                } catch (e: any) {
                  toast(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Get for Free
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Marketplace() {
  const instance = useStore((s) => s.instance);
  const [tab, setTab] = useState<Tab>('official');
  const [category, setCategory] = useState<MarketplaceCategory | 'all'>('all');
  const [sort, setSort] = useState<'popular' | 'new'>('popular');
  const [q, setQ] = useState('');
  const [ids, setIds] = useState<string[] | null>(null);
  const marketplace = useStore((s) => s.marketplace);
  const me = useStore((s) => s.me);
  const network = useNetwork();
  const [globalItems, setGlobalItems] = useState<DirectoryEntry[] | null>(null);

  const load = () => {
    if (tab === 'global') {
      setGlobalItems(null);
      directory('item', q)
        .then((r) => setGlobalItems(r.filter((i) => category === 'all' || i.category === category)))
        .catch(() => setGlobalItems([]));
      return;
    }
    setIds(null);
    const params = new URLSearchParams({ tab, sort });
    if (category !== 'all') params.set('category', category);
    if (q) params.set('q', q);
    api
      .get<{ items: MarketplaceItem[] }>(`/marketplace/items?${params}`)
      .then((r) => {
        useStore.setState((s) => ({ marketplace: { ...s.marketplace, ...Object.fromEntries(r.items.map((i) => [i.id, i])) } }));
        setIds(r.items.map((i) => i.id));
      })
      .catch((e) => toast(e.message));
  };
  useEffect(load, [tab, category, sort]);
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [q]);

  // Live community additions appear without a refresh.
  const items = (ids ?? []).map((id) => marketplace[id]).filter(Boolean);
  if (tab === 'community' && ids) {
    for (const it of Object.values(marketplace)) {
      if (!it.official && it.status === 'approved' && !ids.includes(it.id) && (category === 'all' || it.category === category) && Date.now() - it.created_at < 3600_000) items.unshift(it);
    }
  }
  if (tab === 'owned' && ids) {
    for (const it of items.slice()) if (!me?.inventory.includes(it.id)) items.splice(items.indexOf(it), 1);
  }

  return (
    <div className="main">
      <div className="chat-header">
        <div className="ch-title">
          <Logo size={24} style={{ color: 'var(--text-muted)' }} />
          Marketplace
        </div>
        <div className="sep" style={{ width: 1, height: 24, background: 'var(--border-strong)', margin: '0 8px' }} />
        <div className="tabs" style={{ display: 'flex', gap: 8 }}>
          {(['official', 'community', 'global', 'owned', 'mine'] as Tab[])
            .filter((t) => (t === 'global' ? !!network?.enabled : instance?.community_marketplace || t === 'official' || t === 'owned'))
            .map((t) => (
              <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
                {{ official: 'Shop', community: 'Community', global: 'Global', owned: 'Inventory', mine: 'My Creations' }[t]}
              </button>
            ))}
        </div>
        {instance?.community_marketplace && (
          <div className="tools">
            <button className="btn sm green" onClick={() => openModal({ type: 'publish-item' })}>
              <Plus size={16} /> Create
            </button>
          </div>
        )}
      </div>
      <div className="marketplace scroller">
        <div className="mp-hero">
          <h1>{tab === 'community' ? 'Community Creations' : tab === 'global' ? 'From across OpenCord' : tab === 'owned' ? 'Your Inventory' : tab === 'mine' ? 'Your Creations' : 'Everything is free.'}</h1>
          <p>
            {tab === 'global'
              ? 'Cosmetics creators on every OpenCord host have shared with the whole network. Claim one and it shows up in your inventory here.'
              : tab === 'community'
              ? 'Cosmetics made by people on this server. Publish your own and they sync to everyone instantly.'
              : 'Avatar decorations, profile effects, nameplates, banners and themes — no subscription, no paywall. Claim anything and make your profile yours.'}
          </p>
        </div>
        <div className="mp-toolbar">
          {CATEGORIES.map((c) => (
            <button key={c.id} className={`chip${category === c.id ? ' active' : ''}`} onClick={() => setCategory(c.id)}>
              {c.label}
            </button>
          ))}
          <select className="input select" style={{ width: 140, height: 32, fontSize: 14 }} value={sort} onChange={(e) => setSort(e.target.value as 'popular' | 'new')}>
            <option value="popular">Popular</option>
            <option value="new">Newest</option>
          </select>
          <div className="search-box mp-search" style={{ height: 32 }}>
            <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            <Search size={16} />
          </div>
        </div>
        {tab === 'global' ? (
          globalItems === null ? (
            <div className="empty-state"><div className="spinner" /></div>
          ) : globalItems.length === 0 ? (
            <div className="empty-state">Nothing on the global network yet. Publish something and tick "List on the global network".</div>
          ) : (
            <div className="mp-grid">
              {globalItems.map((g) => <GlobalItemCard key={g.key} entry={g} />)}
            </div>
          )
        ) : ids === null ? (
          <div className="empty-state"><div className="spinner" /></div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            {tab === 'mine' ? "You haven't published anything yet." : tab === 'owned' ? 'Nothing claimed yet — everything in the shop is free!' : 'Nothing here yet.'}
            {(tab === 'mine' || tab === 'community') && instance?.community_marketplace && (
              <button className="btn" onClick={() => openModal({ type: 'publish-item' })}>Create something</button>
            )}
          </div>
        ) : (
          <div className="mp-grid">
            {items.map((it) => <ItemCard key={it.id} item={it} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Community publishing form (modal). */
export function PublishItem() {
  const [category, setCategory] = useState<MarketplaceCategory>('avatar_decoration');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [asset, setAsset] = useState<string | null>(null);
  const [colors, setColors] = useState<string[]>(['#5865f2', '#eb459e']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [allowCopy, setAllowCopy] = useState(true);
  const [global, setGlobal] = useState(false);
  const network = useNetwork();
  const colorOnly = category === 'profile_theme';
  const colorOk = category === 'profile_theme' || category === 'nameplate' || category === 'banner';
  const hints: Record<MarketplaceCategory, string> = {
    avatar_decoration: 'Transparent PNG/APNG/GIF/WebP, square (e.g. 288×288). It is drawn slightly larger than the avatar.',
    profile_effect: 'Transparent animated APNG/GIF/WebP shown over the whole profile card (e.g. 450×880).',
    nameplate: 'Wide image (e.g. 600×120) or pick two gradient colors.',
    banner: 'Image at 600×240 or larger, or pick gradient colors.',
    profile_theme: 'Pick the two colors of the profile gradient.',
  };
  const preview: MarketplaceItem = {
    id: 'preview', category, name: name || 'Preview', description, asset: asset ?? (colorOnly ? 'builtin:theme' : 'builtin:gradient'), preview: null,
    colors, official: false, author: null, status: 'approved', likes: 0, liked: false, owners: 0, tags: [], created_at: Date.now(),
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const item = await api.post<MarketplaceItem>('/marketplace/items', {
        category, name: name.trim(), description: description.trim(), asset: asset ?? undefined, colors: !asset && colorOk ? colors : undefined,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5),
        visibility, allow_copy: allowCopy, global: global && visibility === 'public',
      });
      useStore.setState((s) => ({ marketplace: { ...s.marketplace, [item.id]: item } }));
      toast(visibility === 'private' ? 'Saved. Only you can see and use it.' : item.status === 'pending' ? 'Submitted! An admin will review it before it is listed.' : 'Published to the community!', 'info');
      closeModal();
    } catch (e: any) {
      setError(e.message + (e.errors ? ` ${Object.values(e.errors).join(', ')}` : ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal wide" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <h2>Publish to Community</h2>
        <p>Share a cosmetic with everyone on this server. It's free for anyone to claim.</p>
      </div>
      <div className="modal-body scroller thin" style={{ display: 'flex', gap: 24 }}>
        <div style={{ flex: 1 }}>
          <div className="form-row">
            <label className="label">Category</label>
            <select className="input select" value={category} onChange={(e) => (setCategory(e.target.value as MarketplaceCategory), setAsset(null))}>
              {CATEGORIES.slice(1).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>{hints[category]}</div>
          </div>
          <div className="form-row">
            <label className="label">Name <span className="req">*</span></label>
            <input className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-row">
            <label className="label">Description</label>
            <textarea className="textarea" style={{ minHeight: 60 }} maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="form-row">
            <label className="label">Tags (comma separated)</label>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="cute, animated, pixel" />
          </div>
          {!colorOnly && (
            <div className="form-row">
              <button
                className="btn secondary"
                onClick={async () => {
                  const [f] = await pickFile('image/png,image/apng,image/gif,image/webp,image/jpeg');
                  if (!f) return;
                  const max = (useStore.getState().instance?.max_upload_mb ?? 5) * 1024 * 1024;
                  if (f.size > max) return setError('File is too large.');
                  setAsset(await fileToDataUrl(f));
                }}
              >
                <Upload size={16} /> {asset ? 'Replace Image' : 'Upload Image'}
              </button>
              {asset && <button className="btn link" onClick={() => setAsset(null)}>Remove</button>}
            </div>
          )}
          {colorOk && !asset && (
            <div className="form-row">
              <label className="label">Colors</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {colors.map((c, i) => (
                  <input key={i} type="color" value={c} onChange={(e) => setColors(colors.map((x, j) => (j === i ? e.target.value : x)))} style={{ width: 48, height: 36, border: 0, background: 'none' }} />
                ))}
              </div>
            </div>
          )}
          <div className="form-row">
            <label className="label">Who can use it</label>
            <select className="input select" value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}>
              <option value="public">Everyone (listed in Community)</option>
              <option value="private">Only me (private)</option>
            </select>
          </div>
          <label className="mp-check">
            <input type="checkbox" checked={!allowCopy} onChange={(e) => setAllowCopy(!e.target.checked)} />
            <span>
              Don't allow copies
              <small>Others can still use it if it's public, but nobody else can re-upload this design as their own.</small>
            </span>
          </label>
          {network?.enabled && visibility === 'public' && (
            <label className="mp-check">
              <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} />
              <span>
                List on the global network
                <small>People on every OpenCord host can find and claim it.</small>
              </span>
            </label>
          )}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div style={{ width: 220 }}>
          <label className="label">Preview</label>
          <div className="mp-item" style={{ cursor: 'default' }}>
            <div className="mp-preview">
              {(asset || colorOk) && <MarketplacePreview item={preview} />}
            </div>
            <div className="mp-info"><div className="mp-name">{preview.name}</div></div>
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn link" onClick={closeModal}>Cancel</button>
        <button className="btn" disabled={busy || name.trim().length < 2 || (!asset && !colorOk)} onClick={submit}>Publish</button>
      </div>
    </div>
  );
}
