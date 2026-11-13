import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../../admin/dashboard/assets/ui.js', import.meta.url), 'utf8');

function createUI(fetch) {
  const password = { value: 'private-password' };
  const draft = { value: 'unsaved draft' };
  let removed = false;
  const window = {};
  Object.defineProperty(window, 'location', { get() { throw new Error('Unexpected navigation'); } });
  const document = {
    querySelectorAll(selector) {
      return selector.includes('data-password') ? [password] : [];
    },
    // An existing notice lets the test focus on recovery and request behavior.
    querySelector() { return { remove() { removed = true; } }; }
  };
  vm.runInNewContext(source, { window, document, fetch });
  return { request: window.cmsUI.request, password, draft, removed: () => removed };
}

test('session expiry preserves the page, clears passwords and never retries the write', async () => {
  let calls = 0;
  const ui = createUI(async (_url, options) => {
    calls += 1;
    assert.equal(options.credentials, 'same-origin');
    return { status: 401 };
  });
  await assert.rejects(ui.request('/api/admin/updates', { method: 'POST' }), /別タブ/);
  assert.equal(ui.password.value, '');
  assert.equal(ui.draft.value, 'unsaved draft');
  assert.equal(calls, 1);
});

test('rate limiting communicates the server retry time without resubmitting', async () => {
  let calls = 0;
  const ui = createUI(async () => {
    calls += 1;
    return { status: 429, ok: false, headers: new Headers({ 'Retry-After': '61' }), json: async () => ({ error: 'しばらくお待ちください。' }) };
  });
  await assert.rejects(ui.request('/api/auth/change-password'), /約2分後/);
  assert.equal(calls, 1);
});

test('getting a CSRF token alone does not dismiss the session expiry notice', async () => {
  const ui = createUI(async () => ({ status: 200, ok: true, json: async () => ({ csrfToken: 'token' }) }));
  await ui.request('/api/auth/csrf');
  assert.equal(ui.removed(), false);
  await ui.request('/api/auth/me');
  assert.equal(ui.removed(), true);
});

test('network failures explain how to avoid duplicate saves', async () => {
  const ui = createUI(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(ui.request('/api/admin/updates', { method: 'POST' }), /一覧で保存状況を確認/);
});
