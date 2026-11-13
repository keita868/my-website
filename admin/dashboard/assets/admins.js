const adminList = document.querySelector('#admin-list');
const listError = document.querySelector('#list-error');
const createForm = document.querySelector('#create-form');
const createError = document.querySelector('#create-error');
const emailElement = document.querySelector('#admin-email');
const logoutButton = document.querySelector('#logout-button');
const retryList = document.querySelector('#admin-list-retry');
let ready = false;
let creating = false;
const savingForms = new WeakSet();
createForm.inert = true;

const request = window.cmsUI.request;

async function csrfHeaders() {
  const { csrfToken } = await request('/api/auth/csrf');
  return { 'X-CSRF-Token': csrfToken };
}

function renderAdmin(admin) {
  const item = document.createElement('article');
  item.className = 'admin-row';

  const form = document.createElement('form');
  form.className = 'admin-edit-form';
  form.dataset.id = admin.id;
  const fields = document.createElement('div');
  fields.className = 'admin-edit-fields';
  fields.append(
    createInput('displayName', '表示名', admin.displayName || '', 'text'),
    createInput('email', 'メールアドレス', admin.email, 'email')
  );

  const roleLabel = document.createElement('label');
  roleLabel.textContent = '権限';
  const role = document.createElement('select');
  role.name = 'role';
  for (const [value, label] of [['admin', '管理者'], ['superadmin', 'システム管理者']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = admin.role === value;
    role.append(option);
  }
  roleLabel.append(role);
  fields.append(roleLabel);

  const activeLabel = document.createElement('label');
  activeLabel.className = 'active-toggle';
  const active = document.createElement('input');
  active.name = 'isActive';
  active.type = 'checkbox';
  active.checked = admin.isActive;
  activeLabel.append(active, document.createTextNode('有効'));
  fields.append(activeLabel);

  const actions = document.createElement('div');
  actions.className = 'admin-row-actions';
  const status = document.createElement('span');
  status.className = 'admin-meta';
  status.textContent = `最終ログイン: ${admin.lastLoginAt ? new Date(admin.lastLoginAt).toLocaleString('ja-JP') : 'なし'}`;
  const save = document.createElement('button');
  save.className = 'secondary-button';
  save.type = 'submit';
  save.textContent = '変更を保存';
  actions.append(status, save);
  form.append(fields, actions);
  item.append(form);
  return item;
}

function createInput(name, labelText, value, type) {
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.name = name;
  input.type = type;
  input.value = value;
  input.required = true;
  if (name === 'displayName') input.maxLength = 80;
  if (name === 'email') input.maxLength = 254;
  label.append(input);
  return label;
}

function appendAdminIfMissing(admin) {
  if (!adminList.querySelector(`.admin-edit-form[data-id="${admin.id}"]`)) {
    adminList.append(renderAdmin(admin));
  }
}

async function loadPage() {
  const { admin: me } = await request('/api/auth/me');
  if (me.role !== 'superadmin') throw new Error('管理者を追加する権限がありません。');
  emailElement.textContent = me.displayName || me.email;
  ready = true;
  createForm.inert = false;
  await loadList();
}

async function loadList() {
  if (retryList.disabled) return;
  retryList.disabled = true;
  retryList.hidden = true;
  listError.textContent = '管理者一覧を読み込んでいます…';
  delete listError.dataset.success;
  try {
    const { admins } = await request('/api/admins');
    // Keep local edits and rows added while this request was pending.
    for (const admin of admins) {
      appendAdminIfMissing(admin);
    }
    listError.textContent = '';
  } catch (error) {
    listError.textContent = `${error.message} 管理者一覧を読み込めませんでした。再試行してください。`;
    retryList.hidden = false;
  } finally {
    retryList.disabled = false;
  }
}
retryList.addEventListener('click', loadList);

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ready || creating) return;
  creating = true;
  createForm.inert = true;
  createForm.setAttribute('aria-busy', 'true');
  createError.textContent = '';
  delete createError.dataset.success;
  const button = createForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const fields = Object.fromEntries(new FormData(createForm));
    const { admin } = await request('/api/admins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...await csrfHeaders() },
      body: JSON.stringify(fields)
    });
    createForm.reset();
    appendAdminIfMissing(admin);
    createError.dataset.success = '';
    createError.textContent = '管理者を追加しました。';
  } catch (error) {
    createError.textContent = error.message;
  } finally {
    creating = false;
    createForm.inert = false;
    createForm.removeAttribute('aria-busy');
    button.disabled = false;
  }
});

adminList.addEventListener('submit', async (event) => {
  if (!event.target.matches('.admin-edit-form')) return;
  event.preventDefault();
  const form = event.target;
  if (savingForms.has(form)) return;
  savingForms.add(form);
  form.inert = true;
  form.setAttribute('aria-busy', 'true');
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  listError.textContent = '';
  delete listError.dataset.success;
  try {
    const fields = new FormData(form);
    const { admin } = await request(`/api/admins/${form.dataset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...await csrfHeaders() },
      body: JSON.stringify({
        displayName: fields.get('displayName'),
        email: fields.get('email'),
        role: fields.get('role'),
        isActive: fields.get('isActive') === 'on'
      })
    });
    form.closest('.admin-row').replaceWith(renderAdmin(admin));
    listError.dataset.success = '';
    listError.textContent = '変更を保存しました。';
  } catch (error) {
    listError.textContent = error.message;
  } finally {
    savingForms.delete(form);
    form.inert = false;
    form.removeAttribute('aria-busy');
    button.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await request('/api/auth/logout', { method: 'POST', headers: await csrfHeaders() });
    window.location.replace('/admin/login');
  } catch (error) {
    listError.textContent = error.message;
  }
});

loadPage().catch((error) => {
  listError.textContent = `${error.message} 管理者一覧を読み込めませんでした。画面を再読み込みしてください。`;
});
