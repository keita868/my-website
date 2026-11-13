import assert from 'node:assert/strict';
import { test } from 'node:test';
import { page, deferred, flush } from '../test-support/dom.js';

test('credential forms use POST even when JavaScript has not loaded', () => {
  for (const name of ['login', 'account', 'admins']) {
    const { document } = page(name);
    for (const input of document.querySelectorAll('input[type="password"]')) {
      const form = input.closest('form');
      assert.equal(form.getAttribute('method').toLowerCase(), 'post');
      assert.ok(form.getAttribute('action').startsWith('/api/'));
    }
  }
});

test('login submission is intercepted immediately, including while CSRF is pending', async () => {
  const csrf = deferred();
  let csrfCalls = 0, writes = 0;
  const fixture = page('login', async (url, options = {}) => {
    if (url === '/api/auth/csrf') { csrfCalls++; return csrf.promise; }
    assert.equal(url, '/api/auth/login');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).password, 'private-password');
    writes++;
    return { ok: false, status: 401, json: async () => ({ error: 'incorrect' }) };
  });
  fixture.run('login');
  const form = fixture.document.querySelector('form');
  form.elements.email.value = 'owner@example.test';
  form.elements.password.value = 'private-password';
  const first = fixture.event(form, 'submit');
  assert.equal(first.defaultPrevented, true);
  const second = fixture.event(form, 'submit');
  assert.equal(second.defaultPrevented, true);
  assert.equal(csrfCalls, 1);
  assert.equal(writes, 0);
  csrf.resolve({ ok: true, json: async () => ({ csrfToken: 'token' }) });
  await flush();
  assert.equal(writes, 1);
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
  assert.deepEqual(fixture.navigations, []);
});
