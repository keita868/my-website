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
const editMatch = /^\/admin\/updates\/(\d+)\/edit\/?$/i.exec(window.location.pathname);
const editUpdateId = editMatch?.[1];
let existingAttachmentCount = 0;
let dirty = false;
let saving = false;
let loadedRevision = null;
let deletingAttachment = false;
const selectedAttachments = document.querySelector('#selected-attachments');
const loadError = document.querySelector('#editor-load-error');
const retryLoad = document.querySelector('#editor-retry');
let ready = false;
updateForm.inert = true;
updateForm.setAttribute('aria-busy', 'true');

updateForm.addEventListener('input', () => { dirty = true; });
updateForm.addEventListener('change', () => { dirty = true; });
window.addEventListener('beforeunload', (event) => {
  if (!dirty && !saving) return;
  event.preventDefault();
  event.returnValue = '';
});

function validateAttachments() {
  const files = [...attachmentInput.files];
  let message = '';
  if (existingAttachmentCount + files.length > 5) message = '保存済みの添付と合わせて最大5件までです。';
  else if (files.some((file) => file.size === 0 || file.size > 5 * 1024 * 1024)) message = '各ファイルは空ではない5MiB以下のものを選んでください。';
  else if (files.some((file) => !/\.(jpe?g|png|webp|gif|pdf)$/i.test(file.name))) message = 'JPEG、PNG、WebP、GIF、PDFを選んでください。';
  attachmentInput.setCustomValidity(message);
  return !message;
}

attachmentInput.addEventListener('change', () => {
  selectedAttachments.replaceChildren();
  const valid = validateAttachments();
  for (const file of attachmentInput.files) {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    if (valid && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      const preview = document.createElement('img');
      const reader = new FileReader();
      reader.addEventListener('load', () => { preview.src = reader.result; });
      reader.readAsDataURL(file);
      preview.alt = file.name;
      item.append(preview);
    }
    const name = document.createElement('span');
    name.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MiB)`;
    item.append(name);
    selectedAttachments.append(item);
  }
  if (!valid) attachmentInput.reportValidity();
});

const request = window.cmsUI.request;

async function csrfHeaders() {
  const { csrfToken } = await request('/api/auth/csrf');
  return { 'X-CSRF-Token': csrfToken };
}

function renderAttachments(attachments) {
  existingAttachmentCount = attachments.length;
  validateAttachments();
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

async function loadSession(options = {}) {
  const { admin } = await request('/api/auth/me', options);
  if (options.signal?.aborted) return;
  emailElement.textContent = admin.displayName || admin.email;
  adminsLink.hidden = admin.role !== 'superadmin';
}

async function loadUpdate(options = {}) {
  if (!editUpdateId) return;
  const { update } = await request(`/api/admin/updates/${editUpdateId}`, options);
  if (options.signal?.aborted) return;
  loadedRevision = Number.isSafeInteger(update.revision) ? update.revision : null;
  pageTitle.textContent = '投稿を編集';
  pageDescription.textContent = '投稿内容と添付ファイルを編集できます。';
  document.title = '投稿を編集 | 九州工業大学交響楽団';
  updateForm.elements.type.value = update.type;
  updateForm.elements.title.value = update.title;
  updateForm.elements.body.value = update.body;
  for (const field of [updateForm.elements.title, updateForm.elements.body]) field.dispatchEvent(new Event('change'));
  dirty = false;

  scheduleField.hidden = update.status === 'published';
  updateForm.elements.scheduledAt.value = update.scheduledAt
    ? new Date(update.scheduledAt).toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(' ', 'T').slice(0, 16)
    : '';
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
  if (!ready || saving || deletingAttachment || !validateAttachments()) {
    attachmentInput.reportValidity();
    return;
  }
  updateError.textContent = '';
  const submitter = event.submitter;
  const scheduled = !editUpdateId && submitter?.value === 'scheduled';
  const scheduleInput = updateForm.elements.scheduledAt;
  if (scheduled && (!scheduleInput.value || new Date(`${scheduleInput.value}:00+09:00`).getTime() <= Date.now())) {
    updateError.textContent = '予約日時に現在より後の日本時間を指定してください。';
    scheduleInput.focus();
    return;
  }
  saving = true;
  updateForm.setAttribute('aria-busy', 'true');
  const originalLabel = submitter?.textContent;
  if (submitter) submitter.textContent = '保存中…';
  const submitButtons = updateForm.querySelectorAll('button[type="submit"]');
  submitButtons.forEach((button) => { button.disabled = true; });
  const fields = new FormData(updateForm);
  const body = new FormData();
  body.set('type', fields.get('type'));
  body.set('title', fields.get('title'));
  body.set('body', fields.get('body'));
  if (!scheduleField.hidden && (editUpdateId || scheduled)) body.set('scheduledAt', fields.get('scheduledAt') || '');
  for (const file of attachmentInput.files) body.append('attachments', file);
  updateForm.inert = true;

  try {
    const headers = await csrfHeaders();
    if (editUpdateId) {
      if (loadedRevision !== null) headers['X-Update-Revision'] = String(loadedRevision);
      await request(`/api/admin/updates/${editUpdateId}`, {
        method: 'PATCH',
        headers,
        body
      });
      dirty = false;
      saving = false;
      window.location.replace('/admin/updates?updated=1');
      return;
    }

    body.set('status', submitter?.value || 'draft');
    await request('/api/admin/updates', {
      method: 'POST',
      headers,
      body
    });
    dirty = false;
    saving = false;
    window.location.replace('/admin/updates?created=1');
  } catch (error) {
    updateError.textContent = `${error.message} 入力内容は保持しています。登録状況が不明な場合は、一覧で確認してから再送信してください。`;
    submitButtons.forEach((button) => { button.disabled = false; });
    saving = false;
  } finally {
    updateForm.inert = false;
    updateForm.removeAttribute('aria-busy');
    if (submitter) submitter.textContent = originalLabel;
  }
});

attachmentList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-attachment-id]');
  if (!button || saving || deletingAttachment || !window.confirm('この添付ファイルを削除しますか？')) return;
  deletingAttachment = true;
  button.disabled = true;
  updateError.textContent = '';
  updateForm.inert = true;
  try {
    await request(`/api/admin/updates/${editUpdateId}/attachments/${button.dataset.attachmentId}`, {
      method: 'DELETE',
      headers: await csrfHeaders()
    });
    const { update } = await request(`/api/admin/updates/${editUpdateId}`);
    renderAttachments(update.attachments);
  } catch (error) {
    updateError.textContent = error.message;
    button.disabled = false;
  } finally {
    deletingAttachment = false;
    updateForm.inert = false;
  }
});

logoutButton.addEventListener('click', async () => {
  if (dirty && !window.confirm('未保存の変更があります。破棄してログアウトしますか？')) return;
  logoutButton.disabled = true;
  updateError.textContent = '';
  try {
    await request('/api/auth/logout', { method: 'POST', headers: await csrfHeaders() });
    dirty = false;
    window.location.replace('/admin/login');
  } catch (error) {
    updateError.textContent = error.message;
    logoutButton.disabled = false;
  }
});

async function initialize() {
  if (retryLoad.disabled) return;
  retryLoad.disabled = true;
  const controller = new AbortController();
  let timeout;
  retryLoad.hidden = true;
  loadError.textContent = '読み込んでいます…';
  updateForm.setAttribute('aria-busy', 'true');
  try {
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('読み込みがタイムアウトしました。')), 15000);
    });
    const options = { signal: controller.signal };
    await Promise.race([Promise.all([loadSession(options), loadUpdate(options)]), timedOut]);
    ready = true;
    updateForm.inert = false;
    loadError.textContent = '';
  } catch (error) {
    controller.abort();
    loadError.textContent = `${error.message} 読み込みを完了できませんでした。再試行してください。`;
    retryLoad.hidden = false;
  } finally {
    clearTimeout(timeout);
    retryLoad.disabled = false;
    updateForm.removeAttribute('aria-busy');
  }
}
retryLoad.addEventListener('click', initialize);
initialize();
