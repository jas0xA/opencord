import { useEffect, useState } from 'react';
import type { Message } from '@opencord/shared';
import { api } from '../lib/api';
import { closeLayers } from './Layers';
import { displayName, findChannel, navigate, openDm, useStore } from '../lib/store';
import { plainText } from '../lib/markdown';
import { formatTimestamp } from '../lib/utils';
import { Avatar } from './Avatar';

/** Recent unread mentions across all channels. */
export function InboxPopout() {
  const readStates = useStore((s) => s.readStates);
  const me = useStore((s) => s.me);
  const [items, setItems] = useState<Message[] | null>(null);
  useEffect(() => {
    const channels = Object.values(readStates).filter((r) => r.mention_count > 0).map((r) => r.channel_id);
    Promise.all(
      channels.slice(0, 10).map((id) => api.get<Message[]>(`/channels/${id}/messages?limit=25`).catch(() => [] as Message[])),
    ).then((lists) => {
      const all = lists.flat().filter((m) => m.author.id !== me?.id && (m.mentions.includes(me?.id ?? '') || m.mention_everyone || !m.guild_id));
      setItems(all.sort((a, b) => b.created_at - a.created_at).slice(0, 30));
    });
  }, []);
  return (
    <div style={{ width: 480, maxHeight: 560, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 16px 12px', fontSize: 20, fontWeight: 700, color: 'var(--text-strong)', borderBottom: '1px solid var(--border-normal)' }}>Inbox</div>
      <div className="scroller thin" style={{ padding: 8 }}>
        {items === null && <div className="empty-state"><div className="spinner" /></div>}
        {items?.length === 0 && <div className="empty-state">You're all caught up! New mentions will show up here.</div>}
        {items?.map((m) => {
          const ch = findChannel(m.channel_id);
          const where = ch?.guild_id ? `#${ch.name} · ${useStore.getState().guilds[ch.guild_id]?.name}` : 'Direct Message';
          return (
            <div
              key={m.id}
              className="dm-item"
              style={{ height: 'auto', padding: 10, alignItems: 'flex-start' }}
              onClick={() => {
                closeLayers();
                if (ch?.guild_id) navigate({ kind: 'guild', guildId: ch.guild_id, channelId: ch.id });
                else openDm(m.channel_id);
              }}
            >
              <Avatar user={m.author} size={32} />
              <div className="dm-text">
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{where} · {formatTimestamp(m.created_at)}</div>
                <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{displayName(m.author, m.guild_id)}</div>
                <div style={{ fontSize: 14, color: 'var(--text-normal)', whiteSpace: 'normal' }}>{plainText(m.content, m.guild_id).slice(0, 200)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
