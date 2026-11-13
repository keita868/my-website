const profileForm = document.querySelector('#profile-form');
const passwordForm = document.querySelector('#password-form');
const profileMessage = document.querySelector('#profile-message');
const passwordMessage = document.querySelector('#password-message');
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

async function loadProfile() {
  const { admin } = await request('/api/auth/me');
  emailElement.textContent = admin.displayName || admin.email;
  adminsLink.hidden = admin.role !== 'superadmin';
  profileForm.elements.displayName.value = admin.displayName || '';
  profileForm.elements.email.value = admin.email;
}

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  profileMessage.textContent = '';
  const button = profileForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request('/api/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...await csrfHeaders() },
      body: JSON.stringify(Object.fromEntries(new FormData(profileForm)))
    });
    await loadProfile();
    profileMessage.textContent = 'プロフィールを保存しました。';
  } catch (error) {
    profileMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  passwordMessage.textContent = '';
  const button = passwordForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...await csrfHeaders() },
      body: JSON.stringify(Object.fromEntries(new FormData(passwordForm)))
    });
    window.location.replace('/admin/login');
  } catch (error) {
    passwordMessage.textContent = error.message;
    button.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await request('/api/auth/logout', { method: 'POST', headers: await csrfHeaders() });
    window.location.replace('/admin/login');
  } catch (error) {
    profileMessage.textContent = error.message;
  }
});

loadProfile().catch((error) => {
  profileMessage.textContent = error.message;
});
