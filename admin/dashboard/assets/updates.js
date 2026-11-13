const updateList = document.querySelector('#update-list');
const updatesError = document.querySelector('#updates-error');
const updatesMessage = document.querySelector('#updates-message');
const emailElement = document.querySelector('#admin-email');
const adminsLink = document.querySelector('#admins-nav');
const logoutButton = document.querySelector('#logout-button');

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

function formatDate(value) {
  return value ? new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '—';
}

function renderUpdate(update) {
  const item = document.createElement('article');
  item.className = 'update-row';

  const header = document.createElement('div');
  header.className = 'update-row-header';
  const title = document.createElement('h3');
  title.textContent = update.title;
  const badges = document.createElement('div');
  badges.className = 'update-badges';

  const typeBadge = document.createElement('span');
  typeBadge.className = 'update-badge';
  typeBadge.textContent = update.type === 'news' ? 'ニュース' : 'お知らせ';
  const statusBadge = document.createElement('span');
  statusBadge.className = 'update-badge';
  statusBadge.dataset.status = update.status === 'published'
    ? 'published'
    : update.scheduledAt ? 'scheduled' : 'draft';
  statusBadge.textContent = update.status === 'published'
    ? '公開'
    : update.scheduledAt ? '予約' : '下書き';
  badges.append(typeBadge, statusBadge);
  header.append(title, badges);

  const body = document.createElement('p');
  body.className = 'update-body';
  body.textContent = update.body;

  const dates = document.createElement('div');
  dates.className = 'update-dates';
  for (const [label, value] of [
    ['作成', update.createdAt],
    ['公開', update.publishedAt],
    ['予約', update.scheduledAt],
    ['更新', update.updatedAt]
  ]) {
    const date = document.createElement('span');
    date.textContent = `${label}: ${formatDate(value)}`;
    dates.append(date);
  }
  item.append(header, body, dates);

  if (update.attachments.length > 0) {
    const attachments = document.createElement('div');
    attachments.className = 'update-attachments';
    for (const attachment of update.attachments) {
      const link = document.createElement('a');
      link.className = 'update-attachment';
      link.href = attachment.url;
      link.target = '_blank';
      link.rel = 'noopener';
      if (attachment.mimeType.startsWith('image/')) {
        const preview = document.createElement('img');
        preview.src = attachment.url;
        preview.alt = attachment.originalName;
        preview.loading = 'lazy';
        link.append(preview);
      }
      const name = document.createElement('span');
      name.textContent = attachment.originalName;
      link.append(name);
      attachments.append(link);
    }
    item.append(attachments);
  }

  const actions = document.createElement('div');
  actions.className = 'update-row-actions';
  const editLink = document.createElement('a');
  editLink.className = 'secondary-button';
  editLink.href = `/admin/updates/${update.id}/edit`;
  editLink.textContent = '編集';
  actions.append(editLink);
  if (update.status === 'draft') {
    const publishButton = document.createElement('button');
    publishButton.className = 'secondary-button';
    publishButton.type = 'button';
    publishButton.dataset.publishId = update.id;
    publishButton.textContent = update.scheduledAt ? '今すぐ公開' : '公開する';
    actions.append(publishButton);
  } else {
    const unpublishButton = document.createElement('button');
    unpublishButton.className = 'secondary-button';
    unpublishButton.type = 'button';
    unpublishButton.dataset.unpublishId = update.id;
    unpublishButton.textContent = '公開を取り下げる';
    actions.append(unpublishButton);
  }
  const deleteButton = document.createElement('button');
  deleteButton.className = 'danger-button';
  deleteButton.type = 'button';
  deleteButton.dataset.deleteId = update.id;
  deleteButton.textContent = '削除';
  actions.append(deleteButton);
  item.append(actions);
  return item;
}

async function loadPage() {
  const [{ admin }, { updates }] = await Promise.all([
    request('/api/auth/me'),
    request('/api/admin/updates')
  ]);
  emailElement.textContent = admin.displayName || admin.email;
  adminsLink.hidden = admin.role !== 'superadmin';

  if (updates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '投稿はまだありません。';
    updateList.replaceChildren(empty);
    return;
  }
  updateList.replaceChildren(...updates.map(renderUpdate));
}

updateList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-publish-id], button[data-unpublish-id], button[data-delete-id]');
  if (!button) return;
  if (button.dataset.deleteId
    && !window.confirm('この投稿と添付ファイルを削除します。この操作は取り消せません。よろしいですか？')) return;
  if (button.dataset.unpublishId
    && !window.confirm('この投稿の公開を取り下げ、下書きに戻しますか？')) return;
  button.disabled = true;
  updatesError.textContent = '';
  updatesMessage.textContent = '';
  try {
    if (button.dataset.deleteId) {
      await request(`/api/admin/updates/${button.dataset.deleteId}`, {
        method: 'DELETE',
        headers: await csrfHeaders()
      });
      updatesMessage.textContent = '投稿を削除しました。';
    } else {
      const isUnpublish = Boolean(button.dataset.unpublishId);
      const updateId = button.dataset.unpublishId || button.dataset.publishId;
      await request(`/api/admin/updates/${updateId}/${isUnpublish ? 'unpublish' : 'publish'}`, {
        method: 'POST',
        headers: await csrfHeaders()
      });
      updatesMessage.textContent = isUnpublish ? '投稿の公開を取り下げました。' : '投稿を公開しました。';
    }
    await loadPage();
  } catch (error) {
    updatesError.textContent = error.message;
    button.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  updatesError.textContent = '';
  try {
    await request('/api/auth/logout', { method: 'POST', headers: await csrfHeaders() });
    window.location.replace('/admin/login');
  } catch (error) {
    updatesError.textContent = error.message;
    logoutButton.disabled = false;
  }
});

const result = new URLSearchParams(window.location.search);
if (result.get('created') === '1') {
  updatesMessage.textContent = '投稿を登録しました。';
} else if (result.get('updated') === '1') {
  updatesMessage.textContent = '投稿を更新しました。';
}

loadPage().catch((error) => {
  updatesError.textContent = error.message;
});
