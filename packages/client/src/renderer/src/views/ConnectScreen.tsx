import { useEffect, useState } from 'react';
import { ArrowLeft, Server, Trash2 } from 'lucide-react';
import { passwordProblem, usernameProblem, type InstanceInfo } from '@opencord/shared';
import { api, ApiError, cdn, configureApi, resolveServer } from '../lib/api';
import { loadAccounts, saveAccounts, startSession, type SavedServer } from '../lib/store';
import { Logo } from '../components/Icons';
import { WindowControls } from '../components/TitleBar';
import { isWeb } from '../lib/web';

type Step = { kind: 'servers' } | { kind: 'auth'; server: SavedServer; info: InstanceInfo; mode: 'login' | 'register' | 'forgot' | 'reset' };

function Field({ label, error, children, required }: { label: string; error?: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div className="form-row">
      <label className="label" style={error ? { color: 'var(--text-danger)' } : undefined}>
        {label}
        {required && <span className="req">*</span>}
        {error && <span className="field-error"> - {error}</span>}
      </label>
      {children}
    </div>
  );
}

export function ConnectScreen({ initialError }: { initialError?: string }) {
  const [step, setStep] = useState<Step>({ kind: 'servers' });
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  useEffect(() => {
    loadAccounts().then((a) => setServers(a.servers));
    // The web app belongs to the server hosting it: go straight to its sign-in.
    if (isWeb()) openServer(location.origin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openServer = async (input: string, saved?: SavedServer) => {
    setBusy(true);
    setError(null);
    try {
      const { url, info } = await resolveServer(saved?.url ?? input);
      const server: SavedServer = saved ? { ...saved, name: info.name } : { url, name: info.name, token: null, username: null, avatar: null };
      const accounts = await loadAccounts();
      if (!accounts.servers.some((s) => s.url === url)) accounts.servers.push(server);
      accounts.servers = accounts.servers.map((s) => (s.url === url ? { ...s, name: info.name } : s));
      await saveAccounts(accounts);
      setServers(accounts.servers);
      if (server.token) {
        configureApi(url, server.token);
        try {
          await api.get('/users/@me');
          accounts.last = url;
          await saveAccounts(accounts);
          return startSession(server, info);
        } catch {
          server.token = null;
        }
      }
      setStep({ kind: 'auth', server, info, mode: 'login' });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removeServer = async (url: string) => {
    const a = await loadAccounts();
    a.servers = a.servers.filter((s) => s.url !== url);
    if (a.last === url) a.last = null;
    await saveAccounts(a);
    setServers(a.servers);
  };

  return (
    <div className="app">
      <div className="titlebar" style={{ borderBottom: 0, background: 'transparent', position: 'absolute', left: 0, right: 0, zIndex: 5 }}>
        <div className="titlebar-right"><WindowControls /></div>
      </div>
      <div className="connect-screen">
        {step.kind === 'servers' ? (
          <div className="auth-card">
            <div className="auth-logo"><Logo size={56} style={{ color: '#5865f2', ['--logo-cut' as string]: 'var(--bg-content)' }} /></div>
            <h1>Welcome to OpenCord</h1>
            <div className="sub">Connect to a server by its domain or IP address.</div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                openServer(address);
              }}
            >
              <Field label="Server address" error={error ?? undefined} required>
                <input className="input" autoFocus placeholder="chat.example.com or 192.168.1.10:8443" value={address} onChange={(e) => setAddress(e.target.value)} />
              </Field>
              <button className="btn lg full" disabled={busy || !address.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>
            </form>
            {servers.length > 0 && (
              <>
                <div className="label" style={{ marginTop: 28 }}>Your servers</div>
                {servers.map((s) => (
                  <div key={s.url} className="server-card" onClick={() => !busy && openServer(s.url, s)}>
                    <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--brand)', display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0 }}>
                      {s.avatar ? <img src={s.avatar.startsWith('/') ? s.url + s.avatar : cdn(s.avatar)!} width={40} height={40} alt="" /> : <Server size={20} color="#fff" />}
                    </div>
                    <div className="sc-text">
                      <div className="sc-name">{s.name}</div>
                      <div className="sc-url">{s.username ? `${s.username} · ` : ''}{s.url}</div>
                    </div>
                    <button className="sc-remove" title="Remove" onClick={(e) => (e.stopPropagation(), removeServer(s.url))}><Trash2 size={18} /></button>
                  </div>
                ))}
              </>
            )}
          </div>
        ) : (
          <AuthForm step={step} setStep={setStep} back={() => setStep({ kind: 'servers' })} />
        )}
      </div>
    </div>
  );
}

/** Live check against the same rules the server enforces. */
export function PasswordHint({ password, username }: { password: string; username?: string }) {
  if (!password) return <div className="pw-hint">At least 8 characters, with a letter and a number.</div>;
  const problem = passwordProblem(password, { username });
  return <div className={`pw-hint${problem ? ' bad' : ' ok'}`}>{problem ?? 'Looks good.'}</div>;
}

function AuthForm({ step, setStep, back }: { step: Extract<Step, { kind: 'auth' }>; setStep: (s: Step) => void; back: () => void }) {
  const { server, info, mode } = step;
  const [login, setLogin] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [choices, setChoices] = useState<{ id: string; username: string; display_name: string | null; avatar: string | null }[] | null>(null);
  const [accountId, setAccountId] = useState<string | undefined>(undefined);

  const call = async <T,>(method: string, path: string, body: unknown) => api.raw<T>(method, path, body, server.url, '');

  const finish = async (token: string) => {
    const accounts = await loadAccounts();
    const updated = { ...server, token };
    accounts.servers = accounts.servers.some((s) => s.url === server.url) ? accounts.servers.map((s) => (s.url === server.url ? updated : s)) : [...accounts.servers, updated];
    accounts.last = server.url;
    await saveAccounts(accounts);
    startSession(updated, info);
  };

  const handle = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      const err = e as ApiError;
      setErrors(Object.keys(err.errors ?? {}).length ? err.errors : { _: err.message });
    } finally {
      setBusy(false);
    }
  };

  const regClosed = info.registration === 'closed';
  const header = (
    <div className="instance-chip">
      <a onClick={back} style={{ display: 'flex', alignItems: 'center', gap: 4 }}><ArrowLeft size={14} /> {info.name}</a>
      <span>· {server.url.replace(/^https?:\/\//, '')}</span>
    </div>
  );

  if (mode === 'forgot' || mode === 'reset') {
    return (
      <div className="auth-card">
        <h1>{mode === 'forgot' ? 'Forgot your password?' : 'Reset your password'}</h1>
        <div className="sub">{mode === 'forgot' ? "We'll email you a reset code." : 'Enter the code from your email and a new password.'}</div>
        {header}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handle(async () => {
              if (mode === 'forgot') {
                const r = await call<{ smtp: boolean }>('POST', '/auth/forgot', { email });
                if (!r.smtp) throw new ApiError(400, 'This server has no email configured. Ask an admin to reset your password with: opencord-server reset-password <username>');
                setStep({ ...step, mode: 'reset' });
              } else {
                await call('POST', '/auth/reset', { token: resetToken, password });
                setMessage('Password changed. You can log in now.');
                setStep({ ...step, mode: 'login' });
              }
            });
          }}
        >
          {mode === 'forgot' ? (
            <Field label="Email" error={errors.email} required>
              <input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          ) : (
            <>
              <Field label="Reset code" error={errors.token} required>
                <input className="input" autoFocus value={resetToken} onChange={(e) => setResetToken(e.target.value)} />
              </Field>
              <Field label="New password" error={errors.password} required>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <PasswordHint password={password} />
              </Field>
            </>
          )}
          {errors._ && <div className="field-error" style={{ marginBottom: 12 }}>{errors._}</div>}
          <button className="btn lg full" disabled={busy}>{mode === 'forgot' ? 'Send reset code' : 'Change password'}</button>
          <div className="switch-link"><a onClick={() => setStep({ ...step, mode: 'login' })}>Back to login</a></div>
        </form>
      </div>
    );
  }

  if (mode === 'login') {
    return (
      <div className="auth-card">
        <h1>{mfa ? 'Two-factor authentication' : 'Welcome back!'}</h1>
        <div className="sub">{mfa ? 'Enter the 6-digit code from your authenticator app.' : "We're so excited to see you again!"}</div>
        {header}
        {message && <div className="info-box">{message}</div>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handle(async () => {
              const r = await call<{ token?: string; mfa?: boolean; account_id?: string; choose_account?: NonNullable<typeof choices> }>('POST', '/auth/login', {
                login, password, code: mfa ? code : undefined, account_id: accountId,
              });
              if (r.choose_account) return setChoices(r.choose_account);
              if (r.mfa) return setAccountId(r.account_id), setMfa(true);
              if (r.token) await finish(r.token);
            });
          }}
        >
          {choices && !mfa ? (
            <div className="form-row">
              <label className="label">Several accounts on this email use that password. Pick one:</label>
              <div className="account-choices">
                {choices.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className="account-choice"
                    onClick={() =>
                      handle(async () => {
                        setAccountId(c.id);
                        const r = await call<{ token?: string; mfa?: boolean }>('POST', '/auth/login', { login, password, account_id: c.id });
                        if (r.mfa) return setMfa(true);
                        if (r.token) await finish(r.token);
                      })
                    }
                  >
                    {c.avatar ? <img src={server.url + c.avatar.replace(/#.*$/, '')} alt="" /> : <span className="ac-fallback">{c.username[0]}</span>}
                    <span>
                      <b>{c.display_name ?? c.username}</b>
                      <small>@{c.username}</small>
                    </span>
                  </button>
                ))}
              </div>
              <div className="switch-link"><a onClick={() => (setChoices(null), setAccountId(undefined))}>Back</a></div>
            </div>
          ) : !mfa ? (
            <>
              <Field label="Email or username" error={errors.login ?? errors._} required>
                <input className="input" autoFocus value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" />
              </Field>
              <Field label="Password" error={errors.password} required>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
              <div className="switch-link" style={{ marginTop: -12, marginBottom: 20 }}>
                <a onClick={() => setStep({ ...step, mode: 'forgot' })}>Forgot your password?</a>
              </div>
            </>
          ) : (
            <Field label="Code" error={errors.code ?? errors._} required>
              <input className="input" autoFocus inputMode="numeric" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
          )}
          {!(choices && !mfa) && <button className="btn lg full" disabled={busy}>{busy ? 'Logging in…' : 'Log In'}</button>}
          {!regClosed && !mfa && (
            <div className="switch-link">
              Need an account? <a onClick={() => setStep({ ...step, mode: 'register' })}>Register</a>
            </div>
          )}
          {regClosed && <div className="switch-link">Registration is disabled on this server.</div>}
        </form>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1>Create an account</h1>
      <div className="sub" style={{ marginBottom: 12 }} />
      {header}
      {info.registration === 'allowlist' && <div className="info-box">This server only accepts sign-ups from approved email addresses. Ask an admin to add yours.</div>}
      {info.registration === 'invite_only' && <div className="info-box">You need an invite code from someone on this server to sign up.</div>}
      {message && <div className="info-box">{message}</div>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handle(async () => {
            const r = await call<{ token?: string; verify_email?: boolean }>('POST', '/auth/register', {
              email, username, password, display_name: displayName || undefined, invite: invite.trim().split('/').pop() || undefined,
            });
            if (r.verify_email) {
              setMessage('Check your inbox to verify your email, then log in.');
              setStep({ ...step, mode: 'login' });
              return;
            }
            if (r.token) await finish(r.token);
          });
        }}
      >
        <Field label="Email" error={errors.email} required>
          <input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Display name" error={errors.display_name}>
          <input className="input" value={displayName} maxLength={32} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Username" error={errors.username ?? (username ? usernameProblem(username) ?? undefined : undefined)} required>
          <input className="input" value={username} maxLength={32} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
        </Field>
        <Field label="Password" error={errors.password} required>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <PasswordHint password={password} username={username} />
        </Field>
        {(info.registration === 'invite_only' || invite) && (
          <Field label="Invite code" error={errors.invite} required={info.registration === 'invite_only'}>
            <input className="input" value={invite} onChange={(e) => setInvite(e.target.value)} />
          </Field>
        )}
        {errors._ && <div className="field-error" style={{ marginBottom: 12 }}>{errors._}</div>}
        <button className="btn lg full" disabled={busy}>{busy ? 'Creating…' : 'Continue'}</button>
        <div className="switch-link"><a onClick={() => setStep({ ...step, mode: 'login' })}>Already have an account?</a></div>
      </form>
    </div>
  );
}
