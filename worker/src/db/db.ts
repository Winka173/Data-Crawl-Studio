import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { log } from '../log';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations';

export type DB = Database.Database;

export interface OpenResult {
  db: DB;
  fromVersion: number;
  toVersion: number;
  backupPath: string | null;
}

export function openDatabase(dbPath: string, backupsDir: string, migrations: Migration[] = MIGRATIONS): OpenResult {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const existed = fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const fromVersion = db.pragma('user_version', { simple: true }) as number;
  const target = migrations.length ? migrations[migrations.length - 1]!.version : 0;
  if (fromVersion > target) {
    db.close();
    throw new Error(`Database schema v${fromVersion} is newer than this app (v${target}). Update the app.`);
  }

  let backupPath: string | null = null;
  const pending = migrations.filter((m) => m.version > fromVersion);
  if (pending.length && existed && fromVersion > 0) {
    backupPath = backupBeforeMigration(db, backupsDir, fromVersion);
  }
  for (const m of pending) {
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    apply();
    log.info('schema migrated', { version: m.version, name: m.name });
  }
  return { db, fromVersion, toVersion: target, backupPath };
}

/** Full, consistent copy of the database taken before any schema change. */
function backupBeforeMigration(db: DB, backupsDir: string, fromVersion: number): string {
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(backupsDir, `datacrawl-v${fromVersion}-${stamp}.db`);
  db.pragma('wal_checkpoint(TRUNCATE)');
  // VACUUM INTO writes a complete, consistent copy and is synchronous, unlike db.backup().
  db.prepare('VACUUM INTO ?').run(file);
  log.info('database backed up before migration', { file, fromVersion });
  return file;
}

export { LATEST_SCHEMA_VERSION };
