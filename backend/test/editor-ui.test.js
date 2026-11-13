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
  const csrf = deferred();
  let csrfCalls = 0;
  let writes = 0;
  const fixture = editor(async (url, options = {}) => {
    if (url === '/api/auth/me') return { admin: { displayName: 'Owner' } };
    if (url === '/api/auth/csrf') { csrfCalls++; return csrf.promise; }
    assert.equal(url, '/api/admin/updates');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('body'), 'Body');
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
  assert.equal(csrfCalls, 1);
  assert.equal(writes, 0);
  csrf.resolve({ csrfToken: 'token' });
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

test('admin creation waits for permissions and a new row survives late list loading', async () => {
  const pending = deferred();
  const fixture = page('admins');
  let writes = 0;
  fixture.window.cmsUI = { request: async (url, options = {}) => {
    if (url === '/api/auth/me') return { admin: { role: 'superadmin' } };
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
  assert.equal(form.inert, false);
  fixture.event(form, 'submit');
  await flush();
  assert.equal(writes, 1);
  const createdRow = fixture.document.querySelector('.admin-edit-form[data-id="2"]');
  assert.ok(createdRow);
  assert.equal(createdRow.querySelector('input[name="displayName"]').value, 'New');
  pending.resolve({ admins: [{ id: 1, displayName: 'Owner', email: 'owner@example.test', role: 'superadmin' }, { id: 2, displayName: 'Stale name' }] });
  await flush();
  assert.equal(fixture.document.querySelectorAll('.admin-row').length, 2);
  assert.ok(fixture.document.querySelector('.admin-edit-form[data-id="2"]'));
  assert.equal(fixture.document.querySelectorAll('.admin-edit-form[data-id="2"]').length, 1);
  assert.equal(fixture.document.querySelector('.admin-edit-form[data-id="2"]'), createdRow);
  assert.equal(createdRow.querySelector('input[name="displayName"]').value, 'New');
});

test('failed list loading allows authorized creation and retry does not replace local edits', async () => {
  const fixture = page('admins');
  let fail = true;
  fixture.window.cmsUI = { request: async (url, options = {}) => {
    if (url === '/api/auth/me') return { admin: { role: 'superadmin' } };
    if (url === '/api/auth/csrf') return { csrfToken: 'token' };
    if (options.method === 'POST') return { admin: { id: 2, displayName: 'New', role: 'admin' } };
    if (fail) throw new Error('offline');
    return { admins: [{ id: 2, displayName: 'Old' }, { id: 1, displayName: 'Owner' }] };
  } };
  fixture.run('admins');
  await flush();
  const form = fixture.document.querySelector('#create-form');
  form.reset = () => {};
  const retry = fixture.document.querySelector('#admin-list-retry');
  assert.equal(form.inert, false);
  assert.equal(retry.hidden, false);
  fixture.event(form, 'submit');
  await flush();
  const name = fixture.document.querySelector('.admin-edit-form[data-id="2"] input');
  name.value = 'Unsaved edit';
  fail = false;
  fixture.event(retry, 'click');
  await flush();
  assert.equal(fixture.document.querySelectorAll('.admin-row').length, 2);
  assert.equal(fixture.document.querySelector('.admin-edit-form[data-id="2"] input').value, 'Unsaved edit');
});

test('editor fails promptly, aborts pending loading, and ignores its late result after retry', async () => {
  const fixture = page('update-create');
  fixture.window.location.pathname = '/admin/updates/1/edit';
  const pending = deferred();
  let attempts = 0;
  let oldSignal;
  fixture.window.cmsUI = { request: async (url, options) => {
    if (url === '/api/auth/me') {
      attempts++;
      if (attempts === 1) throw new Error('offline');
      return { admin: { displayName: 'Current owner' } };
    }
    if (attempts === 1) { oldSignal = options.signal; return pending.promise; }
    return { update: { title: 'Current title', body: 'Current body', type: 'news', status: 'draft', attachments: [] } };
  } };
  fixture.run('update-create');
  await flush();
  const retry = fixture.document.querySelector('#editor-retry');
  assert.equal(retry.hidden, false);
  assert.equal(oldSignal.aborted, true);
  fixture.event(retry, 'click');
  await flush();
  const form = fixture.document.querySelector('form');
  assert.equal(form.inert, false);
  assert.equal(form.elements.title.value, 'Current title');
  pending.resolve({ update: { title: 'Stale title', body: 'Stale body', type: 'news', status: 'draft', attachments: [] } });
  await flush();
  assert.equal(form.elements.title.value, 'Current title');
});

test('list failure replaces the loading count', async () => {
  const fixture = page('updates');
  fixture.window.cmsUI = { request: async () => { throw new Error('offline'); } };
  fixture.run('updates');
  await flush();
  assert.match(fixture.document.querySelector('#update-count').textContent, /読み込めません/);
});

test('editor loading has a bounded timeout even when a request never settles', async () => {
  const fixture = page('update-create');
  let timeout;
  let signal;
  fixture.context.setTimeout = (callback, milliseconds) => { timeout = { callback, milliseconds }; return 1; };
  fixture.context.clearTimeout = () => {};
  fixture.window.cmsUI = { request: (_url, options) => { signal = options.signal; return new Promise(() => {}); } };
  fixture.run('update-create');
  assert.equal(timeout.milliseconds, 15000);
  timeout.callback();
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(fixture.document.querySelector('form').inert, true);
  assert.equal(fixture.document.querySelector('#editor-retry').hidden, false);
  assert.match(fixture.document.querySelector('#editor-load-error').textContent, /タイムアウト/);
});

test('admin creation remains locked when permission verification fails', async () => {
  const fixture = page('admins');
  let writes = 0;
  fixture.window.cmsUI = { request: async (_url, options = {}) => {
    if (options.method) writes++;
    return { admin: { role: 'admin' } };
  } };
  fixture.run('admins');
  await flush();
  const form = fixture.document.querySelector('#create-form');
  fixture.event(form, 'submit');
  await flush();
  assert.equal(form.inert, true);
  assert.equal(writes, 0);
});
