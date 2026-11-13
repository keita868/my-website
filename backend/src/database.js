import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDirectory = path.resolve(process.env.CMS_DATA_DIR || path.join(backendDirectory, 'data'));

mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
chmodSync(dataDirectory, 0o700);
process.umask(0o077);

export const database = new Database(path.join(dataDirectory, 'cms.sqlite'));
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
database.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const migrationDirectory = path.resolve(backendDirectory, 'migrations');
for (const migrationName of readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort()) {
  const applied = database.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(migrationName);
  if (applied) continue;

  const migration = readFileSync(path.join(migrationDirectory, migrationName), 'utf8');
  database.transaction(() => {
    database.exec(migration);
    database.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migrationName);
  })();
}

chmodSync(path.join(dataDirectory, 'cms.sqlite'), 0o600);
