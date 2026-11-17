import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const imports = `
  import { database } from './src/database.js';
  import { acquireServerOwnership } from './src/server-ownership.js';
`;

test('data-directory ownership rejects a second process and recovers after a crash', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cms-ownership-test-'));
  const env = { ...process.env, CMS_DATA_DIR: directory };
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `${imports}
    acquireServerOwnership();
    process.send('owned');
    setInterval(() => {}, 1000);
  `], { cwd, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = once(holder, 'close');
  let stderr = '';
  holder.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    await closed;
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal((await once(holder, 'message', { signal: AbortSignal.timeout(5000) }))[0], 'owned', stderr);
  const rejected = spawnSync(process.execPath, ['--input-type=module', '-e', `${imports} acquireServerOwnership();`], {
    cwd, env, encoding: 'utf8', timeout: 5000
  });
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /同じCMS_DATA_DIRのサーバーが実行中/);
  holder.kill('SIGKILL');
  await closed;

  const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', `${imports}
    import assert from 'node:assert/strict';
    const release = acquireServerOwnership();
    assert.throws(acquireServerOwnership, /サーバーが実行中/);
    release();
    const releaseNext = acquireServerOwnership();
    release(); // An old owner's release must not delete the new ownership.
    assert.throws(acquireServerOwnership, /サーバーが実行中/);
    releaseNext();
    database.close();
  `], { cwd, env, encoding: 'utf8', timeout: 5000 });
  assert.equal(recovered.status, 0, recovered.stderr);
});
