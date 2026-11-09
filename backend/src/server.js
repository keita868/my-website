import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import connectSqlite3 from 'connect-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import session from 'express-session';
import helmet from 'helmet';
import { dataDirectory, database } from './database.js';

const app = express();
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dashboardDirectory = path.join(projectDirectory, 'admin', 'dashboard');
const SQLiteStore = connectSqlite3(session);
const sessionSecret = process.env.CMS_SESSION_SECRET;

if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('CMS_SESSION_SECRETには32文字以上のランダムな値を設定してください。');
}

const dummyPasswordHash = await argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id });

if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

const adminById = database.prepare(`
  SELECT id, email, display_name, role, is_active, session_version,
    created_at, updated_at, last_login_at
  FROM admins WHERE id = ?
`);
const adminByEmail = database.prepare(`
  SELECT id, email, display_name, password_hash, role, is_active, session_version,
    created_at, updated_at, last_login_at
  FROM admins WHERE email = ?
`);

function publicAdmin(admin) {
  return {
    id: admin.id,
    email: admin.email,
    displayName: admin.display_name,
    role: admin.role,
    isActive: Boolean(admin.is_active),
    createdAt: admin.created_at,
    updatedAt: admin.updated_at,
    lastLoginAt: admin.last_login_at
  };
}

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(session({
  name: 'cms.sid',
  secret: sessionSecret,
  store: new SQLiteStore({
    db: 'sessions.sqlite',
    dir: dataDirectory,
    table: 'sessions',
    concurrentDb: true
  }),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 1000 * 60 * 60 * 8,
    path: '/'
  }
}));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/admin/assets', express.static(path.join(dashboardDirectory, 'assets'), {
  index: false,
  dotfiles: 'deny',
  fallthrough: false
}));

function issueCsrfToken(req) {
  req.session.csrfToken = randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function csrfIsValid(req) {
  const token = req.get('x-csrf-token');
  const expected = req.session.csrfToken;
  if (typeof token !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function requireCsrf(req, res, next) {
  if (!csrfIsValid(req)) {
    return res.status(403).json({ error: 'リクエストを確認できませんでした。画面を再読み込みしてください。' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({ error: 'ログインが必要です。' });
  }
  const admin = adminById.get(req.session.adminId);
  if (!admin || !admin.is_active || admin.session_version !== req.session.adminVersion) {
    return req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('cms.sid', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/'
      });
      if (res.headersSent) return;
      res.status(401).json({ error: 'ログインが必要です。' });
    });
  }
  req.admin = admin;
  next();
}

function requirePageAdmin(req, res, next) {
  if (!req.session.adminId) return res.redirect('/admin/login');
  const admin = adminById.get(req.session.adminId);
  if (!admin || !admin.is_active || admin.session_version !== req.session.adminVersion) {
    return req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('cms.sid', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/'
      });
      res.redirect('/admin/login');
    });
  }
  req.admin = admin;
  res.set('Cache-Control', 'no-store');
  next();
}

function requirePageSuperadmin(req, res, next) {
  if (req.admin.role !== 'superadmin') return res.redirect('/admin');
  next();
}

function requireSuperadmin(req, res, next) {
  if (req.admin.role !== 'superadmin') {
    return res.status(403).json({ error: 'この操作を行う権限がありません。' });
  }
  next();
}

function validEmail(email) {
  return typeof email === 'string'
    && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function validDisplayName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 80;
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 1024;
}

function isUniqueConstraint(error) {
  return error.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

function countActiveAdmins() {
  return database.prepare('SELECT COUNT(*) AS count FROM admins WHERE is_active = 1').get().count;
}

function countActiveSuperadmins() {
  return database.prepare(`
    SELECT COUNT(*) AS count FROM admins WHERE is_active = 1 AND role = 'superadmin'
  `).get().count;
}

function authMe(req, res) {
  res.json({ admin: publicAdmin(req.admin) });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'ログイン試行が多すぎます。しばらくしてから再度お試しください。' }
});

app.get('/admin/login', (req, res) => {
  const admin = req.session.adminId && adminById.get(req.session.adminId);
  if (admin && admin.is_active && admin.session_version === req.session.adminVersion) {
    return res.redirect('/admin');
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(dashboardDirectory, 'login.html'));
});

app.get(['/admin', '/admin/dashboard'], requirePageAdmin, (_req, res) => {
  res.sendFile(path.join(dashboardDirectory, 'index.html'));
});

app.get('/admin/admins', requirePageAdmin, requirePageSuperadmin, (_req, res) => {
  res.sendFile(path.join(dashboardDirectory, 'admins.html'));
});

app.get('/admin/account', requirePageAdmin, (_req, res) => {
  res.sendFile(path.join(dashboardDirectory, 'account.html'));
});

app.get('/api/auth/csrf', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ csrfToken: issueCsrfToken(req) });
});

app.get(['/api/auth/session', '/api/auth/me'], requireAdmin, authMe);

app.post('/api/auth/login', loginLimiter, requireCsrf, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string'
      || email.length > 254 || password.length > 1024) {
      return res.status(400).json({ error: 'メールアドレスとパスワードを入力してください。' });
    }

    const admin = adminByEmail.get(email.trim());
    const authenticated = await argon2.verify(admin?.password_hash ?? dummyPasswordHash, password);
    if (!admin || !admin.is_active || !authenticated) {
      return res.status(401).json({ error: 'メールアドレスまたはパスワードが正しくありません。' });
    }

    database.prepare(`
      UPDATE admins
      SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(admin.id);
    const updatedAdmin = database.prepare(`
      SELECT id, email, display_name, role, is_active, created_at, updated_at, last_login_at
      FROM admins WHERE id = ?
    `).get(admin.id);
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.adminId = admin.id;
      req.session.adminVersion = admin.session_version;
      issueCsrfToken(req);
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.json({ admin: publicAdmin(updatedAdmin) });
      });
    });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/auth/me', requireAdmin, requireCsrf, (req, res) => {
  const { displayName, email } = req.body ?? {};
  if (!validDisplayName(displayName) || !validEmail(email)) {
    return res.status(400).json({ error: '表示名と有効なメールアドレスを入力してください。' });
  }

  const normalizedEmail = email.trim();
  const duplicate = database.prepare('SELECT id FROM admins WHERE email = ? AND id != ?')
    .get(normalizedEmail, req.admin.id);
  if (duplicate) return res.status(409).json({ error: 'このメールアドレスはすでに使用されています。' });

  try {
    database.prepare(`
      UPDATE admins SET display_name = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(displayName.trim(), normalizedEmail, req.admin.id);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      return res.status(409).json({ error: 'このメールアドレスはすでに使用されています。' });
    }
    throw error;
  }
  req.admin = adminById.get(req.admin.id);
  res.json({ admin: publicAdmin(req.admin) });
});

app.post('/api/auth/change-password', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || !validPassword(newPassword)) {
      return res.status(400).json({ error: '現在のパスワードと12文字以上の新しいパスワードを入力してください。' });
    }

    const account = database.prepare('SELECT password_hash FROM admins WHERE id = ?').get(req.admin.id);
    if (!await argon2.verify(account.password_hash, currentPassword)) {
      return res.status(401).json({ error: '現在のパスワードが正しくありません。' });
    }

    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    database.prepare(`
      UPDATE admins
      SET password_hash = ?, session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(passwordHash, req.admin.id);

    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('cms.sid', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/'
      });
      res.status(204).end();
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admins', requireAdmin, requireSuperadmin, (_req, res) => {
  const admins = database.prepare(`
    SELECT id, email, display_name, role, is_active, created_at, updated_at, last_login_at
    FROM admins ORDER BY id
  `).all();
  res.json({ admins: admins.map(publicAdmin) });
});

app.get('/api/admins/:id', requireAdmin, requireSuperadmin, (req, res) => {
  const adminId = Number(req.params.id);
  if (!Number.isSafeInteger(adminId) || adminId < 1) {
    return res.status(400).json({ error: '管理者IDが正しくありません。' });
  }
  const admin = database.prepare(`
    SELECT id, email, display_name, role, is_active, created_at, updated_at, last_login_at
    FROM admins WHERE id = ?
  `).get(adminId);
  if (!admin) return res.status(404).json({ error: '管理者が見つかりません。' });
  res.json({ admin: publicAdmin(admin) });
});

app.post('/api/admins', requireAdmin, requireSuperadmin, requireCsrf, async (req, res, next) => {
  try {
    const { displayName, email, password, role = 'admin' } = req.body ?? {};
    if (!validDisplayName(displayName) || !validEmail(email) || !validPassword(password)
      || !['admin', 'superadmin'].includes(role)) {
      return res.status(400).json({ error: '表示名、メールアドレス、12文字以上のパスワード、権限を確認してください。' });
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    try {
      const result = database.prepare(`
        INSERT INTO admins (email, password_hash, display_name, role, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(email.trim(), passwordHash, displayName.trim(), role);
      const admin = database.prepare(`
        SELECT id, email, display_name, role, is_active, created_at, updated_at, last_login_at
        FROM admins WHERE id = ?
      `).get(result.lastInsertRowid);
      res.status(201).json({ admin: publicAdmin(admin) });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return res.status(409).json({ error: 'このメールアドレスはすでに使用されています。' });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

app.patch('/api/admins/:id', requireAdmin, requireSuperadmin, requireCsrf, (req, res) => {
  const adminId = Number(req.params.id);
  if (!Number.isSafeInteger(adminId) || adminId < 1) {
    return res.status(400).json({ error: '管理者IDが正しくありません。' });
  }

  const target = database.prepare('SELECT * FROM admins WHERE id = ?').get(adminId);
  if (!target) return res.status(404).json({ error: '管理者が見つかりません。' });

  const { displayName, email, role, isActive } = req.body ?? {};
  const updates = {};
  if (displayName !== undefined) {
    if (!validDisplayName(displayName)) return res.status(400).json({ error: '表示名は1〜80文字で入力してください。' });
    updates.display_name = displayName.trim();
  }
  if (email !== undefined) {
    if (!validEmail(email)) return res.status(400).json({ error: '有効なメールアドレスを入力してください。' });
    updates.email = email.trim();
  }
  if (role !== undefined) {
    if (!['admin', 'superadmin'].includes(role)) return res.status(400).json({ error: '権限が正しくありません。' });
    updates.role = role;
  }
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') return res.status(400).json({ error: '有効状態が正しくありません。' });
    updates.is_active = Number(isActive);
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: '変更内容を指定してください。' });
  if (adminId === req.admin.id && updates.is_active === 0) {
    return res.status(400).json({ error: '自分自身を無効化することはできません。' });
  }
  if (updates.email) {
    const duplicate = database.prepare('SELECT id FROM admins WHERE email = ? AND id != ?')
      .get(updates.email, adminId);
    if (duplicate) return res.status(409).json({ error: 'このメールアドレスはすでに使用されています。' });
  }

  const transaction = database.transaction(() => {
    const willBeActive = updates.is_active ?? target.is_active;
    const willBeSuperadmin = updates.role === 'superadmin' || (updates.role === undefined && target.role === 'superadmin');
    if (target.is_active && !willBeActive && countActiveAdmins() <= 1) {
      return { error: '最後の有効な管理者は無効化できません。' };
    }
    if (target.is_active && target.role === 'superadmin'
      && (!willBeActive || !willBeSuperadmin) && countActiveSuperadmins() <= 1) {
      return { error: '最後の有効なsuperadminは無効化・降格できません。' };
    }

    const fields = Object.keys(updates);
    const assignments = fields.map((field) => `${field} = @${field}`);
    assignments.push('updated_at = CURRENT_TIMESTAMP');
    if (updates.is_active !== undefined && updates.is_active !== target.is_active) {
      assignments.push('session_version = session_version + 1');
    }
    database.prepare(`UPDATE admins SET ${assignments.join(', ')} WHERE id = @id`)
      .run({ ...updates, id: adminId });
    return null;
  });

  let failure;
  try {
    failure = transaction();
  } catch (error) {
    if (isUniqueConstraint(error)) {
      return res.status(409).json({ error: 'このメールアドレスはすでに使用されています。' });
    }
    throw error;
  }
  if (failure) return res.status(409).json({ error: failure.error });
  const admin = database.prepare(`
    SELECT id, email, display_name, role, is_active, created_at, updated_at, last_login_at
    FROM admins WHERE id = ?
  `).get(adminId);
  res.json({ admin: publicAdmin(admin) });
});

app.post('/api/auth/logout', requireCsrf, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('cms.sid', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/'
    });
    res.status(204).end();
  });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'APIが見つかりません。' });
});

app.use((error, _req, res, _next) => {
  process.stderr.write(`${error.stack || error}\n`);
  if (res.headersSent) return;
  const status = error.status === 400 ? 400 : 500;
  res.status(status).json({
    error: status === 400 ? 'リクエストの形式が正しくありません。' : 'サーバーエラーが発生しました。'
  });
});

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORTには1から65535までの整数を設定してください。');
}
app.listen(port, () => {
  process.stdout.write(`CMS管理画面: http://localhost:${port}/admin/login\n`);
});
