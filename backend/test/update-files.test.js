import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const names = {
  referenced: '11111111-1111-4111-8111-111111111111.pdf',
  orphan: '22222222-2222-4222-8222-222222222222.pdf',
  recent: '33333333-3333-4333-8333-333333333333.pdf',
  abandoned: '44444444-4444-4444-8444-444444444444',
  temporary: '55555555-5555-4555-8555-555555555555'
};

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cms-orphan-test-'));
  const uploads = path.join(directory, 'uploads');
  const temporary = path.join(uploads, '.tmp');
  mkdirSync(temporary, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = (folder, name, stale = true) => {
    const filename = path.join(folder, name);
    writeFileSync(filename, '%PDF-1.4\n');
    if (stale) {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      utimesSync(filename, old, old);
    }
    return filename;
  };
  return { directory, uploads, temporary, file };
}

function run(directory, source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { mock } from 'node:test';
    import { database, dataDirectory } from './src/database.js';
    import { acquireServerOwnership } from './src/server-ownership.js';
    import { beginAttachmentUpload, cleanupOrphanedAttachments, startAttachmentCleanup } from './src/update-files.js';
    const names = ${JSON.stringify(names)};
    const uploads = path.join(dataDirectory, 'uploads');
    const temporary = path.join(uploads, '.tmp');
    const release = acquireServerOwnership();
    try { ${source} } finally { release(); database.close(); }
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, CMS_DATA_DIR: directory }, encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
}

test('orphan recovery removes only old generated unreferenced files and temporary uploads', (t) => {
  const { directory, uploads, temporary, file } = fixture(t);
  file(uploads, names.referenced);
  file(uploads, names.orphan);
  file(uploads, names.recent, false);
  file(temporary, names.abandoned);
  file(temporary, names.temporary, false);
  for (const folder of [uploads, temporary]) {
    file(folder, 'recovery-copy.pdf');
    file(folder, '66666666-6666-4666-8666-666666666666.txt');
    mkdirSync(path.join(folder, 'keep-directory'));
  }
  run(directory, `
    database.exec(\`
      INSERT INTO admins (id, email, password_hash) VALUES (1, 'test@example.test', 'unused');
      INSERT INTO updates (id, type, title, body, status, created_by, updated_by, created_at, updated_at)
        VALUES (1, 'news', 'Title', 'Body', 'draft', 1, 1, '2026-11-01', '2026-11-01');
    \`);
    database.prepare(\`
      INSERT INTO update_attachments (update_id, stored_name, original_name, mime_type, size, created_at)
        VALUES (1, ?, 'Reference.pdf', 'application/pdf', 9, '2026-11-01')
    \`).run(names.referenced);
    cleanupOrphanedAttachments();
  `);
  assert.deepEqual(readdirSync(uploads).sort(), [
    '.tmp', names.referenced, names.recent, '66666666-6666-4666-8666-666666666666.txt', 'keep-directory', 'recovery-copy.pdf'
  ].sort());
  assert.deepEqual(readdirSync(temporary).sort(), [
    names.temporary, '66666666-6666-4666-8666-666666666666.txt', 'keep-directory', 'recovery-copy.pdf'
  ].sort());
});

test('orphan recovery preserves symlinks even when their names match generated files', (t) => {
  const { directory, uploads, temporary, file } = fixture(t);
  const target = file(uploads, 'recovery-copy.pdf');
  try {
    symlinkSync(target, path.join(uploads, names.orphan), 'file');
    symlinkSync(target, path.join(temporary, names.abandoned), 'file');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('This environment does not permit file symlinks');
    return;
  }
  run(directory, 'cleanupOrphanedAttachments();');
  assert.deepEqual(readdirSync(uploads).sort(), ['.tmp', names.orphan, 'recovery-copy.pdf'].sort());
  assert.deepEqual(readdirSync(temporary), [names.abandoned]);
});

test('a candidate disappearing before stat does not prevent recovery of the remaining files', (t) => {
  const { directory, uploads, temporary, file } = fixture(t);
  file(temporary, names.abandoned);
  file(uploads, names.orphan);
  run(directory, `
    const original = fs.lstatSync;
    fs.lstatSync = (filename, ...args) => {
      if (filename === path.join(temporary, names.abandoned)) fs.unlinkSync(filename);
      return original(filename, ...args);
    };
    syncBuiltinESMExports();
    cleanupOrphanedAttachments();
    fs.lstatSync = original;
    syncBuiltinESMExports();
  `);
  assert.deepEqual(readdirSync(uploads), ['.tmp']);
  assert.deepEqual(readdirSync(temporary), []);
});

test('periodic recovery retries recent files after the grace period and skips active uploads', (t) => {
  const { directory, uploads, temporary, file } = fixture(t);
  file(uploads, names.recent, false);
  file(temporary, names.temporary, false);
  run(directory, `
    let now = Date.now();
    let collect;
    mock.method(Date, 'now', () => now);
    mock.method(globalThis, 'setInterval', (callback, milliseconds) => {
      assert.equal(milliseconds, 60 * 60 * 1000);
      collect = callback;
      return { unref() {} };
    });
    const stop = startAttachmentCleanup();
    assert.equal(typeof collect, 'function');
    assert.equal(fs.existsSync(path.join(uploads, names.recent)), true);
    now += 25 * 60 * 60 * 1000;
    const finishFirst = beginAttachmentUpload();
    const finishSecond = beginAttachmentUpload();
    collect();
    finishFirst();
    finishFirst();
    collect();
    assert.equal(fs.existsSync(path.join(temporary, names.temporary)), true);
    assert.equal(fs.existsSync(path.join(uploads, names.recent)), true);
    finishSecond();
    collect();
    assert.equal(fs.existsSync(path.join(temporary, names.temporary)), false);
    assert.equal(fs.existsSync(path.join(uploads, names.recent)), false);
    stop();
    mock.restoreAll();
  `);
});

test('stat permission errors propagate and scheduled recovery logs them without stopping the server', (t) => {
  const { directory, uploads, file } = fixture(t);
  file(uploads, names.orphan);
  run(directory, `
    fs.lstatSync = () => { throw Object.assign(new Error('stat denied'), { code: 'EACCES' }); };
    syncBuiltinESMExports();
    assert.throws(cleanupOrphanedAttachments, { code: 'EACCES' });
    let output = '';
    mock.method(process.stderr, 'write', (message) => { output += message; return true; });
    const stop = startAttachmentCleanup();
    assert.match(output, /stat denied/);
    stop();
    mock.restoreAll();
  `);
});
