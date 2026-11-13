import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'cms-admin-auth-test-'));
const ownerEmail = 'owner@example.test';
const ownerPassword = 'owner-password-2026';
const adminEmail = 'editor@example.test';
const adminPassword = 'editor-password-2026';
const passwordAfterChange = 'changed-password-2026';
const secret = 'test-session-secret-with-more-than-32-characters';

let server;
let origin;
let ownerId;
let editorId;
let childOutput = '';
const forbiddenLogValues = [];

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

async function request(pathname, { method = 'GET', cookie = '', csrf, body, forwardedFor } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

let loginAttempt = 0;

async function login(email, password, forwardedFor) {
  const initial = await csrfFor();
  loginAttempt += 1;
  return request('/api/auth/login', {
    method: 'POST',
    cookie: initial.cookie,
    csrf: initial.csrf,
    forwardedFor: forwardedFor || `10.0.0.${loginAttempt}`,
    body: { email, password }
  });
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
    .run(ownerEmail, await argon2.hash(ownerPassword, { type: argon2.argon2id }));
  ownerId = Number(legacyDb.prepare('SELECT id FROM admins WHERE email = ?').get(ownerEmail).id);
  legacyDb.close();

  process.env.CMS_DATA_DIR = dataDirectory;
  const { database } = await import('../src/database.js');
  const migratedOwner = database.prepare('SELECT * FROM admins WHERE id = ?').get(ownerId);
  assert.equal(migratedOwner.email, ownerEmail);
  assert.equal(migratedOwner.role, 'superadmin');
  assert.equal(migratedOwner.is_active, 1);
  database.close();

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      CMS_DATA_DIR: dataDirectory,
      CMS_SESSION_SECRET: secret,
      PORT: String(port),
      TRUST_PROXY: '1'
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
    await once(server, 'close');
  }
  rmSync(dataDirectory, { recursive: true, force: true });
  for (const marker of forbiddenLogValues) assert.equal(childOutput.includes(marker), false);
});

test('preserves legacy accounts and enforces auth, role, account management, and password security', async () => {
  const unauthenticated = await request('/api/admins');
  assert.equal(unauthenticated.response.status, 401);
  assert.equal((await request('/admin')).response.status, 302);

  const unknownAccount = await login('missing@example.test', ownerPassword);
  const wrongPassword = await login(ownerEmail, 'incorrect-password');
  assert.equal(unknownAccount.response.status, 401);
  assert.equal(wrongPassword.response.status, 401);
  assert.equal(unknownAccount.data.error, wrongPassword.data.error);

  const noCsrf = await request('/api/auth/login', {
    method: 'POST',
    body: { email: ownerEmail, password: ownerPassword }
  });
  assert.equal(noCsrf.response.status, 403);

  const ownerLogin = await login(ownerEmail, ownerPassword);
  assert.equal(ownerLogin.response.status, 200);
  assert.equal(ownerLogin.data.admin.role, 'superadmin');
  const ownerCookie = ownerLogin.cookie;

  let owner = await request('/api/auth/me', { cookie: ownerCookie });
  assert.equal(owner.response.status, 200);
  assert.equal(owner.data.admin.email, ownerEmail);
  assert.equal(owner.data.admin.lastLoginAt, (await request('/api/admins', { cookie: ownerCookie })).data.admins[0].lastLoginAt);

  const missingAdmin = await request('/api/admins/99999', { cookie: ownerCookie });
  assert.equal(missingAdmin.response.status, 404);
  const stateChangeWithoutCsrf = await request(`/api/admins/${ownerId}`, {
    method: 'PATCH',
    cookie: ownerCookie,
    body: { displayName: 'No CSRF' }
  });
  assert.equal(stateChangeWithoutCsrf.response.status, 403);

  const ownerCsrf = await csrfFor(ownerCookie);
  const [firstTabCsrf, secondTabCsrf] = await Promise.all([
    csrfFor(ownerCookie),
    csrfFor(ownerCookie)
  ]);
  assert.equal(firstTabCsrf.csrf, secondTabCsrf.csrf);
  const created = await request('/api/admins', {
    method: 'POST',
    cookie: firstTabCsrf.cookie,
    csrf: ownerCsrf.csrf,
    body: {
      displayName: 'Editor',
      email: adminEmail,
      password: adminPassword,
      role: 'admin'
    }
  });
  assert.equal(created.response.status, 201);
  editorId = created.data.admin.id;

  const createSuperadminCsrf = await csrfFor(ownerCookie);
  const secondSuperadmin = await request('/api/admins', {
    method: 'POST',
    cookie: createSuperadminCsrf.cookie,
    csrf: createSuperadminCsrf.csrf,
    body: {
      displayName: 'Second Superadmin',
      email: 'second-superadmin@example.test',
      password: 'second-superadmin-password-2026',
      role: 'superadmin'
    }
  });
  assert.equal(secondSuperadmin.response.status, 201);
  const secondSuperadminLogin = await login('second-superadmin@example.test', 'second-superadmin-password-2026');
  assert.equal(secondSuperadminLogin.response.status, 200);

  const pendingCreations = Array.from({ length: 8 }, (_, index) => request('/api/admins', {
    method: 'POST',
    cookie: ownerCookie,
    csrf: ownerCsrf.csrf,
    body: {
      displayName: `Revoked ${index}`,
      email: `revoked-${index}@example.test`,
      password: `revoked-password-${index}-2026`,
      role: 'superadmin'
    }
  }));
  const revokeOwnerCsrf = await csrfFor(secondSuperadminLogin.cookie);
  const revokeOwner = await request(`/api/admins/${ownerId}`, {
    method: 'PATCH',
    cookie: revokeOwnerCsrf.cookie,
    csrf: revokeOwnerCsrf.csrf,
    body: { role: 'admin' }
  });
  assert.equal(revokeOwner.response.status, 200);
  const creationResults = await Promise.all(pendingCreations);
  assert.ok(creationResults.some((result) => result.response.status === 403));

  const restoreOwnerCsrf = await csrfFor(secondSuperadminLogin.cookie);
  const restoreOwner = await request(`/api/admins/${ownerId}`, {
    method: 'PATCH',
    cookie: restoreOwnerCsrf.cookie,
    csrf: restoreOwnerCsrf.csrf,
    body: { role: 'superadmin' }
  });
  assert.equal(restoreOwner.response.status, 200);
  const createdDuringRace = creationResults
    .filter((result) => result.response.status === 201)
    .map((result) => result.data.admin.id);
  for (const id of createdDuringRace) {
    const cleanupCsrf = await csrfFor(secondSuperadminLogin.cookie);
    const disable = await request(`/api/admins/${id}`, {
      method: 'PATCH',
      cookie: cleanupCsrf.cookie,
      csrf: cleanupCsrf.csrf,
      body: { isActive: false }
    });
    assert.equal(disable.response.status, 200);
  }

  const duplicate = await request('/api/admins', {
    method: 'POST',
    cookie: ownerCsrf.cookie,
    csrf: ownerCsrf.csrf,
    body: {
      displayName: 'Duplicate',
      email: adminEmail,
      password: adminPassword,
      role: 'admin'
    }
  });
  assert.equal(duplicate.response.status, 409);

  const editorLogin = await login(adminEmail, adminPassword);
  assert.equal(editorLogin.response.status, 200);
  assert.equal(editorLogin.data.admin.role, 'admin');
  const editorCookie = editorLogin.cookie;

  const forbiddenList = await request('/api/admins', { cookie: editorCookie });
  assert.equal(forbiddenList.response.status, 403);
  const forbiddenAdminPage = await request('/admin/admins', { cookie: editorCookie });
  assert.equal(forbiddenAdminPage.response.status, 302);
  const editorCsrf = await csrfFor(editorCookie);
  const forbiddenCreate = await request('/api/admins', {
    method: 'POST',
    cookie: editorCsrf.cookie,
    csrf: editorCsrf.csrf,
    body: {
      displayName: 'Unauthorized',
      email: 'unauthorized@example.test',
      password: adminPassword,
      role: 'superadmin'
    }
  });
  assert.equal(forbiddenCreate.response.status, 403);

  const profileCsrf = await csrfFor(editorCookie);
  const profileUpdate = await request('/api/auth/me', {
    method: 'PATCH',
    cookie: profileCsrf.cookie,
    csrf: profileCsrf.csrf,
    body: { displayName: 'Editor Updated', email: 'editor-updated@example.test' }
  });
  assert.equal(profileUpdate.response.status, 200);
  assert.equal(profileUpdate.data.admin.displayName, 'Editor Updated');

  const secondEditorLogin = await login('editor-updated@example.test', adminPassword);
  assert.equal(secondEditorLogin.response.status, 200);

  const wrongCurrentPassword = await request('/api/auth/change-password', {
    method: 'POST',
    cookie: profileCsrf.cookie,
    csrf: profileCsrf.csrf,
    body: { currentPassword: 'incorrect-password', newPassword: passwordAfterChange }
  });
  assert.equal(wrongCurrentPassword.response.status, 400);
  assert.equal((await request('/api/auth/me', { cookie: wrongCurrentPassword.cookie })).response.status, 200);

  const passwordChangeCsrf = await csrfFor(editorCookie);
  const competingPasswords = [passwordAfterChange, 'another-changed-password-2026'];
  const competingPasswordChanges = await Promise.all(competingPasswords.map((newPassword) => request('/api/auth/change-password', {
    method: 'POST',
    cookie: passwordChangeCsrf.cookie,
    csrf: passwordChangeCsrf.csrf,
    body: { currentPassword: adminPassword, newPassword }
  })));
  const winningPasswordIndex = competingPasswordChanges.findIndex(({ response }) => response.status === 204);
  assert.notEqual(winningPasswordIndex, -1);
  assert.equal(competingPasswordChanges.filter(({ response }) => response.status === 204).length, 1);
  assert.equal(competingPasswordChanges.filter(({ response }) => response.status === 401).length, 1);
  const changedPassword = competingPasswords[winningPasswordIndex];
  assert.equal((await request('/api/auth/me', { cookie: editorCookie })).response.status, 401);
  assert.equal((await request('/api/auth/me', { cookie: secondEditorLogin.cookie })).response.status, 401);

  const oldPasswordLogin = await login('editor-updated@example.test', adminPassword);
  assert.equal(oldPasswordLogin.response.status, 401);
  const newPasswordLogin = await login('editor-updated@example.test', changedPassword);
  assert.equal(newPasswordLogin.response.status, 200);
  const newEditorCookie = newPasswordLogin.cookie;
  const adminDatabase = new Database(path.join(dataDirectory, 'cms.sqlite'));
  const changedHash = adminDatabase.prepare('SELECT password_hash FROM admins WHERE id = ?').get(editorId).password_hash;
  adminDatabase.close();
  assert.notEqual(changedHash, passwordAfterChange);
  assert.match(changedHash, /^\$argon2id\$/);

  const ownerFreshCsrf = await csrfFor(ownerCookie);
  const disableEditor = await request(`/api/admins/${editorId}`, {
    method: 'PATCH',
    cookie: ownerFreshCsrf.cookie,
    csrf: ownerFreshCsrf.csrf,
    body: { isActive: false }
  });
  assert.equal(disableEditor.response.status, 200);
  assert.equal((await request('/api/auth/me', { cookie: newEditorCookie })).response.status, 401);

  const secondSuperadminRecord = (await request('/api/admins', { cookie: ownerCookie }))
    .data.admins.find((admin) => admin.email === 'second-superadmin@example.test');
  const disableSecondSuperadminCsrf = await csrfFor(ownerCookie);
  const disableSecondSuperadmin = await request(`/api/admins/${secondSuperadminRecord.id}`, {
    method: 'PATCH',
    cookie: disableSecondSuperadminCsrf.cookie,
    csrf: disableSecondSuperadminCsrf.csrf,
    body: { isActive: false }
  });
  assert.equal(disableSecondSuperadmin.response.status, 200);
  assert.equal((await request('/api/auth/me', { cookie: secondSuperadminLogin.cookie })).response.status, 401);

  const selfDisableCsrf = await csrfFor(ownerCookie);
  const selfDisable = await request(`/api/admins/${ownerId}`, {
    method: 'PATCH',
    cookie: selfDisableCsrf.cookie,
    csrf: selfDisableCsrf.csrf,
    body: { isActive: false }
  });
  assert.equal(selfDisable.response.status, 400);

  const lastSuperadminCsrf = await csrfFor(ownerCookie);
  const lastSuperadminDemotion = await request(`/api/admins/${ownerId}`, {
    method: 'PATCH',
    cookie: lastSuperadminCsrf.cookie,
    csrf: lastSuperadminCsrf.csrf,
    body: { role: 'admin' }
  });
  assert.equal(lastSuperadminDemotion.response.status, 409);

  const disabledLogin = await login('editor-updated@example.test', changedPassword);
  assert.equal(disabledLogin.response.status, 401);

  const logoutCsrf = await csrfFor(ownerCookie);
  const logout = await request('/api/auth/logout', {
    method: 'POST',
    cookie: logoutCsrf.cookie,
    csrf: logoutCsrf.csrf
  });
  assert.equal(logout.response.status, 204);
  assert.equal((await request('/api/auth/me', { cookie: ownerCookie })).response.status, 401);

  const expiringLogin = await login(ownerEmail, ownerPassword);
  assert.equal(expiringLogin.response.status, 200);
  const rawSessionId = decodeURIComponent(expiringLogin.cookie.slice('cms.sid='.length))
    .slice(2).split('.')[0];
  const sessionDatabase = new Database(path.join(dataDirectory, 'sessions.sqlite'));
  sessionDatabase.prepare('UPDATE sessions SET expired = 0 WHERE sid = ?').run(rawSessionId);
  sessionDatabase.close();
  assert.equal((await request('/api/auth/me', { cookie: expiringLogin.cookie })).response.status, 401);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const failedLogin = await login(ownerEmail, 'incorrect-password', '198.51.100.250');
    assert.equal(failedLogin.response.status, 401);
  }
  const rateLimitedLogin = await login(ownerEmail, 'incorrect-password', '198.51.100.250');
  assert.equal(rateLimitedLogin.response.status, 429);
});

test('expires active sessions at the absolute lifetime and protects pages as well as APIs', async () => {
  for (const [route, status] of [['/admin', 302], ['/api/auth/me', 401]]) {
    const loggedIn = await login(ownerEmail, ownerPassword);
    assert.equal(loggedIn.response.status, 200);
    const sid = decodeURIComponent(loggedIn.cookie.slice('cms.sid='.length)).slice(2).split('.')[0];
    const db = new Database(path.join(dataDirectory, 'sessions.sqlite'));
    const value = JSON.parse(db.prepare('SELECT sess FROM sessions WHERE sid = ?').get(sid).sess);
    assert.ok(Number.isSafeInteger(value.authenticatedAt));
    assert.ok(value.cookie.originalMaxAge <= 30 * 60 * 1000);
    value.authenticatedAt = Date.now() - 8 * 60 * 60 * 1000 - 1000;
    db.prepare('UPDATE sessions SET sess = ?, expired = ? WHERE sid = ?')
      .run(JSON.stringify(value), Date.now() + 30 * 60 * 1000, sid);
    db.close();
    assert.equal((await request(route, { cookie: loggedIn.cookie })).response.status, status);
  }
});

test('limits password guesses across sessions and IP addresses after CSRF validation', async () => {
  const sessions = await Promise.all([login(ownerEmail, ownerPassword), login(ownerEmail, ownerPassword)]);
  const tokens = await Promise.all(sessions.map(({ cookie }) => csrfFor(cookie)));
  const body = { currentPassword: 'wrong-password', newPassword: 'replacement-password-2026' };
  for (let attempt = 0; attempt < 11; attempt += 1) {
    assert.equal((await request('/api/auth/change-password', {
      method: 'POST', ...tokens[0], csrf: 'invalid-token', body
    })).response.status, 403);
  }
  for (const invalid of [{}, { currentPassword: '', newPassword: 'valid-new-password' }, { currentPassword: 'x'.repeat(1025), newPassword: 'valid-new-password' }]) {
    for (let attempt = 0; attempt < 11; attempt++) {
      assert.equal((await request('/api/auth/change-password', {
        method: 'POST', ...tokens[0], body: invalid
      })).response.status, 400);
    }
  }
  const otherEmail = 'limiter-isolation@example.test';
  const otherPassword = 'other-account-password-2026';
  assert.equal((await request('/api/admins', {
    method: 'POST', ...tokens[0], body: { displayName: 'Other', email: otherEmail, password: otherPassword }
  })).response.status, 201);
  const otherLogin = await login(otherEmail, otherPassword);
  assert.equal(otherLogin.response.status, 200);
  const otherToken = await csrfFor(otherLogin.cookie);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await request('/api/auth/change-password', {
      method: 'POST', ...tokens[attempt % 2], forwardedFor: `192.0.2.${attempt + 1}`, body
    })).response.status, 400);
  }
  assert.equal((await request('/api/auth/change-password', {
    method: 'POST', ...tokens[1], forwardedFor: '203.0.113.100', body
  })).response.status, 429);
  assert.equal((await request('/api/auth/change-password', {
    method: 'POST', ...otherToken, body
  })).response.status, 400);
});

test('does not log submitted secrets from malformed JSON', async () => {
  const marker = 'private-password-must-not-be-logged';
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: `{"password":"${marker}" invalid}`
  });
  assert.equal(response.status, 400);
  forbiddenLogValues.push(marker); // Check after child stdout/stderr have closed in after().
});
