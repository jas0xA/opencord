// Global OpenCord network helpers: status of this host's membership, the shared directory, and
// "visiting" another host by signing in there with your home account.
import { useEffect, useState } from 'react';
import { api, ApiError, resolveServer } from './api';
import { loadAccounts, saveAccounts, startSession, useStore, type SavedServer } from './store';

export interface NetworkStatus {
  enabled: boolean;
  origin?: string;
  help_host?: boolean;
  hosts?: number;
  records?: number;
  peers?: number;
}

let cached: { url: string; status: NetworkStatus } | null = null;

/** This host's network status (cached per server). */
export function useNetwork(): NetworkStatus | null {
  const url = useStore((s) => s.server?.url);
  const [status, setStatus] = useState<NetworkStatus | null>(cached && cached.url === url ? cached.status : null);
  useEffect(() => {
    if (!url || cached?.url === url) return;
    api
      .get<NetworkStatus>('/federation/client/status')
      .then((s) => ((cached = { url, status: s }), setStatus(s)))
      .catch(() => setStatus({ enabled: false }));
  }, [url]);
  return status;
}

export interface DirectoryEntry {
  key: string;
  host: string;
  local: boolean;
  ts: number;
  [k: string]: any;
}

export function directory(kind: 'guild' | 'item' | 'theme' | 'host', q?: string) {
  return api.get<DirectoryEntry[]>(`/federation/client/directory/${kind}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
}

/**
 * Signs in to another host with the current (home) account and switches to it. `then` runs against
 * the other host's API before switching, e.g. to accept an invite.
 */
export async function visitHost(origin: string, then?: (call: <T>(method: string, path: string, body?: unknown) => Promise<T>) => Promise<unknown>) {
  const { assertion } = await api.post<{ assertion: string }>('/federation/client/assertion', { audience: origin });
  const { url, info } = await resolveServer(origin);
  const login = await api.raw<{ token: string }>('POST', '/federation/login', { assertion }, url, '');
  if (!login?.token) throw new ApiError(0, 'Could not sign in to that server.');
  if (then) await then((method, path, body) => api.raw(method, path, body, url, login.token));
  const accounts = await loadAccounts();
  const existing = accounts.servers.find((s) => s.url === url);
  const server: SavedServer = { ...(existing ?? { url, name: info.name, username: null, avatar: null }), name: info.name, token: login.token };
  accounts.servers = existing ? accounts.servers.map((s) => (s.url === url ? server : s)) : [...accounts.servers, server];
  accounts.last = url;
  await saveAccounts(accounts);
  await startSession(server, info);
}
