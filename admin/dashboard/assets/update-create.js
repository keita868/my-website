const updateForm = document.querySelector('#update-form');
const updateError = document.querySelector('#update-error');
const emailElement = document.querySelector('#admin-email');
const adminsLink = document.querySelector('#admins-nav');
const logoutButton = document.querySelector('#logout-button');
const attachmentInput = document.querySelector('#attachments');
const attachmentList = document.querySelector('#attachment-list');
const pageTitle = document.querySelector('#page-title');
const pageDescription = document.querySelector('#page-description');
const scheduleField = document.querySelector('#schedule-field');
const editMatch = /^\/admin\/updates\/(\d+)\/edit$/.exec(window.location.pathname);
const editUpdateId = editMatch?.[1];

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  if (response.status === 401) {
    window.location.replace('/admin/login');
    throw new Error('ログインが必要です。');
  }
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || 'リクエストに失敗しました。');
  return data;
}

async function csrfHeaders() {
  const { csrfToken } = await request('/api/auth/csrf');
  return { 'X-CSRF-Token': csrfToken };
}

function renderAttachments(attachments) {
  attachmentList.replaceChildren();
  for (const attachment of attachments) {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    if (attachment.mimeType.startsWith('image/')) {
      const preview = document.createElement('img');
      preview.src = attachment.url;
      preview.alt = attachment.originalName;
      preview.loading = 'lazy';
      item.append(preview);
    }

    const link = document.createElement('a');
    link.href = attachment.url;
    link.textContent = `${attachment.originalName} (${(attachment.size / 1024 / 1024).toFixed(2)} MiB)`;
    link.target = '_blank';
    link.rel = 'noopener';
    item.append(link);

    if (editUpdateId) {
      const removeButton = document.createElement('button');
      removeButton.className = 'text-button';
      removeButton.type = 'button';
      removeButton.dataset.attachmentId = attachment.id;
      removeButton.textContent = '削除';
      item.append(removeButton);
    }
    attachmentList.append(item);
  }
}

async function loadSession() {
  const { admin } = await request('/api/auth/me');
  emailElement.textContent = admin.displayName || admin.email;
  adminsLink.hidden = admin.role !== 'superadmin';
}

async function loadUpdate() {
  if (!editUpdateId) return;
  const { update } = await request(`/api/admin/updates/${editUpdateId}`);
  pageTitle.textContent = '投稿を編集';
  pageDescription.textContent = '投稿内容と添付ファイルを編集できます。';
  document.title = '投稿を編集 | 九州工業大学交響楽団';
  updateForm.elements.type.value = update.type;
  updateForm.elements.title.value = update.title;
  updateForm.elements.body.value = update.body;

  if (update.status === 'published') {
    scheduleField.hidden = true;
  } else if (update.scheduledAt) {
    updateForm.elements.scheduledAt.value = new Date(update.scheduledAt)
      .toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(' ', 'T');
  }
  updateForm.querySelectorAll('button[name="status"]').forEach((button) => { button.hidden = true; });
  if (!updateForm.querySelector('#edit-save-button')) {
    const saveButton = document.createElement('button');
    saveButton.id = 'edit-save-button';
    saveButton.className = 'primary-button';
    saveButton.type = 'submit';
    saveButton.textContent = '変更を保存';
    updateForm.querySelector('.update-submit-actions').append(saveButton);
  }
  renderAttachments(update.attachments);
}

updateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  updateError.textContent = '';
  const submitter = event.submitter;
  const submitButtons = updateForm.querySelectorAll('button[type="submit"]');
  submitButtons.forEach((button) => { button.disabled = true; });
  const fields = new FormData(updateForm);
  const body = new FormData();
  body.set('type', fields.get('type'));
  body.set('title', fields.get('title'));
  body.set('body', fields.get('body'));
  if (!scheduleField.hidden) body.set('scheduledAt', fields.get('scheduledAt') || '');
  for (const file of attachmentInput.files) body.append('attachments', file);

  try {
    const headers = await csrfHeaders();
    if (editUpdateId) {
      await request(`/api/admin/updates/${editUpdateId}`, {
        method: 'PATCH',
        headers,
        body
      });
      window.location.replace('/admin/updates?updated=1');
      return;
    }

    body.set('status', submitter?.value || 'draft');
    await request('/api/admin/updates', {
      method: 'POST',
      headers,
      body
    });
    window.location.replace('/admin/updates?created=1');
  } catch (error) {
    updateError.textContent = `${error.message} 入力内容は保持しています。登録状況が不明な場合は、一覧で確認してから再送信してください。`;
    submitButtons.forEach((button) => { button.disabled = false; });
  }
});

attachmentList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-attachment-id]');
  if (!button || !window.confirm('この添付ファイルを削除しますか？')) return;
  button.disabled = true;
  updateError.textContent = '';
  const formValues = {
    type: updateForm.elements.type.value,
    title: updateForm.elements.title.value,
    body: updateForm.elements.body.value,
    scheduledAt: updateForm.elements.scheduledAt.value
  };
  try {
    await request(`/api/admin/updates/${editUpdateId}/attachments/${button.dataset.attachmentId}`, {
      method: 'DELETE',
      headers: await csrfHeaders()
    });
    await loadUpdate();
    updateForm.elements.type.value = formValues.type;
    updateForm.elements.title.value = formValues.title;
    updateForm.elements.body.value = formValues.body;
    updateForm.elements.scheduledAt.value = formValues.scheduledAt;
  } catch (error) {
    updateError.textContent = error.message;
    button.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  updateError.textContent = '';
  try {
    await request('/api/auth/logout', { method: 'POST', headers: await csrfHeaders() });
    window.location.replace('/admin/login');
  } catch (error) {
    updateError.textContent = error.message;
    logoutButton.disabled = false;
  }
});

Promise.all([loadSession(), loadUpdate()]).catch((error) => {
  updateError.textContent = error.message;
});
