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

test('clearing a select omits it from FormData until an option is selected', () => {
  const fixture = page('account');
  const form = fixture.document.createElement('form');
  form.innerHTML = '<select name="choice"><option value="a">A</option><option value="b">B</option></select>';
  fixture.document.body.append(form);
  const select = form.querySelector('select');
  assert.equal(select.value, 'a');
  assert.equal(new fixture.FormData(form).get('choice'), 'a');
  for (const missing of ['', 'missing']) {
    select.value = missing;
    assert.equal(select.value, '');
    assert.equal(new fixture.FormData(form).has('choice'), false);
    select.value = 'b';
    assert.equal(select.value, 'b');
    assert.equal(new fixture.FormData(form).get('choice'), 'b');
  }
  const empty = fixture.document.createElement('option');
  empty.value = '';
  select.append(empty);
  select.value = '';
  assert.deepEqual(new fixture.FormData(form).getAll('choice'), ['']);
});

test('assigning a duplicate value selects only the first option in single and multiple selects', () => {
  const fixture = page('account');
  for (const multiple of [false, true]) {
    const form = fixture.document.createElement('form');
    form.innerHTML = `<select name="choice" ${multiple ? 'multiple' : ''}><option value="a">First</option><option value="a">Second</option><option value="b" selected>B</option></select>`;
    fixture.document.body.append(form);
    const select = form.querySelector('select');
    select.value = 'a';
    assert.equal(select.querySelectorAll('option[selected]').length, 1);
    assert.equal(select.querySelector('option[selected]'), select.querySelector('option'));
    assert.deepEqual(new fixture.FormData(form).getAll('choice'), ['a']);
  }
});

test('checked checkbox and radio defaults use on while explicit empty values and unchecked states are preserved', () => {
  const fixture = page('account');
  for (const type of ['checkbox', 'radio']) {
    const form = fixture.document.createElement('form');
    form.innerHTML = `<input type="${type}" name="default" checked>
      <input type="${type}" name="empty" value="" checked>
      <input type="${type}" name="custom" value="yes" checked>
      <input type="${type}" name="unchecked">
      <input type="${type}" name="changed" checked>`;
    fixture.document.body.append(form);
    form.querySelector('[name="changed"]').checked = false;
    const dynamic = fixture.document.createElement('input');
    dynamic.type = type;
    dynamic.name = 'dynamic';
    dynamic.checked = true;
    form.append(dynamic);
    const data = new fixture.FormData(form);
    assert.equal(data.get('default'), 'on');
    assert.equal(data.get('empty'), '');
    assert.equal(data.get('custom'), 'yes');
    assert.equal(data.get('dynamic'), 'on');
    assert.equal(data.has('unchecked'), false);
    assert.equal(data.has('changed'), false);
  }
});
