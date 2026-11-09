import { createInterface } from 'node:readline';
import argon2 from 'argon2';
import { database } from './database.js';

function promptHidden(message) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('管理者作成コマンドは対話型ターミナルで実行してください。');
  }

  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = '';
    process.stdout.write(message);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();

    const finish = (error) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (characters) => {
      for (const character of characters) {
        if (character === '\u0003') {
          finish(new Error('キャンセルされました。'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };

    input.on('data', onData);
  });
}

function promptLine(message) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    prompt.question(message, (value) => {
      prompt.close();
      resolve(value.trim());
    });
  });
}

try {
  let displayName;
  while (true) {
    displayName = await promptLine('管理者の表示名: ');
    if (displayName && displayName.length <= 80) break;
    process.stderr.write('表示名は1〜80文字で入力してください。\n');
  }

  let email;
  while (true) {
    email = await promptLine('管理者メールアドレス: ');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      process.stderr.write('有効なメールアドレスを入力してください。\n');
      continue;
    }

    const existingAdmin = database.prepare('SELECT 1 FROM admins WHERE email = ?').get(email);
    if (existingAdmin) {
      process.stderr.write('このメールアドレスは登録済みです。別のメールアドレスを入力してください。\n');
      continue;
    }
    break;
  }

  let password;
  while (true) {
    password = await promptHidden('パスワード（12文字以上・入力非表示）: ');
    if (password.length < 12 || password.length > 1024) {
      process.stderr.write('パスワードは12文字以上1024文字以下にしてください。\n');
      continue;
    }

    const confirmation = await promptHidden('パスワード（再入力）: ');
    if (password !== confirmation) {
      process.stderr.write('パスワードが一致しません。もう一度入力してください。\n');
      continue;
    }
    break;
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const role = database.prepare(`
    SELECT COUNT(*) AS count FROM admins WHERE is_active = 1 AND role = 'superadmin'
  `).get().count === 0
    ? 'superadmin'
    : 'admin';
  database.prepare(`
    INSERT INTO admins (email, password_hash, display_name, role, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(email, passwordHash, displayName, role);
  process.stdout.write('管理者アカウントを作成しました。\n');
} catch (error) {
  process.stderr.write(`管理者を作成できませんでした: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  database.close();
}
