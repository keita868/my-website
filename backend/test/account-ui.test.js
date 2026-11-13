import assert from 'node:assert/strict';
import { test } from 'node:test';
import { page, deferred, flush } from '../test-support/dom.js';

function account(request) {
  const fixture = page('account');
  fixture.window.cmsUI = { request };
  fixture.run('account');
  return fixture;
}
const admin = { id: 1, displayName: 'Owner', email: 'owner@example.test', role: 'superadmin' };

test('profile fields stay locked until loading succeeds, and failed loading can be retried', async () => {
  let fail = true;
  const fixture = account(async () => {
    if (fail) throw new Error('offline');
    return { admin };
  });
  await flush();
  const form = fixture.document.querySelector('#profile-form');
  const retry = fixture.document.querySelector('#profile-retry');
  assert.equal(form.inert, true);
  assert.equal(fixture.document.querySelector('#password-form').inert, true);
  assert.equal(retry.hidden, false);
  fail = false;
  fixture.event(retry, 'click');
  await flush();
  assert.equal(form.inert, false);
  assert.equal(form.elements.email.value, admin.email);
  assert.equal(fixture.document.querySelector('#password-form').inert, false);
});

test('profile saving locks inputs before CSRF, prevents reentry and uses the saved response', async () => {
  const csrf = deferred();
  const saved = deferred();
  let reads = 0, csrfCalls = 0, writes = 0;
  const fixture = account(async (url, options = {}) => {
    if (url === '/api/auth/csrf') { csrfCalls++; return csrf.promise; }
    assert.equal(url, '/api/auth/me');
    if (!options.method) { reads++; return { admin }; }
    assert.equal(options.method, 'PATCH');
    assert.equal(JSON.parse(options.body).displayName, 'Changed');
    writes++;
    return saved.promise;
  });
  await flush();
  const form = fixture.document.querySelector('#profile-form');
  form.elements.displayName.value = 'Changed';
  fixture.event(form, 'submit');
  assert.equal(form.inert, true);
  fixture.event(form, 'submit');
  await flush();
  assert.equal(csrfCalls, 1);
  csrf.resolve({ csrfToken: 'token' });
  await flush();
  assert.equal(writes, 1);
  saved.resolve({ admin: { ...admin, displayName: 'Changed' } });
  await flush();
  assert.equal(reads, 1); // No second GET that can overwrite input or misreport a successful save.
  assert.equal(form.inert, false);
  assert.equal(form.elements.displayName.value, 'Changed');
  assert.match(fixture.document.querySelector('#profile-message').textContent, /保存しました/);
});

test('password changes lock inputs while pending and preserve fields on failure', async () => {
  const saved = deferred();
  let writes = 0;
  const fixture = account(async (url, options = {}) => {
    if (url === '/api/auth/me') return { admin };
    if (url === '/api/auth/csrf') return { csrfToken: 'token' };
    assert.equal(url, '/api/auth/change-password');
    assert.equal(options.method, 'POST');
    writes++;
    return saved.promise;
  });
  await flush();
  const form = fixture.document.querySelector('#password-form');
  form.elements.currentPassword.value = 'Current password';
  form.elements.newPassword.value = 'Replacement password';
  fixture.event(form, 'submit');
  assert.equal(form.inert, true);
  fixture.event(form, 'submit');
  await flush();
  assert.equal(writes, 1);
  saved.reject(new Error('offline'));
  await flush();
  assert.equal(form.inert, false);
  assert.equal(form.elements.newPassword.value, 'Replacement password');
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
});
