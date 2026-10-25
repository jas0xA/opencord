import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations';

export type DB = Database.Database;

export function openDatabase(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencord.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function openMemoryDatabase(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DB) {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const current = (db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number | null }).v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i];
    // Table rebuilds need foreign keys off, which SQLite only allows outside a transaction.
    const fk = db.pragma('foreign_keys', { simple: true });
    if (typeof m !== 'string') db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        if (typeof m === 'string') db.exec(m);
        else {
          m(db);
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length) throw new Error(`Migration ${i + 1} broke ${broken.length} foreign key(s)`);
        }
        db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)').run(i + 1, Date.now());
      })();
    } finally {
      if (typeof m !== 'string') db.pragma(`foreign_keys = ${fk ? 'ON' : 'OFF'}`);
    }
  }
}
