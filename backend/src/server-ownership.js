import { randomUUID } from 'node:crypto';
import { database } from './database.js';

// Servers sharing a local data directory must also share the host PID namespace.
// Serialize ownership changes in SQLite so simultaneous restarts cannot both
// replace the record left by a crashed process.
export function acquireServerOwnership() {
  const token = randomUUID();
  database.transaction(() => {
    const previous = database.prepare('SELECT pid FROM server_process WHERE id = 1').get();
    if (previous) {
      let alive = true;
      try {
        process.kill(previous.pid, 0);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        alive = false;
      }
      if (alive) throw new Error('同じCMS_DATA_DIRのサーバーが実行中です。先に旧プロセスを停止してください。');
    }
    database.prepare('INSERT OR REPLACE INTO server_process (id, pid, token) VALUES (1, ?, ?)').run(process.pid, token);
  }).immediate();
  const release = () => {
    database.prepare('DELETE FROM server_process WHERE id = 1 AND token = ?').run(token);
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return release;
}
