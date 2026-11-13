import assert from 'node:assert/strict';
import { test } from 'node:test';
import { page, deferred, flush } from '../test-support/dom.js';

function editor(request) {
  const fixture = page('update-create');
  fixture.window.cmsUI = { request };
  fixture.run('update-create');
  return fixture;
}

test('failed initial loading keeps the form locked until a successful retry', async () => {
  let fail = true;
  const fixture = editor(async () => {
    if (fail) throw new Error('offline');
    return { admin: { displayName: 'Owner' } };
  });
  const form = fixture.document.querySelector('form');
  await flush();
  assert.equal(form.inert, true);
  assert.equal(fixture.document.querySelector('#editor-retry').hidden, false);
  assert.ok(!form.contains(fixture.document.querySelector('#editor-load-error')));
  fail = false;
  fixture.event(fixture.document.querySelector('#editor-retry'), 'click');
  await flush();
  assert.equal(form.inert, false);
  assert.equal(fixture.document.querySelector('#editor-retry').hidden, true);
});

test('saving locks the entire editor, prevents duplicate writes and unlocks on failure', async () => {
  const saved = deferred();
  let writes = 0;
  const fixture = editor(async (url) => {
    if (url === '/api/auth/me') return { admin: { displayName: 'Owner' } };
    if (url === '/api/auth/csrf') return { csrfToken: 'token' };
    writes++;
    return saved.promise;
  });
  await flush();
  const form = fixture.document.querySelector('form');
  form.elements.title.value = 'Title';
  form.elements.body.value = 'Body';
  const button = form.querySelector('button[value="draft"]');
  fixture.event(form, 'submit', { submitter: button });
  await flush();
  assert.equal(form.inert, true);
  fixture.event(form, 'submit', { submitter: button });
  await flush();
  assert.equal(writes, 1);
  saved.reject(new Error('offline'));
  await flush();
  assert.equal(form.inert, false);
  assert.equal(form.elements.body.value, 'Body');
  assert.deepEqual(fixture.navigations, []);
});

test('filters do not turn loading into a false empty list', async () => {
  const pending = deferred();
  const fixture = page('updates');
  fixture.window.cmsUI = { request: (url) => url === '/api/auth/me' ? Promise.resolve({ admin: {} }) : pending.promise };
  fixture.run('updates');
  const search = fixture.document.querySelector('#update-search');
  search.value = 'missing';
  fixture.event(search, 'input');
  assert.match(fixture.document.querySelector('#update-count').textContent, /読み込んで/);
  assert.doesNotMatch(fixture.document.querySelector('#update-list').textContent, /投稿はまだ/);
  pending.resolve({ updates: [{ id: 1, title: 'Title', body: 'Body', status: 'draft', attachments: [] }] });
  await flush();
  assert.match(fixture.document.querySelector('#update-list').textContent, /条件に一致する投稿がありません/);
});

test('admin creation waits for initial loading and a new row survives its completion', async () => {
  const pending = deferred();
  const fixture = page('admins');
  let writes = 0;
  fixture.window.cmsUI = { request: async (url, options = {}) => {
    if (url === '/api/auth/me') return { admin: {} };
    if (url === '/api/auth/csrf') return { csrfToken: 'token' };
    if (options.method === 'POST') {
      writes++;
      return { admin: { id: 2, displayName: 'New', email: 'new@example.test', role: 'admin' } };
    }
    return pending.promise;
  } };
  fixture.run('admins');
  const form = fixture.document.querySelector('#create-form');
  form.reset = () => {};
  assert.equal(form.inert, true);
  fixture.event(form, 'submit');
  await flush();
  assert.equal(writes, 0);
  pending.resolve({ admins: [{ id: 1, displayName: 'Owner', email: 'owner@example.test', role: 'superadmin' }] });
  await flush();
  assert.equal(form.inert, false);
  fixture.event(form, 'submit');
  await flush();
  assert.equal(writes, 1);
  assert.equal(fixture.document.querySelectorAll('.admin-row').length, 2);
  assert.ok(fixture.document.querySelector('.admin-edit-form[data-id="2"]'));
});
