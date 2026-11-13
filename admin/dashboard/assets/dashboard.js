const emailElement = document.querySelector('#admin-email');
const logoutButton = document.querySelector('#logout-button');
const errorElement = document.querySelector('#dashboard-error');
const adminsLink = document.querySelector('#admins-nav');

async function loadSession() {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
  if (response.status === 401) {
    window.location.replace('/admin/login');
    return;
  }
  if (!response.ok) throw new Error('管理者情報を読み込めませんでした。');
  const { admin } = await response.json();
  emailElement.textContent = admin.displayName || admin.email;
  adminsLink.hidden = admin.role !== 'superadmin';
}

async function logout() {
  logoutButton.disabled = true;
  errorElement.textContent = '';
  try {
    const csrfResponse = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
    if (!csrfResponse.ok) throw new Error('ログアウトを開始できませんでした。');
    const { csrfToken } = await csrfResponse.json();
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken }
    });
    if (!response.ok) throw new Error('ログアウトできませんでした。');
    window.location.replace('/admin/login');
  } catch (error) {
    errorElement.textContent = error.message;
    logoutButton.disabled = false;
  }
}

loadSession().catch((error) => {
  errorElement.textContent = error.message;
});
logoutButton.addEventListener('click', logout);
