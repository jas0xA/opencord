import { ChannelType, type Channel, type Message } from '@opencord/shared';
import { cdn } from './api';
import { displayName, navigate, openDm, useStore } from './store';
import { playSound } from './sounds';

export function notifyMessage(m: Message, ch: Channel) {
  const me = useStore.getState().me;
  if (!me) return;
  if (me.settings.notification_sounds) playSound('message');
  window.native?.flash();
  if (!me.settings.desktop_notifications || document.hasFocus()) return;
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
  const author = displayName(m.author, m.guild_id);
  let title = author;
  if (ch.guild_id) {
    const g = useStore.getState().guilds[ch.guild_id];
    title = `${author} (#${ch.name}, ${g?.name ?? ''})`;
  } else if (ch.type === ChannelType.GROUP_DM) {
    title = `${author} (${ch.name ?? 'Group'})`;
  }
  const body = m.content.replace(/<@!?(\d+)>/g, (_, id) => '@' + displayName(useStore.getState().users[id], m.guild_id)) || (m.attachments.length ? 'Uploaded a file' : '');
  const n = new Notification(title, { body: body.slice(0, 200), icon: cdn(m.author.avatar) ?? undefined, silent: true });
  n.onclick = () => {
    window.focus();
    if (ch.guild_id) navigate({ kind: 'guild', guildId: ch.guild_id, channelId: ch.id });
    else openDm(ch.id);
  };
}

export function requestNotificationPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
}
