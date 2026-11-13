const form = document.querySelector('#login-form');
const errorMessage = document.querySelector('#form-error');
let csrfToken = '';

async function loadCsrfToken() {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('認証情報を取得できませんでした。画面を再読み込みしてください。');
  const data = await response.json();
  csrfToken = data.csrfToken;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.textContent = '';
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton.disabled) return;
  submitButton.disabled = true;
  submitButton.textContent = 'ログイン中…';
  form.setAttribute('aria-busy', 'true');

  try {
    if (!csrfToken) await loadCsrfToken();
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        email: form.elements.email.value,
        password: form.elements.password.value
      })
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 403) await loadCsrfToken();
      throw new Error(data.error || 'ログインできませんでした。');
    }
    window.location.assign('/admin');
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'ログイン';
    form.removeAttribute('aria-busy');
  }
});
