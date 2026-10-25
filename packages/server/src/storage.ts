import type { Attachment } from '@opencord/shared';
import type { Config } from './config';
import type { DB } from './db';
import type { FileStore } from './files';
import type { Hub } from './gateway/hub';
import type { Store } from './store';
import { ApiError, json } from './util';

const GB = 1024 ** 3;
/** Cleanup starts once an upload would take usage past this share of the limit... */
const CLEAN_AT = 0.95;
/** ...and frees space down to this share, so it doesn't run again on every upload. */
const CLEAN_TO = 0.9;

export interface StorageUsage {
  /** Uploaded files: attachments, avatars, emoji, stickers, marketplace items... */
  files: number;
  /** The database (accounts, servers, messages...), counting only pages in use. */
  database: number;
  total: number;
  /** Bytes OpenCord may use in total; 0 = no limit. */
  limit: number;
}

/**
 * Keeps OpenCord inside the storage limit an admin sets ([storage].max_storage_gb).
 *
 * When a new message or upload would bring usage near the limit, it frees space, oldest first:
 * first the files attached to old messages, then old messages themselves (pinned ones last).
 * Accounts, servers, channels, roles, avatars, emoji, stickers and everything else are never
 * deleted; only message history and its media are treated as expendable.
 */
export class StorageManager {
  constructor(
    private db: DB,
    private files: FileStore,
    private config: Config,
    private hub: Hub,
    private store: Store,
  ) {}

  /** Database bytes in use (free pages left behind by deletions are reused, so they don't count). */
  databaseBytes(): number {
    const page = this.db.pragma('page_size', { simple: true }) as number;
    const count = this.db.pragma('page_count', { simple: true }) as number;
    const free = this.db.pragma('freelist_count', { simple: true }) as number;
    return (count - free) * page;
  }

  usage(): StorageUsage {
    const files = this.files.used;
    const database = this.databaseBytes();
    return { files, database, total: files + database, limit: Math.round(this.config.storage.max_storage_gb * GB) };
  }

  /**
   * Makes room for `incoming` more bytes. If that would bring usage near the limit, deletes old
   * message media and then old messages. Throws 507 if there still isn't room.
   */
  ensureSpace(incoming: number) {
    const { total, limit } = this.usage();
    if (!limit || total + incoming <= limit * CLEAN_AT) return;
    const target = limit * CLEAN_TO - incoming;
    const freed = this.cleanup(target);
    const after = this.usage().total;
    if (freed.media || freed.messages) {
      console.warn(
        `[storage] near the ${fmt(limit)} limit: removed media from ${freed.media} and deleted ${freed.messages} old message(s); now using ${fmt(after)}`,
      );
    }
    if (after + incoming > limit) {
      throw new ApiError(507, "This server is out of storage space. Ask its admin to raise the storage limit.", 40007);
    }
  }

  /** Frees space until usage is at or below `target` bytes, or nothing expendable is left. */
  private cleanup(target: number) {
    const freed = { media: 0, messages: 0 };
    const touched = new Set<string>();
    const over = () => this.usage().total > target;

    // 1. Files attached to the oldest messages. A message with nothing else in it goes entirely.
    const withMedia = this.db.prepare(
      "SELECT id, channel_id, guild_id, content, attachments, sticker_ids FROM messages WHERE attachments != '[]' ORDER BY pinned ASC, CAST(id AS INTEGER) ASC LIMIT 50",
    );
    const strip = this.db.prepare("UPDATE messages SET attachments = '[]' WHERE id = ?");
    const del = this.db.prepare('DELETE FROM messages WHERE id = ?');
    while (over()) {
      const rows = withMedia.all() as any[];
      if (!rows.length) break;
      const updated = new Map<string, { channel: string; guild: string | null; ids: string[]; deleted: string[] }>();
      for (const m of rows) {
        for (const a of json<Attachment[]>(m.attachments, [])) this.files.remove(a.url.replace(/^\/uploads\//, ''));
        const entry = updated.get(m.channel_id) ?? { channel: m.channel_id as string, guild: m.guild_id as string | null, ids: [] as string[], deleted: [] as string[] };
        if (!m.content && m.sticker_ids === '[]') {
          del.run(m.id);
          entry.deleted.push(m.id);
          freed.messages++;
        } else {
          strip.run(m.id);
          entry.ids.push(m.id);
          freed.media++;
        }
        updated.set(m.channel_id, entry);
        touched.add(m.channel_id);
      }
      for (const u of updated.values()) {
        if (u.deleted.length) this.hub.toChannel(u.channel, 'MESSAGE_DELETE_BULK', { ids: u.deleted, channel_id: u.channel, guild_id: u.guild });
        for (const id of u.ids) this.hub.toChannel(u.channel, 'MESSAGE_UPDATE', (uid) => this.store.message(this.store.messageRow(id), uid));
      }
    }

    // 2. Last resort: the oldest messages themselves.
    const oldest = this.db.prepare('SELECT id, channel_id, guild_id FROM messages ORDER BY pinned ASC, CAST(id AS INTEGER) ASC LIMIT 500');
    while (over()) {
      const rows = oldest.all() as { id: string; channel_id: string; guild_id: string | null }[];
      if (!rows.length) break;
      const byChannel = new Map<string, { guild: string | null; ids: string[] }>();
      this.db.transaction(() => {
        for (const m of rows) {
          del.run(m.id);
          const entry = byChannel.get(m.channel_id) ?? { guild: m.guild_id, ids: [] as string[] };
          entry.ids.push(m.id);
          byChannel.set(m.channel_id, entry);
          touched.add(m.channel_id);
        }
      })();
      freed.messages += rows.length;
      for (const [cid, e] of byChannel) this.hub.toChannel(cid, 'MESSAGE_DELETE_BULK', { ids: e.ids, channel_id: cid, guild_id: e.guild });
    }

    // Channels whose latest message was removed point at the newest one left.
    const last = this.db.prepare('SELECT id FROM messages WHERE channel_id = ? ORDER BY CAST(id AS INTEGER) DESC LIMIT 1');
    const setLast = this.db.prepare('UPDATE channels SET last_message_id = ? WHERE id = ?');
    for (const cid of touched) setLast.run((last.get(cid) as { id: string } | undefined)?.id ?? null, cid);
    return freed;
  }
}

export function fmt(bytes: number) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
