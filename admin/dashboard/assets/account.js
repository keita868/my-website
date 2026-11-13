const profileForm = document.querySelector('#profile-form');
const passwordForm = document.querySelector('#password-form');
const profileMessage = document.querySelector('#profile-message');
const passwordMessage = document.querySelector('#password-message');
const emailElement = document.querySelector('#admin-email');
const adminsLink = document.querySelector('#admins-nav');
const logoutButton = document.querySelector('#logout-button');
const retryProfile = document.querySelector('#profile-retry');
let ready = false;
let loading = false;
let profileSaving = false;
let passwordSaving = false;
profileForm.inert = true;
passwordForm.inert = true;

const request = window.cmsUI.request;

async function csrfHeaders() {
  const { csrfToken } = await request('/api/auth/csrf');
  return { 'X-CSRF-Token': csrfToken };
}

function renderProfile(admin) {
  emailElement.textContent = admin.displayName || admin.email;
  adminsLink.hidden = admin.role !== 'superadmin';
  profileForm.elements.displayName.value = admin.displayName || '';
  profileForm.elements.email.value = admin.email;
}

async function loadProfile() {
  if (loading) return;
  loading = true;
  retryProfile.hidden = true;
  profileMessage.textContent = 'プロフィールを読み込んでいます…';
  try {
    const { admin } = await request('/api/auth/me');
    renderProfile(admin);
    ready = true;
    profileForm.inert = false;
    passwordForm.inert = false;
    profileMessage.textContent = '';
  } catch (error) {
    profileMessage.textContent = `${error.message} 読み込みを再試行してください。`;
    retryProfile.hidden = false;
  } finally {
    loading = false;
  }
}
retryProfile.addEventListener('click', loadProfile);

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ready || profileSaving) return;
  profileSaving = true;
  const body = JSON.stringify(Object.fromEntries(new FormData(profileForm)));
  profileForm.inert = true;
  profileMessage.textContent = '';
  delete profileMessage.dataset.success;
  const button = profileForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const { admin } = await request('/api/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...await csrfHeaders() },
      body
    });
    renderProfile(admin);
    profileMessage.textContent = 'プロフィールを保存しました。';
    profileMessage.dataset.success = '';
  } catch (error) {
    profileMessage.textContent = error.message;
  } finally {
    button.disabled = false;
    profileSaving = false;
    profileForm.inert = false;
  }
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ready || passwordSaving) return;
  passwordSaving = true;
  const body = JSON.stringify(Object.fromEntries(new FormData(passwordForm)));
  passwordForm.inert = true;
  passwordMessage.textContent = '';
  const button = passwordForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...await csrfHeaders() },
      body
    });
    window.location.replace('/admin/login');
  } catch (error) {
    passwordMessage.textContent = error.message;
    button.disabled = false;
  } finally {
    passwordSaving = false;
    passwordForm.inert = false;
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

loadProfile();
