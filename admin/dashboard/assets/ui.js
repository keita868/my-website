(() => {
  function showSessionNotice() {
    document.querySelectorAll('input[type="password"], input[data-password]').forEach((input) => { input.value = ''; });
    if (document.querySelector('#session-notice')) return;
    const notice = document.createElement('div');
    notice.id = 'session-notice';
    notice.className = 'session-notice';
    notice.setAttribute('role', 'alert');
    const message = document.createElement('p');
    message.textContent = 'ログインの有効期限が切れました。入力内容はこの画面に残っています。別タブで同じアカウントにログインし、この画面に戻って操作をやり直してください。';
    const link = document.createElement('a');
    link.href = '/admin/login';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '別タブでログインする';
    notice.append(message, link);
    (document.querySelector('main') || document.body).prepend(notice);
    notice.scrollIntoView({ block: 'nearest' });
  }

  async function request(url, options = {}) {
    let response;
    try {
      response = await fetch(url, { credentials: 'same-origin', ...options });
    } catch {
      throw new Error('通信できませんでした。接続を確認してください。保存操作の場合は一覧で保存状況を確認してから再度お試しください。');
    }
    if (response.status === 401) {
      showSessionNotice();
      throw new Error('ログインの有効期限が切れました。別タブでログインしてください。');
    }
    let data;
    try {
      data = response.status === 204 ? {} : await response.json();
    } catch {
      throw new Error('応答を確認できませんでした。保存操作の場合は一覧で保存状況を確認してください。');
    }
    if (!response.ok) {
      const seconds = Number(response.headers.get('Retry-After'));
      const wait = response.status === 429 && Number.isFinite(seconds) && seconds > 0
        ? ` 約${Math.ceil(seconds / 60)}分後に再度お試しください。` : '';
      throw new Error((data.error || 'リクエストに失敗しました。') + wait);
    }
    if (url !== '/api/auth/csrf') document.querySelector('#session-notice')?.remove();
    return data;
  }

  document.querySelectorAll('input[type="password"]').forEach((input, index) => {
    input.dataset.password = '';
    input.maxLength = 1024;
    if (!input.id) input.id = `password-field-${index}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'text-button password-toggle';
    toggle.textContent = 'パスワードを表示';
    toggle.setAttribute('aria-controls', input.id);
    toggle.setAttribute('aria-pressed', 'false');
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'パスワードを隠す' : 'パスワードを表示';
      toggle.setAttribute('aria-pressed', String(show));
    });
    // Keep the button outside the field's label for predictable keyboard and label behavior.
    const label = input.closest('label');
    if (label) {
      const field = document.createElement('div');
      field.className = 'password-field';
      label.before(field);
      field.append(label, toggle);
    } else {
      input.after(toggle);
    }
  });

  document.querySelectorAll('.update-form [maxlength]').forEach((input, index) => {
    const counter = document.createElement('span');
    counter.className = 'help-text character-count';
    counter.id = `character-count-${index}`;
    input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), counter.id].filter(Boolean).join(' '));
    input.after(counter);
    const update = () => { counter.textContent = `${input.value.length.toLocaleString('ja-JP')} / ${input.maxLength.toLocaleString('ja-JP')}文字`; };
    input.addEventListener('input', update);
    input.addEventListener('change', update);
    update();
  });

  window.cmsUI = { request };
})();
