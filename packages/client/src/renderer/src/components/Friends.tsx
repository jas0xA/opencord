import { useState } from 'react';
import { Check, MessageCircle, MoreVertical, Search, X } from 'lucide-react';
import { RelationshipType, type Relationship } from '@opencord/shared';
import { api } from '../lib/api';
import { displayName, openDmWith, openModal, statusOf, toast, useStore } from '../lib/store';
import { voice } from '../lib/voice';
import { Avatar } from './Avatar';
import { FriendsIcon, STATUS_LABEL } from './Icons';
import { openContextMenu, Tooltip } from './Layers';
import { copy } from '../lib/utils';

type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

function FriendRow({ rel }: { rel: Relationship }) {
  const presence = useStore((s) => s.presences[rel.id]);
  const user = useStore((s) => s.users[rel.id]) ?? rel.user;
  const status = statusOf(rel.id);
  const sub =
    rel.type === RelationshipType.INCOMING
      ? 'Incoming Friend Request'
      : rel.type === RelationshipType.OUTGOING
        ? 'Outgoing Friend Request'
        : rel.type === RelationshipType.BLOCKED
          ? 'Blocked'
          : presence?.custom_status?.text ?? (presence?.activities[0] ? `Playing ${presence.activities[0].name}` : STATUS_LABEL[status]);
  const remove = () => api.del(`/users/@me/relationships/${rel.id}`).catch((e) => toast(e.message));
  const accept = () => api.put(`/users/@me/relationships/${rel.id}`).catch((e) => toast(e.message));
  return (
    <div className="friend-row" onClick={() => rel.type === RelationshipType.FRIEND && openDmWith(rel.id)} onContextMenu={(e) => menu(e, rel)}>
      <Avatar user={user} size={32} status={rel.type === RelationshipType.FRIEND ? true : undefined} ring="var(--bg-chat)" />
      <div className="fr-text">
        <div className="fr-name">
          {displayName(user)}
          <span className="fr-user">{user.username}</span>
        </div>
        <div className="fr-sub">{sub}</div>
      </div>
      <div className="fr-actions" onClick={(e) => e.stopPropagation()}>
        {rel.type === RelationshipType.FRIEND && (
          <>
            <Tooltip text="Message">
              <button className="round-btn" onClick={() => openDmWith(rel.id)}><MessageCircle size={20} /></button>
            </Tooltip>
            <Tooltip text="More">
              <button className="round-btn" onClick={(e) => menu(e, rel)}><MoreVertical size={20} /></button>
            </Tooltip>
          </>
        )}
        {rel.type === RelationshipType.INCOMING && (
          <>
            <Tooltip text="Accept">
              <button className="round-btn accept" onClick={accept}><Check size={20} /></button>
            </Tooltip>
            <Tooltip text="Ignore">
              <button className="round-btn deny" onClick={remove}><X size={20} /></button>
            </Tooltip>
          </>
        )}
        {rel.type === RelationshipType.OUTGOING && (
          <Tooltip text="Cancel">
            <button className="round-btn deny" onClick={remove}><X size={20} /></button>
          </Tooltip>
        )}
        {rel.type === RelationshipType.BLOCKED && (
          <Tooltip text="Unblock">
            <button className="round-btn deny" onClick={remove}><X size={20} /></button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function menu(e: React.MouseEvent, rel: Relationship) {
  openContextMenu(e, [
    { label: 'Profile', onClick: () => openModal({ type: 'profile', userId: rel.id }) },
    rel.type === RelationshipType.FRIEND && { label: 'Message', onClick: () => openDmWith(rel.id) },
    rel.type === RelationshipType.FRIEND && {
      label: 'Start Voice Call',
      onClick: async () => {
        await openDmWith(rel.id);
        const r = useStore.getState().route;
        if (r.kind === 'home' && r.channelId) voice.join(r.channelId, null);
      },
    },
    { separator: true },
    rel.type === RelationshipType.FRIEND && { label: 'Remove Friend', danger: true, onClick: () => api.del(`/users/@me/relationships/${rel.id}`) },
    rel.type !== RelationshipType.BLOCKED && { label: 'Block', danger: true, onClick: () => api.put(`/users/@me/relationships/${rel.id}`, { type: 2 }) },
    useStore.getState().me?.settings.developer_mode && { label: 'Copy User ID', onClick: () => copy(rel.id) },
  ]);
}

function AddFriend() {
  const [value, setValue] = useState('');
  const [state, setState] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const username = value.trim();
    if (!username) return;
    try {
      await api.post('/users/@me/relationships', { username });
      setState({ kind: 'success', text: `Success! Your friend request to ${username} was sent.` });
      setValue('');
    } catch (err: any) {
      setState({ kind: 'error', text: err.message });
    }
  };
  return (
    <div className="add-friend">
      <h2>Add Friend</h2>
      <p>You can add friends with their username, or <b>name@host</b> for someone on another OpenCord server.</p>
      <form className={state?.kind ?? ''} onSubmit={submit}>
        <input autoFocus placeholder="username or name@chat.example.com" value={value} onChange={(e) => (setValue(e.target.value), setState(null))} />
        <button className="btn sm" disabled={!value.trim()}>Send Friend Request</button>
      </form>
      {state && <div className={`msg ${state.kind}`}>{state.text}</div>}
    </div>
  );
}

function ActiveNow() {
  const relationships = useStore((s) => s.relationships);
  const presences = useStore((s) => s.presences);
  const voiceStates = useStore((s) => s.voiceStates);
  const guilds = useStore((s) => s.guilds);
  const active = Object.values(relationships).filter(
    (r) => r.type === RelationshipType.FRIEND && (presences[r.id]?.activities.length || voiceStates[r.id]),
  );
  return (
    <div className="active-now scroller thin">
      <h2>Active Now</h2>
      {active.length === 0 ? (
        <div className="an-empty">
          <h3>It's quiet for now...</h3>
          <p>When a friend starts an activity—like playing a game or hanging out on voice—we'll show it here!</p>
        </div>
      ) : (
        active.map((r) => {
          const v = voiceStates[r.id];
          const g = v?.guild_id ? guilds[v.guild_id] : null;
          const ch = g?.channels.find((c) => c.id === v?.channel_id);
          const act = presences[r.id]?.activities[0];
          return (
            <div key={r.id} className="active-card" onClick={() => openModal({ type: 'profile', userId: r.id })}>
              <Avatar user={r.user} size={40} status ring="var(--bg-chat)" />
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{displayName(r.user)}</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{v ? `In voice${ch ? `: ${ch.name}` : ''}${g ? ` — ${g.name}` : ''}` : act ? `Playing ${act.name}` : ''}</div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export function FriendsPage() {
  const [tab, setTab] = useState<Tab>('online');
  const [q, setQ] = useState('');
  const relationships = useStore((s) => s.relationships);
  useStore((s) => s.presences);
  const all = Object.values(relationships);
  const pendingCount = all.filter((r) => r.type === RelationshipType.INCOMING).length;
  const list = all
    .filter((r) => {
      if (tab === 'online') return r.type === RelationshipType.FRIEND && statusOf(r.id) !== 'offline';
      if (tab === 'all') return r.type === RelationshipType.FRIEND;
      if (tab === 'pending') return r.type === RelationshipType.INCOMING || r.type === RelationshipType.OUTGOING;
      if (tab === 'blocked') return r.type === RelationshipType.BLOCKED;
      return false;
    })
    .filter((r) => !q || r.user.username.includes(q.toLowerCase()) || displayName(r.user).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => displayName(a.user).localeCompare(displayName(b.user)));
  const label = { online: 'Online', all: 'All friends', pending: 'Pending', blocked: 'Blocked', add: '' }[tab];

  return (
    <div className="main">
      <div className="chat-header friends-header">
        <div className="ch-title">
          <FriendsIcon size={24} style={{ color: 'var(--text-muted)' }} />
          Friends
        </div>
        <div className="sep" />
        <div className="tabs">
          {(['online', 'all', 'pending', 'blocked'] as Tab[]).map((t) => (
            <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t === 'all' ? 'All' : t[0].toUpperCase() + t.slice(1)}
              {t === 'pending' && pendingCount > 0 && <span className="badge-count">{pendingCount}</span>}
            </button>
          ))}
          <button className={`tab add${tab === 'add' ? ' active' : ''}`} onClick={() => setTab('add')}>Add Friend</button>
        </div>
      </div>
      <div className="friends-body">
        <div className="friends-list" style={tab === 'add' ? { padding: 0 } : undefined}>
          {tab === 'add' ? (
            <AddFriend />
          ) : (
            <>
              <div className="friends-search">
                <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
                <Search size={18} color="var(--text-muted)" />
              </div>
              <div className="friends-count">{label} — {list.length}</div>
              <div className="scroller thin" style={{ flex: 1, marginRight: -16, paddingRight: 8 }}>
                {list.map((r) => <FriendRow key={r.id} rel={r} />)}
                {list.length === 0 && (
                  <div className="empty-state" style={{ marginTop: 60 }}>
                    {tab === 'online' ? "No one's around right now. Add some friends or check back later!" : tab === 'pending' ? 'There are no pending friend requests.' : tab === 'blocked' ? "You haven't blocked anyone." : 'No friends yet — add some with their username.'}
                    {tab !== 'blocked' && <button className="btn" onClick={() => setTab('add')}>Add Friend</button>}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <ActiveNow />
      </div>
    </div>
  );
}
