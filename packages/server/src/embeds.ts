import dns from 'node:dns/promises';
import net from 'node:net';
import type { Embed } from '@opencord/shared';

const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/gi;

export function extractUrls(content: string): string[] {
  // Links wrapped in <...> are explicitly un-embedded.
  const stripped = content.replace(/<https?:\/\/[^>]+>/g, '');
  return [...new Set(stripped.match(URL_RE) ?? [])].slice(0, 5);
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && isPrivateIp(v.slice(7));
}

function decode(s: string) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function meta(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  if (!tag) return undefined;
  const c = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return c ? decode(c).trim() : undefined;
}

/** Fetches OpenGraph metadata for a URL. Never touches private network addresses. */
export async function fetchEmbed(url: string, timeoutMs: number): Promise<Embed | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  try {
    const { address } = await dns.lookup(u.hostname);
    if (isPrivateIp(address)) return null;
  } catch {
    return null;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(u, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OpenCordBot/0.1; +https://github.com/opencord)', Accept: 'text/html,image/*' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type.startsWith('image/')) return { type: 'image', url, image: { url } };
    if (!type.includes('html')) return null;
    // Only read the head of the document.
    const reader = res.body!.getReader();
    let html = '';
    while (html.length < 256 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      if (html.includes('</head>')) break;
    }
    reader.cancel().catch(() => {});
    const title = meta(html, 'og:title') ?? meta(html, 'twitter:title') ?? decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').trim();
    const description = meta(html, 'og:description') ?? meta(html, 'twitter:description') ?? meta(html, 'description');
    const image = meta(html, 'og:image') ?? meta(html, 'twitter:image');
    const siteName = meta(html, 'og:site_name');
    const color = meta(html, 'theme-color');
    if (!title && !description) return null;
    const abs = (s?: string) => (s ? new URL(s, u).toString() : undefined);
    return {
      type: 'link',
      url,
      title: title?.slice(0, 256),
      description: description?.slice(0, 350),
      site_name: siteName?.slice(0, 100),
      color,
      thumbnail: image ? { url: abs(image)! } : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
