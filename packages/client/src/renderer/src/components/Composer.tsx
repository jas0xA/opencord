import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CirclePlus, Smile, Sticker, X, FileText, Trash2 } from 'lucide-react';
import { ChannelType, Permissions, type Message } from '@opencord/shared';
import { api, cdn } from '../lib/api';
import { searchEmoji, replaceShortcodes } from '../lib/emoji';
import {
  can, displayName, findChannel, sendMessage, setReplying, toast, useStore,
} from '../lib/store';
import { formatBytes } from '../lib/utils';
import { Avatar } from './Avatar';
import { HashIcon } from './Icons';
import { closeLayers, openPopout, Tooltip } from './Layers';
import { EmojiPicker, StickerPicker } from './Pickers';

const drafts = new Map<string, string>();
const fileSinks = new Map<string, (files: File[]) => void>();

/** Drops files over the server's per-file limit (with a toast) and keeps at most 10. */
function withinLimit(cur: File[], added: File[]) {
  const maxMb = useStore.getState().instance?.max_upload_mb ?? 25;
  const ok = added.filter((f) => f.size <= maxMb * 1024 * 1024);
  if (ok.length < added.length) toast(`Files must be smaller than ${maxMb} MB`);
  return [...cur, ...ok].slice(0, 10);
}

/** Lets the chat view hand dropped/pasted files to the active composer. */
export function addFilesToComposer(channelId: string, files: File[]) {
  fileSinks.get(channelId)?.(files);
}

interface AcItem {
  key: string;
  label: React.ReactNode;
  sub?: string;
  insert: string;
}

export function Composer({ channelId, editing }: { channelId: string; editing?: Message }) {
  const channel = useStore(() => findChannel(channelId));
  const me = useStore((s) => s.me);
  const replying = useStore((s) => (editing ? null : s.replyingTo[channelId] ?? null));
  const guild = useStore((s) => (channel?.guild_id ? s.guilds[channel.guild_id] : null));
  const [text, setText] = useState(() => (editing ? editing.content : drafts.get(channelId) ?? ''));
  const [files, setFiles] = useState<File[]>([]);
  const [ac, setAc] = useState<{ items: AcItem[]; index: number; start: number; title: string } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);

  useEffect(() => {
    if (editing) return;
    setText(drafts.get(channelId) ?? '');
    setFiles([]);
    fileSinks.set(channelId, (f) => setFiles((cur) => withinLimit(cur, f)));
    ref.current?.focus();
    return () => {
      fileSinks.delete(channelId);
    };
  }, [channelId, editing]);

  useEffect(() => {
    if (replying) ref.current?.focus();
  }, [replying]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.5)}px`;
  }, [text]);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.setSelectionRange(text.length, text.length);
    }
  }, []);

  if (!channel) return null;

  const isDm = channel.type === ChannelType.DM;
  const other = isDm ? channel.recipients?.find((r) => r.id !== me?.id) : null;
  const placeholder = isDm
    ? `Message @${displayName(other)}`
    : channel.type === ChannelType.GROUP_DM
      ? `Message ${channel.name || (channel.recipients ?? []).filter((r) => r.id !== me?.id).map((r) => displayName(r)).join(', ')}`
      : `Message #${channel.name}`;

  const timedOut = guild?.members.find((m) => m.user.id === me?.id)?.communication_disabled_until;
  const canSend = !channel.guild_id || can(Permissions.SEND_MESSAGES, channel.guild_id, channel.id);
  const canAttach = !channel.guild_id || can(Permissions.ATTACH_FILES, channel.guild_id, channel.id);
  const blocked = isDm && other && useStore.getState().relationships[other.id]?.type === 2;

  if (!editing && (!canSend || blocked)) {
    return (
      <div className="composer">
        <div className="composer-blocked">
          {blocked
            ? 'You cannot send messages to a user you have blocked.'
            : timedOut && timedOut > Date.now()
              ? `You are timed out until ${new Date(timedOut).toLocaleString()}.`
              : 'You do not have permission to send messages in this channel.'}
        </div>
      </div>
    );
  }

  const updateAutocomplete = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)([@#:])([^\s@#:]*)$/.exec(before);
    if (!m) return setAc(null);
    const [, , trigger, query] = m;
    const start = caret - query.length - 1;
    const q = query.toLowerCase();
    let items: AcItem[] = [];
    let title = '';
    if (trigger === '@') {
      title = 'Members';
      const users = guild
        ? guild.members.map((x) => x.user)
        : (channel.recipients ?? []);
      items = users
        .filter((u) => u.username.includes(q) || displayName(u, guild?.id).toLowerCase().includes(q))
        .slice(0, 10)
        .map((u) => ({ key: u.id, label: <><Avatar user={u} size={24} decoration={false} /> {displayName(u, guild?.id)}</>, sub: u.username, insert: `<@${u.id}> ` }));
      if (guild) {
        items.push(
          ...guild.roles
            .filter((r) => r.id !== guild.id && r.name.toLowerCase().includes(q) && (r.mentionable || can(Permissions.MENTION_EVERYONE, guild.id)))
            .slice(0, 5)
            .map((r) => ({ key: r.id, label: <span style={{ color: r.color ?? undefined }}>@{r.name}</span>, sub: 'Role', insert: `<@&${r.id}> ` })),
        );
        if (can(Permissions.MENTION_EVERYONE, guild.id)) {
          for (const e of ['everyone', 'here']) if (e.startsWith(q)) items.push({ key: e, label: `@${e}`, sub: e === 'here' ? 'Notify online members' : 'Notify everyone', insert: `@${e} ` });
        }
      }
    } else if (trigger === '#' && guild) {
      title = 'Text Channels';
      items = guild.channels
        .filter((c) => c.type === ChannelType.GUILD_TEXT && c.name?.includes(q))
        .slice(0, 10)
        .map((c) => ({ key: c.id, label: <><HashIcon size={18} /> {c.name}</>, insert: `<#${c.id}> ` }));
    } else if (trigger === ':' && q.length >= 2) {
      title = `Emoji matching :${q}`;
      const custom = Object.values(useStore.getState().guilds)
        .flatMap((g) => g.emojis)
        .filter((e) => e.name.toLowerCase().includes(q))
        .slice(0, 5)
        .map((e) => ({ key: e.id, label: <><img src={cdn(e.url)!} width={22} height={22} alt="" /> :{e.name}:</>, insert: `<:${e.name}:${e.id}> ` }));
      items = [...custom, ...searchEmoji(q, 10).map(([n, e]) => ({ key: n, label: <><span style={{ fontSize: 20 }}>{e}</span> :{n}:</>, insert: `${e} ` }))];
    }
    setAc(items.length ? { items, index: 0, start, title } : null);
  };

  const applyAc = (item: AcItem) => {
    const el = ref.current!;
    const caret = el.selectionStart;
    const next = text.slice(0, ac!.start) + item.insert + text.slice(caret);
    setText(next);
    setAc(null);
    requestAnimationFrame(() => {
      const pos = ac!.start + item.insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const insertAtCaret = (s: string) => {
    const el = ref.current;
    const pos = el?.selectionStart ?? text.length;
    const next = text.slice(0, pos) + s + text.slice(pos);
    setText(next);
    if (!editing) drafts.set(channelId, next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos + s.length, pos + s.length);
    });
  };

  const submit = async () => {
    const content = replaceShortcodes(text.trim());
    if (editing) {
      if (!content) return;
      if (content !== editing.content) await api.patch(`/channels/${channelId}/messages/${editing.id}`, { content }).catch((e) => toast(e.message));
      useStore.setState({ editing: null });
      return;
    }
    if (!content && !files.length) return;
    const toSend = files;
    setText('');
    setFiles([]);
    drafts.delete(channelId);
    await sendMessage(channelId, content, toSend);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (ac) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setAc({ ...ac, index: (ac.index + d + ac.items.length) % ac.items.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyAc(ac.items[ac.index]);
        return;
      }
      if (e.key === 'Escape') {
        setAc(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape') {
      if (editing) useStore.setState({ editing: null });
      else if (replying) setReplying(channelId, null);
      return;
    }
    if (e.key === 'ArrowUp' && !text && !editing) {
      const list = useStore.getState().messages[channelId]?.list ?? [];
      const last = [...list].reverse().find((m) => m.author.id === me?.id && (m.type === 0 || m.type === 19));
      if (last) {
        e.preventDefault();
        useStore.setState({ editing: { channelId, messageId: last.id } });
      }
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    if (!editing) drafts.set(channelId, e.target.value);
    updateAutocomplete(e.target.value, e.target.selectionStart);
    if (!editing && e.target.value && Date.now() - lastTyping.current > 8000) {
      lastTyping.current = Date.now();
      api.post(`/channels/${channelId}/typing`).catch(() => {});
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (editing || !canAttach) return;
    const pasted = [...e.clipboardData.files];
    if (pasted.length) {
      e.preventDefault();
      setFiles((cur) => withinLimit(cur, pasted));
    }
  };

  const pickFiles = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => input.files && setFiles((cur) => withinLimit(cur, [...input.files!]));
    input.click();
  };

  return (
    <div className="composer" style={editing ? { padding: 0 } : undefined}>
      {ac && (
        <div className="autocomplete">
          <div className="ac-title">{ac.title}</div>
          {ac.items.map((it, i) => (
            <div key={it.key} className={`ac-item${i === ac.index ? ' sel' : ''}`} onMouseEnter={() => setAc({ ...ac, index: i })} onMouseDown={(e) => (e.preventDefault(), applyAc(it))}>
              {it.label}
              {it.sub && <span className="ac-sub">{it.sub}</span>}
            </div>
          ))}
        </div>
      )}
      {!editing && <UploadProgress channelId={channelId} />}
      <div className="composer-box">
        {replying && (
          <div className="composer-reply">
            Replying to&nbsp;<b>{displayName(replying.author, replying.guild_id)}</b>
            <button onClick={() => setReplying(channelId, null)}><X size={16} /></button>
          </div>
        )}
        {files.length > 0 && (
          <div className="composer-uploads scroller thin">
            {files.map((f, i) => (
              <UploadTile key={i} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
        <div className="composer-row">
          {!editing ? (
            <Tooltip text={canAttach ? 'Upload a File' : 'You cannot attach files here'}>
              <button className="attach-btn" onClick={() => canAttach && pickFiles()} style={!canAttach ? { opacity: 0.4 } : undefined}>
                <CirclePlus size={24} />
              </button>
            </Tooltip>
          ) : (
            <div style={{ width: 16 }} />
          )}
          <textarea
            ref={ref}
            className="composer-input"
            rows={1}
            value={text}
            placeholder={editing ? '' : placeholder}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => setTimeout(() => setAc(null), 100)}
            onSelect={(e) => updateAutocomplete(text, (e.target as HTMLTextAreaElement).selectionStart)}
            maxLength={4000}
            spellCheck
          />
          <div className="composer-tools">
            {!editing && (
              <Tooltip text="Open sticker picker">
                <button onClick={(e) => openPopout(e.currentTarget.getBoundingClientRect(), `stickers-${channelId}`, () => <StickerPicker onPick={(id) => (closeLayers(), sendMessage(channelId, '', [], [id]))} />, 'top')}>
                  <Sticker size={22} />
                </button>
              </Tooltip>
            )}
            <Tooltip text="Select emoji">
              <button
                onClick={(e) =>
                  openPopout(
                    e.currentTarget.getBoundingClientRect(),
                    `emoji-${channelId}`,
                    () => <EmojiPicker onPick={(p) => insertAtCaret('unicode' in p ? p.unicode : `<:${p.custom.name}:${p.custom.id}>`)} />,
                    'top',
                  )
                }
              >
                <Smile size={22} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      {editing && (
        <div className="edit-hint">
          escape to <a onClick={() => useStore.setState({ editing: null })}>cancel</a> • enter to <a onClick={submit}>save</a>
        </div>
      )}
    </div>
  );
}

function UploadTile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return (
    <div className="upload-tile">
      <div className="ut-preview">{url ? <img src={url} alt="" /> : <FileText size={64} color="var(--text-muted)" />}</div>
      <div className="ut-name">{file.name}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{formatBytes(file.size)}</div>
      <button className="ut-remove" onClick={onRemove}><Trash2 size={16} /></button>
    </div>
  );
}

/** Files on their way to the server for this channel, with a cancel button. */
function UploadProgress({ channelId }: { channelId: string }) {
  const all = useStore((s) => s.uploads);
  const uploads = Object.entries(all).filter(([, u]) => u.channelId === channelId);
  if (!uploads.length) return null;
  return (
    <>
      {uploads.map(([nonce, u]) => {
        const pct = u.total ? Math.round((u.loaded / u.total) * 100) : 0;
        return (
          <div key={nonce} className="upload-progress">
            <FileText size={20} />
            <div className="up-main">
              <div className="up-name">
                <span>{u.names.length > 1 ? `${u.names.length} files` : u.names[0]}</span>
                <span className="up-pct">{pct < 100 ? `${formatBytes(u.loaded)} / ${formatBytes(u.total)}` : 'Processing…'}</span>
              </div>
              <div className="up-bar"><i style={{ width: `${pct}%` }} /></div>
            </div>
            <Tooltip text="Cancel upload">
              <button className="icon-btn" aria-label="Cancel upload" onClick={u.abort}><X size={16} /></button>
            </Tooltip>
          </div>
        );
      })}
    </>
  );
}
