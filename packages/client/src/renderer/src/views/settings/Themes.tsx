import { useEffect, useMemo, useState } from 'react';
import { Code2, Copy, Eye, EyeOff, Globe, Lock, Play, Plus, Trash2, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { directory, useNetwork, type DirectoryEntry } from '../../lib/network';
import { cssClasses, cssVariables, loadActiveTheme, setActiveTheme, themeRuntime, themeTemplate, type ThemeCode } from '../../lib/themes';
import { toast } from '../../lib/store';
import { CodeEditor } from '../../components/CodeEditor';

interface Theme {
  id: string;
  name: string;
  description: string;
  visibility: 'private' | 'public' | 'global';
  allow_copy: boolean;
  author: { username: string } | null;
  origin: string | null;
  installs: number;
  mine: boolean;
  can_view_source: boolean;
  updated_at: number;
  css?: string;
  js?: string;
}

type Tab = 'mine' | 'public' | 'global';

const VIS_LABEL = { private: 'Private', public: 'This server', global: 'Global' } as const;
const VIS_ICON = { private: Lock, public: Users, global: Globe } as const;

export function ThemesPage() {
  const network = useNetwork();
  const [tab, setTab] = useState<Tab>('mine');
  const [list, setList] = useState<Theme[] | null>(null);
  const [global, setGlobal] = useState<DirectoryEntry[] | null>(null);
  const [editing, setEditing] = useState<Theme | 'new' | null>(null);
  const [active, setActive] = useState<ThemeCode | null>(loadActiveTheme());

  const load = () => {
    if (tab === 'global') {
      setGlobal(null);
      directory('theme').then(setGlobal).catch(() => setGlobal([]));
    } else {
      setList(null);
      api.get<Theme[]>(`/themes?tab=${tab}`).then(setList).catch(() => setList([]));
    }
  };
  useEffect(load, [tab]);

  const use = async (t: Theme) => {
    const full = await api.post<Theme>(`/themes/${t.id}/install`);
    const code = { id: full.id, name: full.name, css: full.css ?? '', js: full.js ?? '' };
    setActiveTheme(code);
    setActive(code);
    toast(`Using "${full.name}"`, 'info');
  };
  const useGlobal = async (g: DirectoryEntry) => {
    const full = await api.post<Theme>('/themes/global/install', { key: g.key });
    const code = { id: full.id, name: full.name, css: full.css ?? '', js: full.js ?? '' };
    setActiveTheme(code);
    setActive(code);
    toast(`Using "${full.name}"`, 'info');
  };

  if (editing) return <ThemeEditor theme={editing === 'new' ? null : editing} onClose={() => (setEditing(null), load())} network={!!network?.enabled} />;

  return (
    <div className="us-page">
      <h3>Themes</h3>
      <p className="us-desc">
        Restyle the whole app with your own CSS, and add behaviour with a sandboxed script. Share themes with this server or the whole OpenCord network, or keep them private.
      </p>
      <div className="theme-active">
        <div>
          <div className="cr-title">{active ? `Active: ${active.name}` : 'Using the default look'}</div>
          <div className="cr-sub">Themes apply on this device only.</div>
        </div>
        {active && (
          <button className="btn sm secondary" onClick={() => (setActiveTheme(null), setActive(null))}>
            Reset to Default
          </button>
        )}
        <button className="btn sm" onClick={() => setEditing('new')}>
          <Plus size={14} /> New Theme
        </button>
      </div>
      <div className="chip-row" style={{ margin: '16px 0' }}>
        <button className={`chip${tab === 'mine' ? ' active' : ''}`} onClick={() => setTab('mine')}>My Themes</button>
        <button className={`chip${tab === 'public' ? ' active' : ''}`} onClick={() => setTab('public')}>This Server</button>
        {network?.enabled && <button className={`chip${tab === 'global' ? ' active' : ''}`} onClick={() => setTab('global')}>Global</button>}
      </div>
      {tab !== 'global' ? (
        list === null ? (
          <div className="spinner" />
        ) : list.length === 0 ? (
          <div className="empty-state">{tab === 'mine' ? 'No themes yet. Create one to get started.' : 'Nobody has shared a theme here yet.'}</div>
        ) : (
          <div className="theme-list">
            {list.map((t) => {
              const Icon = VIS_ICON[t.visibility];
              return (
                <div key={t.id} className={`theme-card${active?.id === t.id ? ' active' : ''}`}>
                  <div className="tc-main">
                    <div className="tc-name">
                      {t.name}
                      <span className="tc-vis"><Icon size={11} /> {VIS_LABEL[t.visibility]}</span>
                      {!t.allow_copy && <span className="tc-vis" title="Source hidden, copies blocked"><EyeOff size={11} /> No copies</span>}
                    </div>
                    <div className="tc-desc">{t.description || (t.author ? `by @${t.author.username}` : '')}</div>
                    <div className="tc-meta">{t.installs} uses</div>
                  </div>
                  <div className="tc-actions">
                    {t.mine && <button className="btn sm secondary" onClick={() => api.get<Theme>(`/themes/${t.id}`).then(setEditing)}><Code2 size={14} /> Edit</button>}
                    {!t.mine && t.can_view_source && (
                      <button className="btn sm secondary" onClick={() => api.post<Theme>(`/themes/${t.id}/fork`).then((f) => (toast('Copied to My Themes.', 'info'), setEditing(f))).catch((e) => toast(e.message))}>
                        <Copy size={14} /> Copy
                      </button>
                    )}
                    <button className="btn sm" onClick={() => use(t).catch((e) => toast(e.message))}>{active?.id === t.id ? 'Re-apply' : 'Use'}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : global === null ? (
        <div className="spinner" />
      ) : global.length === 0 ? (
        <div className="empty-state">No global themes yet.</div>
      ) : (
        <div className="theme-list">
          {global.map((g) => (
            <div key={g.key} className="theme-card">
              <div className="tc-main">
                <div className="tc-name">
                  {g.name}
                  <span className="tc-vis"><Globe size={11} /> {new URL(g.host).host}</span>
                  {g.has_js && <span className="tc-vis">Script</span>}
                </div>
                <div className="tc-desc">{g.description || (g.author ? `by ${g.author}` : '')}</div>
              </div>
              <div className="tc-actions">
                <button className="btn sm" onClick={() => useGlobal(g).catch((e) => toast(e.message))}>Use</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeEditor({ theme, onClose, network }: { theme: Theme | null; onClose: () => void; network: boolean }) {
  const template = useMemo(() => themeTemplate(), []);
  const [name, setName] = useState(theme?.name ?? 'My Theme');
  const [description, setDescription] = useState(theme?.description ?? '');
  const [css, setCss] = useState(theme?.css ?? template.css);
  const [js, setJs] = useState(theme?.js ?? template.js);
  const [visibility, setVisibility] = useState<Theme['visibility']>(theme?.visibility ?? 'private');
  const [allowCopy, setAllowCopy] = useState(theme?.allow_copy ?? true);
  const [pane, setPane] = useState<'css' | 'js' | 'reference'>('css');
  const [preview, setPreview] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [id, setId] = useState(theme?.id ?? null);
  const before = useMemo(() => loadActiveTheme(), []);

  // Live preview applies the code as you type; leaving the editor restores the active theme.
  useEffect(() => {
    if (!preview) return;
    const t = setTimeout(() => themeRuntime.apply({ id: 'preview', name, css, js }), 300);
    return () => clearTimeout(t);
  }, [preview, css, js, name]);
  useEffect(() => {
    themeRuntime.onLog = (line) => setLogs((l) => [...l.slice(-99), line]);
    return () => {
      themeRuntime.onLog = null;
      themeRuntime.apply(loadActiveTheme() ?? before);
    };
  }, [before]);

  const save = async (apply = false) => {
    setBusy(true);
    try {
      const body = { name: name.trim() || 'Untitled', description, css, js, visibility, allow_copy: allowCopy };
      const saved = id ? await api.patch<Theme>(`/themes/${id}`, body) : await api.post<Theme>('/themes', body);
      setId(saved.id);
      if (apply) setActiveTheme({ id: saved.id, name: saved.name, css: saved.css ?? css, js: saved.js ?? js });
      toast(apply ? 'Saved and applied.' : 'Saved.', 'info');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const vars = useMemo(() => (pane === 'reference' ? cssVariables() : []), [pane]);
  const classes = useMemo(() => (pane === 'reference' ? cssClasses() : []), [pane]);

  return (
    <div className="us-page theme-editor">
      <div className="te-top">
        <input className="input te-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Theme name" />
        <select className="input select te-vis" value={visibility} onChange={(e) => setVisibility(e.target.value as Theme['visibility'])}>
          <option value="private">Private (only me)</option>
          <option value="public">Public (this server)</option>
          {network && <option value="global">Global (whole network)</option>}
        </select>
      </div>
      <input className="input" style={{ marginBottom: 8 }} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="Short description" />
      <label className="mp-check">
        <input type="checkbox" checked={!allowCopy} onChange={(e) => setAllowCopy(!e.target.checked)} />
        <span>
          Don't allow copies
          <small>Hides the source from others and blocks re-publishing the same code. People can still use the theme if it's shared.</small>
        </span>
      </label>
      <div className="te-tabs">
        <button className={`te-tab${pane === 'css' ? ' active' : ''}`} onClick={() => setPane('css')}>theme.css</button>
        <button className={`te-tab${pane === 'js' ? ' active' : ''}`} onClick={() => setPane('js')}>theme.js</button>
        <button className={`te-tab${pane === 'reference' ? ' active' : ''}`} onClick={() => setPane('reference')}>Reference</button>
        <span style={{ flex: 1 }} />
        <button className={`btn sm ${preview ? 'green' : 'secondary'}`} onClick={() => (preview ? (setPreview(false), themeRuntime.apply(loadActiveTheme())) : setPreview(true))}>
          {preview ? <Eye size={14} /> : <Play size={14} />} {preview ? 'Previewing' : 'Live Preview'}
        </button>
      </div>
      <div className="te-pane">
        {pane === 'css' && <CodeEditor language="css" value={css} onChange={setCss} />}
        {pane === 'js' && <CodeEditor language="js" value={js} onChange={setJs} />}
        {pane === 'reference' && (
          <div className="te-ref scroller thin">
            <h4>CSS variables ({vars.length})</h4>
            <p>Everything in the UI is drawn from these. Click one to add it to your CSS.</p>
            <div className="te-vars">
              {vars.map((v) => (
                <button key={v.name} className="te-var" onClick={() => (setCss((c) => c.replace(/:root\s*{/, `:root {\n  ${v.name}: ${v.value};`)), setPane('css'))}>
                  <span className="te-swatch" style={{ background: /^(#|rgb|hsl)/.test(v.value) ? v.value : 'transparent' }} />
                  <code>{v.name}</code>
                  <span className="te-val">{v.value}</span>
                </button>
              ))}
            </div>
            <h4>Classes ({classes.length})</h4>
            <p>Target any part of the app, e.g. <code>.message</code>, <code>.guild-rail</code>, <code>.call-tile</code>.</p>
            <div className="te-classes">{classes.map((c) => <code key={c}>.{c}</code>)}</div>
            <h4>Script API</h4>
            <pre className="te-api">{`api.setVar('--brand', '#ff3388')   // set a CSS variable (no url() values)
api.setVar('--brand', null)        // remove it again
api.toggleClass('night', true)     // adds .theme-night to <html>
api.on('route', ({ kind, view }) => …)
api.on('message', ({ count }) => …) // new messages arrived
api.on('voice', ({ in_call, speaking }) => …)
api.on('focus', (focused) => …)
api.on('theme', ({ dark }) => …)    // system light/dark changed
api.log('hello')                    // shows in the console below

The script runs in an isolated worker: there is no DOM, no
network (fetch/WebSocket are removed), no storage and no access
to your account. setInterval/setTimeout work as usual.`}</pre>
          </div>
        )}
      </div>
      {pane === 'js' && (
        <div className="te-console scroller thin">
          {logs.length === 0 ? <span className="te-muted">Console: turn on Live Preview to run the script.</span> : logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      <div className="te-footer">
        {id && (
          <button
            className="btn sm link danger-text"
            onClick={async () => {
              await api.del(`/themes/${id}`);
              if (loadActiveTheme()?.id === id) setActiveTheme(null);
              onClose();
            }}
          >
            <Trash2 size={14} /> Delete
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn sm link" onClick={onClose}>Back</button>
        <button className="btn sm secondary" disabled={busy} onClick={() => save(false)}>Save</button>
        <button className="btn sm" disabled={busy} onClick={() => save(true)}>Save & Use</button>
      </div>
    </div>
  );
}
