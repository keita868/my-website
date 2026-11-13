import assert from 'node:assert/strict';
import { test } from 'node:test';
import { page, deferred, flush } from '../test-support/dom.js';

test('an admin returned by the list before its creation response is shown once and keeps local edits', async () => {
  const fixture = page('admins');
  const pendingList = deferred();
  const pendingCreate = deferred();
  const admin = { id: 2, displayName: 'New admin', email: 'new@example.test', role: 'admin', isActive: true };
  let creationStarted = false;
  fixture.window.cmsUI = { request: async (url, options = {}) => {
    if (url === '/api/auth/me') return { admin: { role: 'superadmin' } };
    if (url === '/api/auth/csrf') return { csrfToken: 'token' };
    if (url === '/api/admins' && options.method === 'POST') {
      creationStarted = true;
      return pendingCreate.promise;
    }
    if (url === '/api/admins' && !options.method) return pendingList.promise;
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  } };
  fixture.run('admins');
  await flush();
  const createForm = fixture.document.querySelector('#create-form');
  createForm.reset = () => {};
  fixture.event(createForm, 'submit');
  await flush();
  assert.equal(creationStarted, true);
  pendingList.resolve({ admins: [admin] });
  await flush();
  const row = fixture.document.querySelector('.admin-edit-form[data-id="2"]');
  assert.ok(row);
  row.querySelector('input[name="displayName"]').value = 'Unsaved local edit';
  fixture.event(row, 'input');
  pendingCreate.resolve({ admin });
  await flush();
  assert.equal(fixture.document.querySelectorAll('.admin-edit-form[data-id="2"]').length, 1);
  assert.equal(fixture.document.querySelector('.admin-edit-form[data-id="2"]'), row);
  assert.equal(row.querySelector('input[name="displayName"]').value, 'Unsaved local edit');
  assert.match(fixture.document.querySelector('#create-error').textContent, /管理者を追加しました/);
});

for (const initial of [
  { status: 'published', scheduledAt: null },
  { status: 'draft', scheduledAt: '2099-01-02T03:04:00.000Z' }
]) {
  test(`retrying a partially loaded ${initial.status}/${initial.scheduledAt ? 'scheduled' : 'unscheduled'} editor resets schedule controls`, async () => {
    const fixture = page('update-create');
    fixture.window.location.pathname = '/admin/updates/1/edit';
    const initialSession = deferred();
    let retry = false;
    const base = { id: 1, type: 'news', title: 'Title', body: 'Body', attachments: [] };
    fixture.window.cmsUI = { request: async (url) => {
      if (url === '/api/auth/me') {
        return retry ? { admin: { role: 'superadmin', displayName: 'Owner' } } : initialSession.promise;
      }
      if (url === '/api/admin/updates/1') {
        return { update: { ...base, ...(retry ? { status: 'draft', scheduledAt: null } : initial) } };
      }
      throw new Error(`Unexpected request: ${url}`);
    } };
    fixture.run('update-create');
    await flush();
    const scheduleField = fixture.document.querySelector('#schedule-field');
    const scheduleInput = fixture.document.querySelector('input[name="scheduledAt"]');
    assert.equal(scheduleField.hidden, initial.status === 'published');
    assert.equal(Boolean(scheduleInput.value), Boolean(initial.scheduledAt));
    initialSession.reject(new Error('Temporary authentication request failure'));
    await flush();
    assert.equal(fixture.document.querySelector('#editor-retry').hidden, false);
    retry = true;
    fixture.event(fixture.document.querySelector('#editor-retry'), 'click');
    await flush();
    assert.equal(fixture.document.querySelector('#update-form').inert, false);
    assert.equal(scheduleField.hidden, false);
    assert.equal(scheduleInput.value, '');
  });
}

for (const editing of [false, true]) {
  test(`admin ${editing ? 'editing' : 'creation'} locks before CSRF, snapshots fields and recovers from failure`, async () => {
    const fixture = page('admins');
    const csrf = deferred();
    const save = deferred();
    let csrfCalls = 0;
    let writes = 0;
    let written;
    const existing = { id: 2, displayName: 'Before', email: 'before@example.test', role: 'admin', isActive: true };
    fixture.window.cmsUI = { request: async (url, options = {}) => {
      if (url === '/api/auth/me') return { admin: { role: 'superadmin' } };
      if (url === '/api/auth/csrf') { csrfCalls++; return csrf.promise; }
      if (url === '/api/admins' && !options.method) return { admins: [existing] };
      assert.equal(url, editing ? '/api/admins/2' : '/api/admins');
      assert.equal(options.method, editing ? 'PATCH' : 'POST');
      writes++;
      written = JSON.parse(options.body);
      return save.promise;
    } };
    fixture.run('admins');
    await flush();
    const form = fixture.document.querySelector(editing ? '.admin-edit-form[data-id="2"]' : '#create-form');
    const name = form.querySelector('input[name="displayName"]');
    const email = form.querySelector('input[name="email"]');
    name.value = 'Snapshot';
    email.value = 'snapshot@example.test';
    fixture.event(form, 'submit');
    assert.equal(form.inert, true);
    fixture.event(form, 'submit');
    await flush();
    assert.equal(csrfCalls, 1);
    assert.equal(writes, 0);
    // A script change proves capture is before the await; normal user input is blocked by inert.
    name.value = 'Script change during CSRF';
    csrf.resolve({ csrfToken: 'token' });
    await flush();
    assert.equal(writes, 1);
    assert.equal(written.displayName, 'Snapshot');
    assert.equal(written.email, 'snapshot@example.test');
    if (editing) assert.equal(written.isActive, true);
    save.reject(new Error('Save failed'));
    await flush();
    assert.equal(form.inert, false);
    assert.equal(form.querySelector('button[type="submit"]').disabled, false);
    assert.equal(name.value, 'Script change during CSRF');
    assert.equal(form.isConnected, true);
  });
}

for (const deleteFirst of [false, true]) {
  test(`editor sends the original revision and preserves local fields on conflict${deleteFirst ? ' after deleting an attachment' : ''}`, async () => {
    const fixture = page('update-create');
    fixture.window.location.pathname = '/admin/updates/1/edit';
    fixture.window.confirm = () => true;
    let updateReads = 0;
    let deleted = false;
    let written;
    const base = { id: 1, type: 'news', title: 'Original title', body: 'Original body', status: 'draft', scheduledAt: null, revision: 3 };
    const attachment = { id: 9, originalName: 'image.png', mimeType: 'image/png', size: 3, url: '/api/admin/updates/attachments/9/file' };
    fixture.window.cmsUI = { request: async (url, options = {}) => {
      if (url === '/api/auth/me') return { admin: { role: 'superadmin', displayName: 'Owner' } };
      if (url === '/api/auth/csrf') return { csrfToken: 'token' };
      if (url === '/api/admin/updates/1/attachments/9' && options.method === 'DELETE') { deleted = true; return {}; }
      if (url === '/api/admin/updates/1' && !options.method) {
        updateReads++;
        return { update: updateReads === 1
          ? { ...base, attachments: [attachment] }
          : { ...base, title: 'Another admin title', body: 'Another admin body', revision: 4, attachments: [] } };
      }
      assert.equal(url, '/api/admin/updates/1');
      assert.equal(options.method, 'PATCH');
      written = options;
      throw new Error('投稿状態が変更されました。画面を再読み込みしてください。');
    } };
    fixture.run('update-create');
    await flush();
    const form = fixture.document.querySelector('#update-form');
    form.elements.title.value = 'Local title';
    form.elements.body.value = 'Local body';
    form.elements.scheduledAt.value = '2099-01-02T12:34';
    fixture.event(form, 'input');
    if (deleteFirst) {
      fixture.event(fixture.document.querySelector('button[data-attachment-id="9"]'), 'click');
      await flush();
      assert.equal(deleted, true);
      assert.equal(updateReads, 2);
      assert.equal(fixture.document.querySelectorAll('button[data-attachment-id]').length, 0);
      assert.equal(form.elements.title.value, 'Local title');
      assert.equal(form.elements.body.value, 'Local body');
      assert.equal(form.elements.scheduledAt.value, '2099-01-02T12:34');
      const beforeUnload = fixture.event(fixture.window, 'beforeunload');
      assert.equal(beforeUnload.defaultPrevented, true);
    }
    fixture.event(form, 'submit', { submitter: fixture.document.querySelector('#edit-save-button') });
    await flush();
    assert.equal(written.headers['X-Update-Revision'], '3');
    assert.equal(written.body.get('title'), 'Local title');
    assert.equal(written.body.get('body'), 'Local body');
    assert.equal(form.inert, false);
    assert.equal(form.elements.title.value, 'Local title');
    assert.equal(form.elements.body.value, 'Local body');
    assert.equal(form.elements.scheduledAt.value, '2099-01-02T12:34');
    assert.deepEqual(fixture.navigations, []);
    assert.match(fixture.document.querySelector('#update-error').textContent, /入力内容は保持/);
  });
}
