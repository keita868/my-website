import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import session from 'express-session';
import Database from 'better-sqlite3';
import { dataDirectory } from './database.js';

const sessionDatabasePath = path.join(dataDirectory, 'sessions.sqlite');
const sessionDatabaseExisted = existsSync(sessionDatabasePath);
const database = new Database(sessionDatabasePath, { timeout: 5000 });
if (!sessionDatabaseExisted) chmodSync(sessionDatabasePath, 0o600);
database.pragma('journal_mode = WAL');
database.pragma('synchronous = NORMAL');
database.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    expired INTEGER NOT NULL,
    sess TEXT NOT NULL
  )
`);
chmodSync(sessionDatabasePath, 0o600);

const getSession = database.prepare(`
  SELECT sess FROM sessions WHERE sid = ? AND expired >= ?
`);
const setSession = database.prepare(`
  INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)
  ON CONFLICT(sid) DO UPDATE SET expired = excluded.expired, sess = excluded.sess
`);
const touchSession = database.prepare(`
  UPDATE sessions SET expired = ? WHERE sid = ? AND expired >= ?
`);
const destroySession = database.prepare('DELETE FROM sessions WHERE sid = ?');
const pruneSessions = database.prepare('DELETE FROM sessions WHERE expired < ?');

class SQLiteSessionStore extends session.Store {
  get(sessionId, callback) {
    try {
      const row = getSession.get(sessionId, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sessionId, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + (value.cookie?.maxAge || 24 * 60 * 60 * 1000);
      setSession.run(sessionId, expiresAt, JSON.stringify(value));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sessionId, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + (value.cookie?.maxAge || 24 * 60 * 60 * 1000);
      touchSession.run(expiresAt, sessionId, Date.now());
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sessionId, callback = () => {}) {
    try {
      destroySession.run(sessionId);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

pruneSessions.run(Date.now());
const cleanupTimer = setInterval(() => {
  try {
    pruneSessions.run(Date.now());
  } catch (error) {
    process.stderr.write(`期限切れセッションを削除できませんでした: ${error.stack || error}\n`);
  }
}, 24 * 60 * 60 * 1000);
cleanupTimer.unref();

export const sessionStore = new SQLiteSessionStore();
