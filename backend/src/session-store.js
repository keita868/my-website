import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import session from 'express-session';
import Database from 'better-sqlite3';
import { dataDirectory } from './database.js';
import { authenticationExpiresAt } from './session-policy.js';

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
// Keep revocations longer than any session or in-flight HTTP request can live.
database.exec(`
  CREATE TABLE IF NOT EXISTS revoked_sessions (
    sid TEXT PRIMARY KEY,
    expired INTEGER NOT NULL
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
const revokeSession = database.prepare('INSERT OR REPLACE INTO revoked_sessions (sid, expired) VALUES (?, ?)');
const revokedSession = database.prepare('SELECT 1 FROM revoked_sessions WHERE sid = ?');
const pruneRevocations = database.prepare('DELETE FROM revoked_sessions WHERE expired < ?');
const saveSession = database.transaction((sessionId, value) => {
  if (expiresAt(value) > Date.now() && !revokedSession.get(sessionId)) {
    setSession.run(sessionId, expiresAt(value), JSON.stringify(value));
  }
});

function expiresAt(value) {
  const cookieExpiry = value.cookie?.expires
    ? new Date(value.cookie.expires).getTime()
    : Date.now() + (value.cookie?.maxAge || 24 * 60 * 60 * 1000);
  return value.adminId ? Math.min(cookieExpiry, authenticationExpiresAt(value)) : cookieExpiry;
}

class SQLiteSessionStore extends session.Store {
  isActive(sessionId) {
    const row = getSession.get(sessionId, Date.now());
    if (!row) return false;
    const value = JSON.parse(row.sess);
    return !value.adminId || authenticationExpiresAt(value) > Date.now();
  }

  get(sessionId, callback) {
    let result;
    try {
      const row = getSession.get(sessionId, Date.now());
      const value = row ? JSON.parse(row.sess) : null;
      result = value?.adminId && authenticationExpiresAt(value) <= Date.now() ? null : value;
    } catch (error) {
      return callback(error);
    }
    callback(null, result);
  }

  set(sessionId, value, callback = () => {}) {
    try {
      saveSession.immediate(sessionId, value);
    } catch (error) {
      return callback(error);
    }
    callback(null);
  }

  touch(sessionId, value, callback = () => {}) {
    try {
      touchSession.run(expiresAt(value), sessionId, Date.now());
    } catch (error) {
      return callback(error);
    }
    callback(null);
  }

  destroy(sessionId, callback = () => {}) {
    try {
      database.transaction(() => {
        revokeSession.run(sessionId, Date.now() + 24 * 60 * 60 * 1000);
        destroySession.run(sessionId);
      })();
    } catch (error) {
      return callback(error);
    }
    callback(null);
  }
}

pruneSessions.run(Date.now());
pruneRevocations.run(Date.now());
const cleanupTimer = setInterval(() => {
  try {
    pruneSessions.run(Date.now());
    pruneRevocations.run(Date.now());
  } catch (error) {
    process.stderr.write(`期限切れセッションを削除できませんでした: ${error.stack || error}\n`);
  }
}, 24 * 60 * 60 * 1000);
cleanupTimer.unref();

export const sessionStore = new SQLiteSessionStore();
