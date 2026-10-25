import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { api } from '../../lib/api';
import { forgetAccount, loadAccounts, logout, parkCurrentAccount, switchAccount, toast, useStore, type SavedAccount } from '../../lib/store';
import { PasswordHint } from '../ConnectScreen';
import { Avatar } from '../../components/Avatar';
import { useBannerStyle } from '../../components/Cosmetics';

type Editing = null | 'display_name' | 'username' | 'email' | 'password' | 'mfa-enable' | 'mfa-disable' | 'delete' | 'add-account';

function EditModal({ kind, onClose }: { kind: Exclude<Editing, null>; onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const [value, setValue] = useState(kind === 'display_name' ? me.display_name ?? '' : kind === 'username' ? me.username : kind === 'email' ? me.email : '');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState<{ secret: string; uri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const titles: Record<string, string> = {
    display_name: 'Change your display name', username: 'Change your username', email: 'Change your email', password: 'Update your password',
    'mfa-enable': 'Enable Two-Factor Auth', 'mfa-disable': 'Remove Two-Factor Auth', delete: 'Delete Account',
    'add-account': 'Add an account on this email',
  };

  useEffect(() => {
    if (kind === 'mfa-enable') api.get('/users/@me/mfa/totp/setup').then(setMfa).catch((e) => setError(e.message));
  }, [kind]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'display_name') await api.patch('/users/@me', { display_name: value || null });
      if (kind === 'username') await api.patch('/users/@me', { username: value, password });
      if (kind === 'email') await api.patch('/users/@me', { email: value, password });
      if (kind === 'password') await api.patch('/users/@me', { password, new_password: newPassword });
      if (kind === 'mfa-enable') await api.post('/users/@me/mfa/totp/enable', { secret: mfa!.secret, code, password });
      if (kind === 'mfa-disable') await api.post('/users/@me/mfa/totp/disable', { code });
      if (kind === 'add-account') {
        const r = await api.post<{ token: string; user: { id: string; username: string; avatar: string | null } }>('/users/@me/siblings', {
          username: newUsername, password: newPassword, current_password: password,
        });
        await switchAccount({ id: r.user.id, username: r.user.username, avatar: r.user.avatar, token: r.token });
        return;
      }
      if (kind === 'delete') {
        await api.post('/users/@me/delete', { password });
        await logout(true);
        return;
      }
      toast('Saved!', 'info');
      onClose();
    } catch (e: any) {
      setError(Object.values(e.errors ?? {})[0] as string ?? e.message);
    } finally {
      setBusy(false);
    }
  };

  const needsPassword = ['username', 'email', 'password', 'mfa-enable', 'delete', 'add-account'].includes(kind);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header center"><h2>{titles[kind]}</h2></div>
        <div className="modal-body">
          {error && <div className="field-error" style={{ marginBottom: 12 }}>{error}</div>}
          {['display_name', 'username', 'email'].includes(kind) && (
            <div className="form-row">
              <label className="label">{kind === 'display_name' ? 'Display Name' : kind === 'username' ? 'Username' : 'Email'}</label>
              <input className="input" autoFocus value={value} onChange={(e) => setValue(kind === 'username' ? e.target.value.toLowerCase() : e.target.value)} />
            </div>
          )}
          {kind === 'mfa-enable' && mfa && (
            <div className="form-row">
              <p style={{ marginTop: 0, fontSize: 14 }}>Add this key to your authenticator app (Aegis, Google Authenticator, 1Password…), then enter the 6-digit code.</p>
              <code className="md-code" style={{ display: 'block', padding: 10, fontSize: 15, letterSpacing: 1, userSelect: 'text', wordBreak: 'break-all' }}>{mfa.secret.match(/.{1,4}/g)!.join(' ')}</code>
              <button className="btn sm link" onClick={() => navigator.clipboard.writeText(mfa.uri)}>Copy otpauth:// link</button>
            </div>
          )}
          {(kind === 'mfa-enable' || kind === 'mfa-disable') && (
            <div className="form-row">
              <label className="label">Authentication code</label>
              <input className="input" inputMode="numeric" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
          )}
          {kind === 'add-account' && (
            <>
              <p style={{ marginTop: 0, fontSize: 14 }}>The new account shares your email ({me.email}) and has its own username, password, friends and servers. You can switch between them any time.</p>
              <div className="form-row">
                <label className="label">New Username</label>
                <input className="input" autoFocus value={newUsername} maxLength={32} onChange={(e) => setNewUsername(e.target.value.toLowerCase())} />
              </div>
              <div className="form-row">
                <label className="label">New Account Password</label>
                <input className="input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
                <PasswordHint password={newPassword} username={newUsername} />
              </div>
            </>
          )}
          {needsPassword && (
            <div className="form-row">
              <label className="label">{kind === 'password' ? 'Current Password' : kind === 'add-account' ? `Current password for @${me.username}` : 'Password'}</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          )}
          {kind === 'password' && (
            <div className="form-row">
              <label className="label">New Password</label>
              <input className="input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              <PasswordHint password={newPassword} username={me.username} />
            </div>
          )}
          {kind === 'delete' && <div className="info-box warn">This permanently deletes your account. You must transfer or delete servers you own first.</div>}
        </div>
        <div className="modal-footer">
          <button className="btn link" onClick={onClose}>Cancel</button>
          <button className={`btn${kind === 'delete' || kind === 'mfa-disable' ? ' danger' : ''}`} disabled={busy} onClick={submit}>
            {kind === 'delete' ? 'Delete Account' : kind === 'add-account' ? 'Create & Switch' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AccountPage() {
  const me = useStore((s) => s.me)!;
  const banner = useBannerStyle(me, me.accent_color ?? '#5865f2');
  const [editing, setEditing] = useState<Editing>(null);
  const [reveal, setReveal] = useState(false);
  const email = reveal ? me.email : me.email.replace(/^(.).*(@.*)$/, (_, a, b) => `${a}${'*'.repeat(8)}${b}`);
  const Field = ({ label, value, k, extra }: { label: string; value: React.ReactNode; k: Editing; extra?: React.ReactNode }) => (
    <div className="us-card-row" style={{ minHeight: 56 }}>
      <div className="cr-text">
        <div className="us-field-label">{label}</div>
        <div className="us-field-value">{value} {extra}</div>
      </div>
      <button className="btn sm secondary" onClick={() => setEditing(k)}>Edit</button>
    </div>
  );
  return (
    <div className="us-page">
      <div className="us-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ height: 100, ...banner }} />
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, padding: '0 16px', marginTop: -38 }}>
          <div style={{ border: '7px solid var(--bg-card)', borderRadius: '50%' }}><Avatar user={me} size={80} /></div>
          <div style={{ flex: 1, paddingBottom: 12, fontSize: 20, fontWeight: 700, color: 'var(--text-strong)' }}>{me.display_name || me.username}</div>
          <button className="btn sm" style={{ marginBottom: 16 }} onClick={() => useStore.setState({ settings: { kind: 'user', section: 'profiles' } })}>
            <Pencil size={14} /> Edit User Profile
          </button>
        </div>
        <div style={{ margin: 16, padding: 16, borderRadius: 8, background: 'var(--bg-content)' }}>
          <Field label="Display Name" value={me.display_name || <span style={{ color: 'var(--text-muted)' }}>You haven't added a display name yet.</span>} k="display_name" />
          <Field label="Username" value={me.username} k="username" />
          <Field label="Email" value={email} k="email" extra={<a style={{ fontSize: 14, cursor: 'pointer' }} onClick={() => setReveal(!reveal)}>{reveal ? 'Hide' : 'Reveal'}</a>} />
        </div>
      </div>
      <AccountsSection onAdd={() => setEditing('add-account')} />
      <h3 style={{ marginTop: 40 }}>Password and Authentication</h3>
      <button className="btn" onClick={() => setEditing('password')}>Change Password</button>
      <div className="us-card" style={{ marginTop: 24 }}>
        <div className="us-card-row">
          <div className="cr-text">
            <div className="cr-title">{me.mfa_enabled ? 'Two-factor authentication is enabled' : 'Authenticator App'}</div>
            <div className="cr-sub">Protect your account with a one-time code from an authenticator app.</div>
          </div>
          {me.mfa_enabled ? (
            <button className="btn sm outline-danger" onClick={() => setEditing('mfa-disable')}>Remove 2FA</button>
          ) : (
            <button className="btn sm" onClick={() => setEditing('mfa-enable')}>Enable Authenticator App</button>
          )}
        </div>
      </div>
      <h3 style={{ marginTop: 40 }}>Account Removal</h3>
      <p className="us-desc">Deleting your account removes your profile, friends and inventory from this server. Messages you sent stay but show "Deleted User".</p>
      <button className="btn outline-danger" onClick={() => setEditing('delete')}>Delete Account</button>
      {editing && <EditModal kind={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Other accounts: ones saved on this device for this server, plus ones sharing this account's email. */
function AccountsSection({ onAdd }: { onAdd: () => void }) {
  const me = useStore((s) => s.me)!;
  const server = useStore((s) => s.server);
  const [saved, setSaved] = useState<SavedAccount[]>([]);
  const [siblings, setSiblings] = useState<{ id: string; username: string; display_name: string | null; avatar: string | null }[]>([]);
  const refresh = () => {
    loadAccounts().then((a) => setSaved(a.servers.find((x) => x.url === server?.url)?.others ?? []));
    api.get<typeof siblings>('/users/@me/siblings').then(setSiblings).catch(() => {});
  };
  useEffect(refresh, [server?.url, me.id]);
  const unsaved = siblings.filter((s) => !saved.some((a) => a.username === s.username));
  return (
    <>
      <h3 style={{ marginTop: 40 }}>Accounts</h3>
      <p className="us-desc">One email can own several accounts. Switch between them without logging out.</p>
      <div className="us-card">
        {saved.map((a) => (
          <div key={a.username} className="us-card-row">
            <div className="cr-text" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar user={{ id: a.id ?? a.username, avatar: a.avatar } as any} size={32} />
              <div className="cr-title">@{a.username}</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn sm link" onClick={async () => (await forgetAccount(a.username), refresh())}>Forget</button>
              <button className="btn sm" onClick={() => switchAccount(a)}>Switch</button>
            </div>
          </div>
        ))}
        {unsaved.map((s) => (
          <div key={s.id} className="us-card-row">
            <div className="cr-text" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar user={s as any} size={32} />
              <div>
                <div className="cr-title">{s.display_name ?? s.username}</div>
                <div className="cr-sub">@{s.username} · same email, not signed in on this device</div>
              </div>
            </div>
            <button className="btn sm secondary" onClick={() => parkCurrentAccount()}>Log in</button>
          </div>
        ))}
        <div className="us-card-row">
          <div className="cr-text">
            <div className="cr-title">Add another account</div>
            <div className="cr-sub">Creates a new account on {me.email}.</div>
          </div>
          <button className="btn sm" onClick={onAdd}>Add Account</button>
        </div>
      </div>
    </>
  );
}
