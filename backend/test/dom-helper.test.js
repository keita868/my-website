import assert from 'node:assert/strict';
import { test } from 'node:test';
import { page } from '../test-support/dom.js';

test('form fixture uses explicit selection, checked radios, multiple selections and File values', () => {
  const fixture = page('account');
  const form = fixture.document.createElement('form');
  form.innerHTML = `<select name="status"><option value="draft">Draft</option><option selected value="published">Published</option></select>
    <select name="empty" multiple><option value="unused">Unused</option></select>
    <select name="many" multiple><option selected value="one">One</option><option selected value="two">Two</option></select>
    <input type="radio" name="role" value="admin"><input type="radio" name="role" value="superadmin" checked>
    <input type="file" name="files" multiple><input type="file" name="emptyFile">`;
  fixture.document.body.append(form);
  const file = new File(['content'], 'sample.pdf', { type: 'application/pdf' });
  form.querySelector('input[name="files"]').files = [file];
  const data = new fixture.FormData(form);
  assert.equal(data.get('status'), 'published');
  assert.deepEqual(data.getAll('empty'), []);
  assert.deepEqual(data.getAll('many'), ['one', 'two']);
  assert.deepEqual(data.getAll('role'), ['superadmin']);
  assert.equal(data.get('files'), file);
  assert.equal(data.get('emptyFile').size, 0);
  assert.equal(data.get('emptyFile').name, '');
});
