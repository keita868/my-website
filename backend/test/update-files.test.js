import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('orphan recovery removes only old unreferenced files and temporary uploads', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cms-orphan-test-'));
  const uploads = path.join(directory, 'uploads');
  const temporary = path.join(uploads, '.tmp');
  try {
    mkdirSync(temporary, { recursive: true });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const [folder, name, stale] of [
      [uploads, 'referenced.pdf', true], [uploads, 'orphan.pdf', true], [uploads, 'recent.pdf', false],
      [temporary, 'abandoned', true], [temporary, 'recent', false]
    ]) {
      const filename = path.join(folder, name);
      writeFileSync(filename, '%PDF-1.4\n');
      if (stale) utimesSync(filename, old, old);
    }
    mkdirSync(path.join(uploads, 'keep-directory'));
    symlinkSync('referenced.pdf', path.join(uploads, 'keep-symlink'));
    const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { database } from './src/database.js';
      import { cleanupOrphanedAttachments } from './src/update-files.js';
      database.exec(\`
        INSERT INTO admins (id, email, password_hash) VALUES (1, 'test@example.test', 'unused');
        INSERT INTO updates (id, type, title, body, status, created_by, updated_by, created_at, updated_at)
          VALUES (1, 'news', 'Title', 'Body', 'draft', 1, 1, '2026-11-01', '2026-11-01');
        INSERT INTO update_attachments (update_id, stored_name, original_name, mime_type, size, created_at)
          VALUES (1, 'referenced.pdf', 'Reference.pdf', 'application/pdf', 9, '2026-11-01');
      \`);
      cleanupOrphanedAttachments();
      database.close();
    `], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, CMS_DATA_DIR: directory }, encoding: 'utf8', timeout: 5000
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(path.join(uploads, 'referenced.pdf')), true);
    assert.deepEqual(readdirSync(uploads).sort(), ['.tmp', 'keep-directory', 'keep-symlink', 'recent.pdf', 'referenced.pdf']);
    assert.deepEqual(readdirSync(temporary), ['recent']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
