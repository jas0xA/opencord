import { Fragment, useState, type ReactNode } from 'react';
import { cdn } from './api';
import { displayName, findChannel, navigate, openModal, useStore } from './store';
import { openExternal } from './web';

interface Ctx {
  guildId: string | null;
  key: number;
}

const INLINE = new RegExp(
  [
    '(`+)([\\s\\S]*?[^`])\\1(?!`)', // 1,2 inline code
    '\\*\\*([\\s\\S]+?)\\*\\*(?!\\*)', // 3 bold
    '__([\\s\\S]+?)__(?!_)', // 4 underline
    '\\*([^\\s*][\\s\\S]*?)\\*(?!\\*)', // 5 italic *
    '\\b_([^_]+?)_\\b', // 6 italic _
    '~~([\\s\\S]+?)~~', // 7 strike
    '\\|\\|([\\s\\S]+?)\\|\\|', // 8 spoiler
    '\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)', // 9,10 masked link
    '<(https?:\\/\\/[^>\\s]+)>', // 11 suppressed link
    '(https?:\\/\\/[^\\s<]+[^\\s<.,;:!?\'")\\]])', // 12 link
    '<@!?(\\d+)>', // 13 user mention
    '<@&(\\d+)>', // 14 role mention
    '<#(\\d+)>', // 15 channel mention
    '<(a)?:(\\w+):(\\d+)>', // 16,17,18 custom emoji
    '(@everyone|@here)', // 19
    '<t:(\\d+)(?::([tTdDfFR]))?>', // 20,21 timestamp
  ].join('|'),
  'g',
);

function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`md-spoiler${open ? ' open' : ''}`} onClick={() => setOpen(true)}>
      {children}
    </span>
  );
}


function Mention({ userId, guildId }: { userId: string; guildId: string | null }) {
  const user = useStore((s) => (s.me?.id === userId ? s.me : s.users[userId]));
  return (
    <span className="md-mention" onClick={() => openModal({ type: 'profile', userId, guildId: guildId ?? undefined })}>
      @{user ? displayName(user, guildId) : 'unknown-user'}
    </span>
  );
}

function formatTs(unix: number, style = 'f') {
  const d = new Date(unix * 1000);
  switch (style) {
    case 't': return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    case 'T': return d.toLocaleTimeString();
    case 'd': return d.toLocaleDateString();
    case 'D': return d.toLocaleDateString([], { dateStyle: 'long' });
    case 'F': return d.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
    case 'R': {
      const diff = (d.getTime() - Date.now()) / 1000;
      const rtf = new Intl.RelativeTimeFormat([], { numeric: 'auto' });
      const abs = Math.abs(diff);
      if (abs < 60) return rtf.format(Math.round(diff), 'second');
      if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
      if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
      return rtf.format(Math.round(diff / 86400), 'day');
    }
    default: return d.toLocaleString([], { dateStyle: 'long', timeStyle: 'short' });
  }
}

function inline(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE.source, 'g');
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = ctx.key++;
    if (m[1]) out.push(<code key={k} className="md-code">{m[2].trim() || m[2]}</code>);
    else if (m[3] !== undefined) out.push(<strong key={k}>{inline(m[3], ctx)}</strong>);
    else if (m[4] !== undefined) out.push(<u key={k}>{inline(m[4], ctx)}</u>);
    else if (m[5] !== undefined) out.push(<em key={k}>{inline(m[5], ctx)}</em>);
    else if (m[6] !== undefined) out.push(<em key={k}>{inline(m[6], ctx)}</em>);
    else if (m[7] !== undefined) out.push(<s key={k}>{inline(m[7], ctx)}</s>);
    else if (m[8] !== undefined) out.push(<Spoiler key={k}>{inline(m[8], ctx)}</Spoiler>);
    else if (m[9] !== undefined) {
      const url = m[10];
      out.push(<a key={k} className="md-link" href={url} title={url} onClick={(e) => (e.preventDefault(), openExternal(url))}>{inline(m[9], ctx)}</a>);
    } else if (m[11] || m[12]) {
      const url = m[11] ?? m[12];
      out.push(<a key={k} className="md-link" href={url} onClick={(e) => (e.preventDefault(), openExternal(url))}>{url}</a>);
    } else if (m[13]) out.push(<Mention key={k} userId={m[13]} guildId={ctx.guildId} />);
    else if (m[14]) {
      const g = ctx.guildId ? useStore.getState().guilds[ctx.guildId] : null;
      const role = g?.roles.find((r) => r.id === m![14]);
      out.push(
        <span key={k} className="md-mention" style={role?.color ? { color: role.color, background: `${role.color}26` } : undefined}>
          @{role?.name ?? 'deleted-role'}
        </span>,
      );
    } else if (m[15]) {
      const ch = findChannel(m[15]);
      out.push(
        <span key={k} className="md-mention" onClick={() => ch?.guild_id && navigate({ kind: 'guild', guildId: ch.guild_id, channelId: ch.id })}>
          #{ch?.name ?? 'unknown'}
        </span>,
      );
    } else if (m[18]) {
      const g = Object.values(useStore.getState().guilds).find((x) => x.emojis.some((e) => e.id === m![18]));
      const e = g?.emojis.find((x) => x.id === m![18]);
      out.push(
        e ? (
          <img key={k} className="md-emoji" src={cdn(e.url)!} alt={`:${m[17]}:`} title={`:${m[17]}:`} draggable={false} />
        ) : (
          `:${m[17]}:`
        ),
      );
    } else if (m[19]) out.push(<span key={k} className="md-mention">{m[19]}</span>);
    else if (m[20]) out.push(<span key={k} className="md-timestamp">{formatTs(Number(m[20]), m[21])}</span>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const EMOJI_ONLY = /^(?:\s|<a?:\w+:\d+>|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*|[\u{1F1E6}-\u{1F1FF}]{2})+$/u;

/** Renders message markdown. */
export function Markdown({ content, guildId = null }: { content: string; guildId?: string | null }) {
  const ctx: Ctx = { guildId, key: 0 };
  const jumbo = content.length <= 200 && EMOJI_ONLY.test(content) && (content.match(/\p{Extended_Pictographic}|<a?:\w+:\d+>/gu)?.length ?? 0) <= 27;
  const blocks: ReactNode[] = [];
  // Split out fenced code blocks first.
  const parts = content.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
      const inner = part.slice(3, -3);
      const nl = inner.indexOf('\n');
      const lang = nl > 0 && /^[\w+-]{1,20}$/.test(inner.slice(0, nl)) ? inner.slice(0, nl) : '';
      const code = lang ? inner.slice(nl + 1) : inner.replace(/^\n/, '');
      blocks.push(<pre key={ctx.key++} className="md-codeblock" data-lang={lang}><code>{code.replace(/\n$/, '')}</code></pre>);
      continue;
    }
    const lines = part.split('\n');
    let quote: string[] = [];
    const flushQuote = () => {
      if (!quote.length) return;
      blocks.push(<blockquote key={ctx.key++} className="md-quote">{renderLines(quote, ctx)}</blockquote>);
      quote = [];
    };
    const normal: string[] = [];
    const flushNormal = () => {
      if (!normal.length) return;
      blocks.push(<Fragment key={ctx.key++}>{renderLines(normal.splice(0), ctx)}</Fragment>);
    };
    for (const line of lines) {
      if (/^>\s/.test(line) || line === '>') {
        flushNormal();
        quote.push(line.replace(/^>\s?/, ''));
      } else {
        flushQuote();
        normal.push(line);
      }
    }
    flushQuote();
    flushNormal();
  }
  return <div className={`md${jumbo ? ' md-jumbo' : ''}`}>{blocks}</div>;
}

function renderLines(lines: string[], ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    const sub = /^-#\s+(.+)$/.exec(line);
    const li = /^\s*[-*]\s+(.+)$/.exec(line);
    if (h) out.push(<div key={ctx.key++} className={`md-h${h[1].length}`}>{inline(h[2], ctx)}</div>);
    else if (sub) out.push(<div key={ctx.key++} className="md-subtext">{inline(sub[1], ctx)}</div>);
    else if (li) out.push(<div key={ctx.key++} className="md-li">{inline(li[1], ctx)}</div>);
    else {
      out.push(<Fragment key={ctx.key++}>{inline(line, ctx)}</Fragment>);
      if (i < lines.length - 1) out.push(<br key={ctx.key++} />);
    }
  });
  return out;
}

/** Plain-text version of message content for previews and notifications. */
export function plainText(content: string, guildId: string | null = null) {
  const s = useStore.getState();
  return content
    .replace(/<@!?(\d+)>/g, (_, id) => '@' + displayName(s.users[id], guildId))
    .replace(/<#(\d+)>/g, (_, id) => '#' + (findChannel(id)?.name ?? 'channel'))
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/[*_~|`]/g, '');
}
