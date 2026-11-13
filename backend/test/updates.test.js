import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'cms-updates-test-'));
const adminEmail = 'updates-admin@example.test';
const adminPassword = 'updates-admin-password-2026';
const secret = 'test-updates-session-secret-with-more-than-32-characters';

let server;
let origin;
let adminId;
let childOutput = '';

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

function cookieFrom(response, fallback = '') {
  return response.headers.get('set-cookie')?.split(';', 1)[0] || fallback;
}

async function request(pathname, { method = 'GET', cookie = '', csrf, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const isFormData = body instanceof FormData;
  if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
    redirect: 'manual'
  });
  const data = response.status === 204
    ? null
    : response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text();
  return { response, data, cookie: cookieFrom(response, cookie) };
}

async function csrfFor(cookie = '') {
  const result = await request('/api/auth/csrf', { cookie });
  assert.equal(result.response.status, 200);
  return { csrf: result.data.csrfToken, cookie: result.cookie };
}

async function login() {
  const initial = await csrfFor();
  return request('/api/auth/login', {
    method: 'POST',
    cookie: initial.cookie,
    csrf: initial.csrf,
    body: { email: adminEmail, password: adminPassword }
  });
}

function futureJstDateTime() {
  const jst = new Date(Date.now() + 10 * 60 * 1000 + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 16);
}

before(async () => {
  const legacyDb = new Database(path.join(dataDirectory, 'cms.sqlite'));
  legacyDb.exec(`
    CREATE TABLE admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  legacyDb.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)')
    .run(adminEmail, await argon2.hash(adminPassword, { type: argon2.argon2id }));
  adminId = Number(legacyDb.prepare('SELECT id FROM admins WHERE email = ?').get(adminEmail).id);
  legacyDb.close();

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      CMS_DATA_DIR: dataDirectory,
      CMS_SESSION_SECRET: secret,
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.setEncoding('utf8').on('data', (chunk) => { childOutput += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { childOutput += chunk; });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Test server exited unexpectedly: ${childOutput}`);
    try {
      const response = await fetch(`${origin}/api/auth/csrf`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Test server did not start: ${childOutput}`);
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
  rmSync(dataDirectory, { recursive: true, force: true });
});

test('requires authentication and CSRF protection for update management', async () => {
  assert.equal((await request('/admin/updates')).response.status, 302);
  assert.equal((await request('/admin/updates/new')).response.status, 302);
  assert.equal((await request('/api/admin/updates')).response.status, 401);
  assert.equal((await request('/api/admin/updates/1')).response.status, 401);
  assert.equal((await request('/api/admin/updates/attachments/1/file')).response.status, 401);

  const adminLogin = await login();
  assert.equal(adminLogin.response.status, 200);
  assert.equal(adminLogin.data.admin.role, 'superadmin');
  const updatesPage = await request('/admin/updates', { cookie: adminLogin.cookie });
  const createPage = await request('/admin/updates/new', { cookie: adminLogin.cookie });
  const updatesScript = await request('/admin/assets/updates.js', { cookie: adminLogin.cookie });
  assert.equal(updatesPage.response.status, 200);
  assert.match(updatesPage.data, /更新情報管理/);
  assert.equal(createPage.response.status, 200);
  assert.match(createPage.data, /id="update-form"/);
  assert.equal(updatesScript.response.status, 200);
  const unauthenticatedPost = await request('/api/admin/updates', {
    method: 'POST',
    cookie: adminLogin.cookie,
    body: { type: 'news', title: 'News', body: 'Text', status: 'draft' }
  });
  assert.equal(unauthenticatedPost.response.status, 403);
  const unauthenticatedPublish = await request('/api/admin/updates/1/publish', {
    method: 'POST',
    cookie: adminLogin.cookie
  });
  assert.equal(unauthenticatedPublish.response.status, 403);

  const oversizedRequest = await request('/api/admin/updates', {
    method: 'POST',
    body: { body: 'x'.repeat(33000) }
  });
  assert.equal(oversizedRequest.response.status, 413);
  assert.equal(oversizedRequest.data.error, 'リクエストが大きすぎます。');
});

test('creates validated draft and published updates and lists stored content', async () => {
  const adminLogin = await login();
  assert.equal(adminLogin.response.status, 200);
  const cookie = adminLogin.cookie;
  const initialList = await request('/api/admin/updates', { cookie });
  assert.equal(initialList.response.status, 200);
  assert.deepEqual(initialList.data.updates, []);

  const invalidUpdates = [
    { type: 'event', title: 'Title', body: 'Body', status: 'draft' },
    { type: 'news', title: 'Title', body: 'Body', status: 'scheduled' },
    { type: 'notice', title: ' \t ', body: 'Body', status: 'draft' },
    { type: 'news', title: 'Title', body: ' \n ', status: 'published' },
    { type: 'news', title: 'x'.repeat(201), body: 'Body', status: 'draft' },
    { type: 'notice', title: 'Title', body: 'x'.repeat(5001), status: 'draft' }
  ];
  const csrf = await csrfFor(cookie);
  for (const body of invalidUpdates) {
    const invalid = await request('/api/admin/updates', {
      method: 'POST',
      cookie: csrf.cookie,
      csrf: csrf.csrf,
      body
    });
    assert.equal(invalid.response.status, 400);
  }

  const draft = await request('/api/admin/updates', {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf,
    body: {
      type: 'news',
      title: '安全なタイトル <script>alert(1)</script>',
      body: '下書きの本文\n改行を保持します。',
      status: 'draft'
    }
  });
  assert.equal(draft.response.status, 201);
  assert.equal(draft.data.success, true);
  assert.equal(draft.data.update.status, 'draft');
  assert.equal(draft.data.update.publishedAt, null);
  assert.equal(draft.data.update.createdBy, adminId);
  assert.equal(draft.data.update.updatedBy, adminId);
  assert.equal(draft.data.update.title, '安全なタイトル <script>alert(1)</script>');

  const publishWithoutCsrf = await request(`/api/admin/updates/${draft.data.update.id}/publish`, {
    method: 'POST',
    cookie
  });
  assert.equal(publishWithoutCsrf.response.status, 403);

  const publish = await request(`/api/admin/updates/${draft.data.update.id}/publish`, {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf
  });
  assert.equal(publish.response.status, 200);
  assert.equal(publish.data.success, true);
  assert.equal(publish.data.update.status, 'published');
  assert.match(publish.data.update.publishedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(publish.data.update.updatedBy, adminId);
  const publishAgain = await request(`/api/admin/updates/${draft.data.update.id}/publish`, {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf
  });
  assert.equal(publishAgain.response.status, 409);

  const missingPublish = await request('/api/admin/updates/99999/publish', {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf
  });
  assert.equal(missingPublish.response.status, 404);
  const invalidIdPublish = await request('/api/admin/updates/not-an-id/publish', {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf
  });
  assert.equal(invalidIdPublish.response.status, 400);

  const published = await request('/api/admin/updates', {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf,
    body: {
      type: 'notice',
      title: 'メンテナンスのお知らせ',
      body: 'サイトを更新します。',
      status: 'published'
    }
  });
  assert.equal(published.response.status, 201);
  assert.equal(published.data.update.status, 'published');
  assert.match(published.data.update.publishedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

  const list = await request('/api/admin/updates', { cookie });
  assert.equal(list.response.status, 200);
  assert.deepEqual(list.data.updates.map((update) => update.id), [published.data.update.id, draft.data.update.id]);
  assert.equal(list.data.updates[1].body, '下書きの本文\n改行を保持します。');
  assert.equal(list.data.updates[1].publishedAt, publish.data.update.publishedAt);
});

test('edits, schedules, attaches, withdraws, and deletes updates safely', async () => {
  const adminLogin = await login();
  assert.equal(adminLogin.response.status, 200);
  const csrf = await csrfFor(adminLogin.cookie);

  const invalidSchedule = new FormData();
  invalidSchedule.set('type', 'news');
  invalidSchedule.set('title', '無効な予約');
  invalidSchedule.set('body', '本文です。');
  invalidSchedule.set('status', 'scheduled');
  invalidSchedule.set('scheduledAt', '2026-02-31T12:00');
  const rejectedSchedule = await request('/api/admin/updates', {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf,
    body: invalidSchedule
  });
  assert.equal(rejectedSchedule.response.status, 400);

  const oversizedAttachment = new FormData();
  oversizedAttachment.set('type', 'news');
  oversizedAttachment.set('title', 'サイズ上限');
  oversizedAttachment.set('body', '本文です。');
  oversizedAttachment.set('status', 'draft');
  oversizedAttachment.append(
    'attachments',
    new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/gif' }),
    'too-large.gif'
  );
  const rejectedAttachment = await request('/api/admin/updates', {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf,
    body: oversizedAttachment
  });
  assert.equal(rejectedAttachment.response.status, 413);

  const createForm = new FormData();
  createForm.set('type', 'notice');
  createForm.set('title', '予約投稿');
  createForm.set('body', '予約時刻に自動公開されます。');
  createForm.set('status', 'scheduled');
  createForm.set('scheduledAt', futureJstDateTime());
  createForm.append(
    'attachments',
    new Blob([Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')], { type: 'image/gif' }),
    'preview.gif'
  );
  const created = await request('/api/admin/updates', {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf,
    body: createForm
  });
  assert.equal(created.response.status, 201);
  const updateId = created.data.update.id;
  assert.equal(created.data.update.status, 'draft');
  assert.ok(Date.parse(created.data.update.scheduledAt) > Date.now());
  assert.equal(created.data.update.attachments.length, 1);
  assert.equal(created.data.update.attachments[0].mimeType, 'image/gif');
  assert.equal((await request(`/admin/updates/${updateId}/edit`, { cookie: adminLogin.cookie })).response.status, 200);
  const listedUpdate = (await request('/api/admin/updates', { cookie: adminLogin.cookie }))
    .data.updates.find(({ id }) => id === updateId);
  assert.equal(listedUpdate.attachments.length, 1);

  const attachmentUrl = created.data.update.attachments[0].url;
  const unauthenticatedFile = await request(attachmentUrl);
  assert.equal(unauthenticatedFile.response.status, 401);
  const downloadedFile = await request(attachmentUrl, { cookie: adminLogin.cookie });
  assert.equal(downloadedFile.response.status, 200);
  assert.equal(downloadedFile.response.headers.get('content-type'), 'image/gif');
  assert.equal(downloadedFile.response.headers.get('x-content-type-options'), 'nosniff');

  const manualPublish = await request(`/api/admin/updates/${updateId}/publish`, {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf
  });
  assert.equal(manualPublish.response.status, 200);
  assert.equal(manualPublish.data.update.scheduledAt, null);
  const manualUnpublish = await request(`/api/admin/updates/${updateId}/unpublish`, {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf
  });
  assert.equal(manualUnpublish.response.status, 200);

  const badFileForm = new FormData();
  badFileForm.set('type', 'notice');
  badFileForm.set('title', '予約投稿');
  badFileForm.set('body', '本文です。');
  badFileForm.set('status', 'draft');
  badFileForm.append('attachments', new Blob(['not a PDF'], { type: 'application/pdf' }), 'fake.pdf');
  const rejectedFile = await request(`/api/admin/updates/${updateId}`, {
    method: 'PATCH',
    cookie: csrf.cookie,
    csrf: csrf.csrf,
    body: badFileForm
  });
  assert.equal(rejectedFile.response.status, 400);

  const editForm = new FormData();
  editForm.set('type', 'news');
  editForm.set('title', '予約投稿を編集');
  editForm.set('body', '編集された本文です。');
  editForm.set('scheduledAt', futureJstDateTime());
  editForm.append(
    'attachments',
    new Blob(['%PDF-1.4\n'], { type: 'application/pdf' }),
    'document.pdf'
  );
  for (let index = 0; index < 3; index += 1) {
    editForm.append(
      'attachments',
      new Blob([Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')], { type: 'image/gif' }),
      `extra-${index}.gif`
    );
  }
  const edited = await request(`/api/admin/updates/${updateId}`, {
    method: 'PATCH',
    cookie: csrf.cookie,
    csrf: csrf.csrf,
    body: editForm
  });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.data.update.title, '予約投稿を編集');
  assert.equal(edited.data.update.type, 'news');
  assert.ok(Date.parse(edited.data.update.scheduledAt) > Date.now());
  assert.equal(edited.data.update.attachments.length, 5);
  assert.ok(edited.data.update.attachments.some(({ mimeType }) => mimeType === 'application/pdf'));

  const tooManyFiles = new FormData();
  tooManyFiles.set('type', 'news');
  tooManyFiles.set('title', '予約投稿を編集');
  tooManyFiles.set('body', '編集された本文です。');
  tooManyFiles.set('scheduledAt', '');
  tooManyFiles.append(
    'attachments',
    new Blob([Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')], { type: 'image/gif' }),
    'sixth.gif'
  );
  const tooManyAttachments = await request(`/api/admin/updates/${updateId}`, {
    method: 'PATCH',
    cookie: csrf.cookie,
    csrf: csrf.csrf,
    body: tooManyFiles
  });
  assert.equal(tooManyAttachments.response.status, 400);

  const db = new Database(path.join(dataDirectory, 'cms.sqlite'));
  const scheduledAt = new Date(Date.now() - 1000).toISOString();
  db.prepare('UPDATE updates SET scheduled_at = ? WHERE id = ?').run(scheduledAt, updateId);
  db.close();
  let autoPublished;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(100);
    autoPublished = await request(`/api/admin/updates/${updateId}`, { cookie: adminLogin.cookie });
    if (autoPublished.data.update.status === 'published') break;
  }
  assert.equal(autoPublished.data.update.status, 'published');
  assert.equal(autoPublished.data.update.scheduledAt, null);
  assert.ok(autoPublished.data.update.publishedAt);

  const unpublish = await request(`/api/admin/updates/${updateId}/unpublish`, {
    method: 'POST',
    cookie: csrf.cookie,
    csrf: csrf.csrf
  });
  assert.equal(unpublish.response.status, 200);
  assert.equal(unpublish.data.update.status, 'draft');
  assert.equal(unpublish.data.update.publishedAt, null);

  const removeAttachmentId = unpublish.data.update.attachments[0].id;
  const attachmentDatabase = new Database(path.join(dataDirectory, 'cms.sqlite'));
  const attachmentRecord = attachmentDatabase.prepare('SELECT stored_name FROM update_attachments WHERE id = ?')
    .get(removeAttachmentId);
  attachmentDatabase.close();
  const attachmentPath = path.join(dataDirectory, 'uploads', attachmentRecord.stored_name);
  const removeAttachment = await request(`/api/admin/updates/${updateId}/attachments/${removeAttachmentId}`, {
    method: 'DELETE',
    cookie: csrf.cookie,
    csrf: csrf.csrf
  });
  assert.equal(removeAttachment.response.status, 204);
  assert.equal(existsSync(attachmentPath), false);

  const database = new Database(path.join(dataDirectory, 'cms.sqlite'));
  const remainingAttachment = database.prepare('SELECT stored_name FROM update_attachments WHERE update_id = ?')
    .get(updateId);
  const remainingAttachmentPath = path.join(dataDirectory, 'uploads', remainingAttachment.stored_name);
  database.close();
  const removeUpdate = await request(`/api/admin/updates/${updateId}`, {
    method: 'DELETE',
    cookie: csrf.cookie,
    csrf: csrf.csrf
  });
  assert.equal(removeUpdate.response.status, 204);
  assert.equal(existsSync(remainingAttachmentPath), false);
  assert.equal((await request(`/api/admin/updates/${updateId}`, { cookie: adminLogin.cookie })).response.status, 404);
});
