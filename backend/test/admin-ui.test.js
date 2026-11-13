import assert from 'node:assert/strict';
import { test } from 'node:test';
import { page, deferred, flush } from '../test-support/dom.js';

function createUI(fetch) {
  const fixture = page('account', fetch);
  const { document, window } = fixture;
  const draft = document.createElement('textarea');
  draft.value = 'unsaved draft';
  document.querySelector('form').append(draft);
  const password = document.querySelector('input[type="password"]');
  password.value = 'private-password';
  fixture.run('ui');
  return { ...fixture, request: window.cmsUI.request, password, draft };
}
const ok = () => ({ status: 200, ok: true, json: async () => ({}) });

test('session expiry preserves the DOM draft, clears passwords once and never retries writes', async () => {
  let calls = 0;
  const late = deferred();
  const ui = createUI(async (_url, options) => {
    calls++;
    assert.equal(options.credentials, 'same-origin');
    return calls === 1 ? late.promise : { status: 401 };
  });
  const oldRequest = assert.rejects(ui.request('/api/admin/updates', { method: 'POST' }), /別タブ/);
  await assert.rejects(ui.request('/api/auth/me'), /別タブ/);
  assert.equal(ui.password.value, '');
  assert.equal(ui.document.querySelector('form textarea')?.value, 'unsaved draft');
  assert.ok(ui.document.querySelector('#session-notice a[target="_blank"]'));
  ui.password.value = 'reentered-password';
  late.resolve({ status: 401 });
  await oldRequest;
  assert.equal(ui.password.value, 'reentered-password');
  assert.equal(calls, 2);
  assert.deepEqual(ui.navigations, []);
});

test('late successes cannot dismiss expiry; only a new protected request can', async () => {
  const late = deferred();
  let call = 0;
  const ui = createUI(() => {
    call++;
    return call === 1 ? late.promise : Promise.resolve(call === 2 ? { status: 401 } : ok());
  });
  const pending = ui.request('/api/auth/me');
  await assert.rejects(ui.request('/api/admins'), /別タブ/);
  late.resolve(ok());
  await pending;
  assert.ok(ui.document.querySelector('#session-notice'));
  await ui.request('/api/auth/csrf');
  assert.ok(ui.document.querySelector('#session-notice'));
  await ui.request('/api/auth/me');
  assert.equal(ui.document.querySelector('#session-notice'), null);
});

test('429 writes show retry time and are sent only once with the original body', async () => {
  let calls = 0;
  const body = JSON.stringify({ currentPassword: 'dummy', newPassword: 'replacement-password' });
  const ui = createUI(async (_url, options) => {
    calls++;
    assert.equal(options.method, 'POST');
    assert.equal(options.body, body);
    return { status: 429, ok: false, headers: new Headers({ 'Retry-After': '61' }), json: async () => ({ error: 'しばらくお待ちください。' }) };
  });
  await assert.rejects(ui.request('/api/auth/change-password', { method: 'POST', body }), /約2分後/);
  await flush();
  assert.equal(calls, 1);
});

test('network failures explain how to avoid duplicate saves', async () => {
  const ui = createUI(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(ui.request('/api/admin/updates', { method: 'POST' }), /一覧で保存状況を確認/);
});

test('old 401 responses do not block recovery or recreate a dismissed notice', async () => {
  for (const oldFirst of [true, false]) {
    const old = deferred();
    const current = deferred();
    let call = 0;
    const ui = createUI(() => {
      call++;
      if (call === 1) return old.promise;
      if (call === 2) return Promise.resolve({ status: 401 });
      return current.promise;
    });
    const oldRequest = assert.rejects(ui.request('/api/auth/me'), /別タブ/);
    await assert.rejects(ui.request('/api/admins'), /別タブ/);
    ui.password.value = 'new-password';
    const recovered = ui.request('/api/auth/me');
    if (oldFirst) {
      old.resolve({ status: 401 });
      await oldRequest;
      assert.ok(ui.document.querySelector('#session-notice'));
      assert.equal(ui.document.querySelector('#session-notice a')?.getAttribute('href'), '/admin/login');
    }
    current.resolve(ok());
    await recovered;
    if (!oldFirst) { old.resolve({ status: 401 }); await oldRequest; }
    assert.equal(ui.document.querySelector('#session-notice'), null);
    assert.equal(ui.password.value, 'new-password');
  }
});

test('a fresh failed operation clears passwords even if an earlier notice is still visible', async () => {
  const ui = createUI(async () => ({ status: 401 }));
  await assert.rejects(ui.request('/api/auth/me'), /別タブ/);
  ui.password.value = 'typed-again';
  await assert.rejects(ui.request('/api/auth/change-password', { method: 'POST' }), /別タブ/);
  assert.equal(ui.password.value, '');
  assert.equal(ui.document.querySelector('form textarea')?.value, 'unsaved draft');
});
