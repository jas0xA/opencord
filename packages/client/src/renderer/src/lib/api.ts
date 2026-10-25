import { API_PREFIX, DEFAULT_PORT, type InstanceInfo } from '@opencord/shared';

let baseUrl = '';
let authToken = '';

export function configureApi(base: string, token: string) {
  baseUrl = base.replace(/\/+$/, '');
  authToken = token;
}
export const getBaseUrl = () => baseUrl;
export const getToken = () => authToken;

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 0, public errors: Record<string, string> = {}) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, base = baseUrl, token = authToken): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = token;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${base}${API_PREFIX}${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.message ?? `Request failed (${res.status})`, data?.code ?? 0, data?.errors ?? {});
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T = any>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  put: <T = any>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  del: <T = any>(p: string) => request<T>('DELETE', p),
  raw: request,
};

/** Resolves a server-relative path (e.g. /uploads/avatars/1.png) to an absolute URL. */
export function cdn(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^(https?:|data:|blob:|builtin:)/.test(path)) return path;
  return `${baseUrl}${path}`;
}

/** Turns what a user typed ("chat.example.com", "1.2.3.4:8443", "https://...") into a working base URL. */
export async function resolveServer(input: string): Promise<{ url: string; info: InstanceInfo }> {
  const raw = input.trim().replace(/\/+$/, '');
  if (!raw) throw new ApiError(0, 'Enter a server address.');
  const candidates: string[] = [];
  if (/^https?:\/\//i.test(raw)) candidates.push(raw);
  else {
    const hasPort = /:\d+$/.test(raw);
    const isIp = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(raw) || raw.startsWith('localhost') || raw.startsWith('[');
    if (isIp) candidates.push(`http://${raw}`, `https://${raw}`);
    else candidates.push(`https://${raw}`, `http://${raw}`);
    if (!hasPort) candidates.push(`http://${raw}:${DEFAULT_PORT}`, `https://${raw}:${DEFAULT_PORT}`);
  }
  for (const url of candidates) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${url}${API_PREFIX}/instance`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const info = (await res.json()) as InstanceInfo;
        if (info && typeof info.registration === 'string') return { url, info };
      }
    } catch {
      /* try next */
    }
  }
  throw new ApiError(0, "Couldn't find an OpenCord server at that address.");
}

export function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function pickFile(accept = 'image/*', multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.click();
  });
}
