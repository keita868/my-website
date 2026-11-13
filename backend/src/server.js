import { createReadStream } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import session from 'express-session';
import helmet from 'helmet';
import { dataDirectory, database } from './database.js';
import { sessionStore } from './session-store.js';
import {
  attachmentPath,
  attachmentUpload,
  cleanupTemporaryFiles,
  deleteStoredAttachment,
  persistAttachments
} from './update-files.js';

const app = express();
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dashboardDirectory = path.join(projectDirectory, 'admin', 'dashboard');
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
app.use(express.json({ limit: '32kb' }));
app.use(session({
  name: 'cms.sid',
  secret: sessionSecret,
  store: sessionStore,
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
  if (typeof req.session.csrfToken !== 'string') {
    req.session.csrfToken = randomBytes(32).toString('hex');
  }
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

const updateSelect = `
  SELECT id, type, title, body, status, published_at AS publishedAt,
    scheduled_at AS scheduledAt, created_by AS createdBy, updated_by AS updatedBy,
    created_at AS createdAt, updated_at AS updatedAt
  FROM updates
`;

function updateWithAttachments(update) {
  if (!update) return null;
  const attachments = database.prepare(`
    SELECT id, original_name AS originalName, mime_type AS mimeType,
      size, created_at AS createdAt
    FROM update_attachments
    WHERE update_id = ?
    ORDER BY id
  `).all(update.id).map((attachment) => ({
    ...attachment,
    url: `/api/admin/updates/attachments/${attachment.id}/file`
  }));
  return { ...update, attachments };
}

function getUpdate(updateId) {
  return updateWithAttachments(database.prepare(`${updateSelect} WHERE id = ?`).get(updateId));
}

function getUpdates() {
  const rows = database.prepare(`
    SELECT u.id, u.type, u.title, u.body, u.status,
      u.published_at AS publishedAt, u.scheduled_at AS scheduledAt,
      u.created_by AS createdBy, u.updated_by AS updatedBy,
      u.created_at AS createdAt, u.updated_at AS updatedAt,
      a.id AS attachmentId, a.original_name AS originalName,
      a.mime_type AS mimeType, a.size AS attachmentSize,
      a.created_at AS attachmentCreatedAt
    FROM updates u
    LEFT JOIN update_attachments a ON a.update_id = u.id
    ORDER BY u.created_at DESC, u.id DESC, a.id
  `).all();
  const updatesById = new Map();
  for (const row of rows) {
    let update = updatesById.get(row.id);
    if (!update) {
      update = {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        status: row.status,
        publishedAt: row.publishedAt,
        scheduledAt: row.scheduledAt,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        attachments: []
      };
      updatesById.set(row.id, update);
    }
    if (row.attachmentId !== null) {
      update.attachments.push({
        id: row.attachmentId,
        originalName: row.originalName,
        mimeType: row.mimeType,
        size: row.attachmentSize,
        createdAt: row.attachmentCreatedAt,
        url: `/api/admin/updates/attachments/${row.attachmentId}/file`
      });
    }
  }
  return [...updatesById.values()];
}

function parseJstDateTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [yearText, monthText, dayText, hourText, minuteText].map(Number);
  const localTime = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(localTime);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) {
    return null;
  }
  const scheduledAt = new Date(localTime - 9 * 60 * 60 * 1000);
  if (scheduledAt.getTime() <= Date.now()) return null;
  return scheduledAt.toISOString();
}

function receiveAttachments(req, res, next) {
  attachmentUpload.array('attachments', 5)(req, res, (error) => {
    if (error) {
      error.status = [
        'LIMIT_FILE_SIZE',
        'LIMIT_FILE_COUNT',
        'LIMIT_FIELD_VALUE',
        'LIMIT_PART_COUNT'
      ].includes(error.code) ? 413 : 400;
      return next(error);
    }
    next();
  });
}

function removeSavedAttachments(attachments) {
  for (const attachment of attachments) deleteStoredAttachment(attachment.storedName);
}

function processScheduledUpdates() {
  const now = new Date().toISOString();
  const publishDueUpdates = database.prepare(`
    UPDATE updates
    SET status = 'published', published_at = ?, scheduled_at = NULL, updated_at = ?
    WHERE status = 'draft' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
  `);
  publishDueUpdates.run(now, now, now);
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

const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => createHash('sha256')
    .update(typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : 'invalid-email')
    .digest('hex'),
  standardHeaders: false,
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

app.get('/admin/updates', requirePageAdmin, (_req, res) => {
  res.sendFile(path.join(dashboardDirectory, 'updates.html'));
});

app.get('/admin/updates/new', requirePageAdmin, (_req, res) => {
  res.sendFile(path.join(dashboardDirectory, 'update-create.html'));
});

app.get('/admin/updates/:id/edit', requirePageAdmin, (_req, res) => {
  res.sendFile(path.join(dashboardDirectory, 'update-create.html'));
});

app.get('/api/auth/csrf', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ csrfToken: issueCsrfToken(req) });
});

app.get(['/api/auth/session', '/api/auth/me'], requireAdmin, authMe);

app.post('/api/auth/login', loginLimiter, requireCsrf, loginAccountLimiter, async (req, res, next) => {
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
      return res.status(400).json({ error: '現在のパスワードが正しくありません。' });
    }

    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    const updatePassword = database.transaction(() => database.prepare(`
      UPDATE admins
      SET password_hash = ?, session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND is_active = 1 AND session_version = ? AND password_hash = ?
    `).run(passwordHash, req.admin.id, req.admin.session_version, account.password_hash));
    const update = updatePassword();
    if (update.changes !== 1) {
      return req.session.destroy((error) => {
        if (error) return next(error);
        res.clearCookie('cms.sid', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          path: '/'
        });
        res.status(401).json({ error: 'ログイン状態が更新されました。再ログインしてください。' });
      });
    }

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
      const createAdmin = database.transaction(() => {
        const actor = adminById.get(req.admin.id);
        if (!actor || !actor.is_active || actor.role !== 'superadmin'
          || actor.session_version !== req.session.adminVersion) {
          return { error: 'この操作を行う権限がありません。' };
        }

        const result = database.prepare(`
          INSERT INTO admins (email, password_hash, display_name, role, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(email.trim(), passwordHash, displayName.trim(), role);
        const admin = database.prepare(`
          SELECT id, email, display_name, role, is_active, created_at, updated_at, last_login_at
          FROM admins WHERE id = ?
        `).get(result.lastInsertRowid);
        return { admin };
      });
      const result = createAdmin();
      if (result.error) return res.status(403).json({ error: result.error });
      res.status(201).json({ admin: publicAdmin(result.admin) });
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

app.get('/api/admin/updates', requireAdmin, (_req, res) => {
  res.json({ updates: getUpdates() });
});

app.get('/api/admin/updates/attachments/:attachmentId/file', requireAdmin, (req, res, next) => {
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) {
    return res.status(400).json({ error: '添付ファイルIDが正しくありません。' });
  }
  const attachment = database.prepare(`
    SELECT stored_name AS storedName, original_name AS originalName, mime_type AS mimeType
    FROM update_attachments WHERE id = ?
  `).get(attachmentId);
  if (!attachment) return res.status(404).json({ error: '添付ファイルが見つかりません。' });

  const disposition = attachment.mimeType.startsWith('image/') ? 'inline' : 'attachment';
  const encodedName = encodeURIComponent(attachment.originalName).replace(/['()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  res.set({
    'Content-Type': attachment.mimeType,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodedName}`,
    'X-Content-Type-Options': 'nosniff'
  });
  createReadStream(attachmentPath(attachment.storedName))
    .on('error', next)
    .pipe(res);
});

app.get('/api/admin/updates/:id', requireAdmin, (req, res) => {
  const updateId = Number(req.params.id);
  if (!Number.isSafeInteger(updateId) || updateId < 1) {
    return res.status(400).json({ error: '投稿IDが正しくありません。' });
  }
  const update = getUpdate(updateId);
  if (!update) return res.status(404).json({ error: '投稿が見つかりません。' });
  res.json({ update });
});

app.post('/api/admin/updates/:id/publish', requireAdmin, requireCsrf, (req, res) => {
  const updateId = Number(req.params.id);
  if (!Number.isSafeInteger(updateId) || updateId < 1) {
    return res.status(400).json({ error: '投稿IDが正しくありません。' });
  }

  const now = new Date().toISOString();
  const publish = database.prepare(`
    UPDATE updates
    SET status = 'published', published_at = ?, scheduled_at = NULL, updated_at = ?, updated_by = ?
    WHERE id = ? AND status = 'draft'
  `).run(now, now, req.admin.id, updateId);
  if (publish.changes !== 1) {
    const existing = database.prepare('SELECT status FROM updates WHERE id = ?').get(updateId);
    if (!existing) return res.status(404).json({ error: '投稿が見つかりません。' });
    return res.status(409).json({ error: 'この投稿は下書きではないため、公開できません。' });
  }

  const update = database.prepare(`
    SELECT id, type, title, body, status, published_at AS publishedAt,
      scheduled_at AS scheduledAt, created_by AS createdBy, updated_by AS updatedBy,
      created_at AS createdAt, updated_at AS updatedAt
    FROM updates WHERE id = ?
  `).get(updateId);
  res.json({ success: true, update: updateWithAttachments(update) });
});

app.post('/api/admin/updates/:id/unpublish', requireAdmin, requireCsrf, (req, res) => {
  const updateId = Number(req.params.id);
  if (!Number.isSafeInteger(updateId) || updateId < 1) {
    return res.status(400).json({ error: '投稿IDが正しくありません。' });
  }
  const now = new Date().toISOString();
  const result = database.prepare(`
    UPDATE updates
    SET status = 'draft', published_at = NULL, scheduled_at = NULL, updated_at = ?, updated_by = ?
    WHERE id = ? AND status = 'published'
  `).run(now, req.admin.id, updateId);
  if (result.changes !== 1) {
    const existing = database.prepare('SELECT id FROM updates WHERE id = ?').get(updateId);
    if (!existing) return res.status(404).json({ error: '投稿が見つかりません。' });
    return res.status(409).json({ error: '公開中の投稿ではありません。' });
  }
  res.json({ success: true, update: getUpdate(updateId) });
});

app.patch('/api/admin/updates/:id', requireAdmin, requireCsrf, receiveAttachments, async (req, res, next) => {
  const updateId = Number(req.params.id);
  if (!Number.isSafeInteger(updateId) || updateId < 1) {
    cleanupTemporaryFiles(req.files);
    return res.status(400).json({ error: '投稿IDが正しくありません。' });
  }
  const existing = database.prepare('SELECT status, updated_at AS updatedAt FROM updates WHERE id = ?').get(updateId);
  if (!existing) {
    cleanupTemporaryFiles(req.files);
    return res.status(404).json({ error: '投稿が見つかりません。' });
  }
  const { type, title, body, scheduledAt: scheduledAtInput = '' } = req.body ?? {};
  if (!['news', 'notice'].includes(type)
    || typeof title !== 'string'
    || title.trim().length === 0
    || title.trim().length > 200
    || typeof body !== 'string'
    || body.trim().length === 0
    || body.trim().length > 5000
    || typeof scheduledAtInput !== 'string') {
    cleanupTemporaryFiles(req.files);
    return res.status(400).json({ error: '種別、タイトル（1〜200文字）、本文（1〜5000文字）を確認してください。' });
  }

  let scheduledAt = null;
  if (existing.status === 'published' && scheduledAtInput) {
    cleanupTemporaryFiles(req.files);
    return res.status(400).json({ error: '公開済み投稿を予約状態には変更できません。先に公開を取り下げてください。' });
  }
  if (existing.status === 'draft' && scheduledAtInput) {
    scheduledAt = parseJstDateTime(scheduledAtInput);
    if (!scheduledAt) {
      cleanupTemporaryFiles(req.files);
      return res.status(400).json({ error: '予約日時は現在より後の日本時間で指定してください。' });
    }
  }

  let savedAttachments = [];
  try {
    const attachmentCount = database.prepare('SELECT COUNT(*) AS count FROM update_attachments WHERE update_id = ?')
      .get(updateId).count;
    savedAttachments = await persistAttachments(req.files || [], attachmentCount);
    const now = new Date().toISOString();
    const saveUpdate = database.transaction(() => {
      const actor = adminById.get(req.admin.id);
      if (!actor || !actor.is_active || actor.session_version !== req.session.adminVersion) {
        return { error: 'unauthorized' };
      }
      const currentUpdate = database.prepare(`
        SELECT status, updated_at AS updatedAt FROM updates WHERE id = ?
      `).get(updateId);
      if (!currentUpdate || currentUpdate.status !== existing.status
        || currentUpdate.updatedAt !== existing.updatedAt
        || (scheduledAt && currentUpdate.status !== 'draft')) {
        return { error: 'conflict' };
      }
      const currentAttachmentCount = database.prepare(`
        SELECT COUNT(*) AS count FROM update_attachments WHERE update_id = ?
      `).get(updateId).count;
      if (currentAttachmentCount + savedAttachments.length > 5) {
        const error = new Error('添付ファイルは1投稿につき最大5件です。');
        error.status = 400;
        throw error;
      }
      const updateResult = database.prepare(`
        UPDATE updates
        SET type = ?, title = ?, body = ?, scheduled_at = ?, updated_at = ?, updated_by = ?
        WHERE id = ? AND status = ? AND updated_at = ?
      `).run(
        type,
        title.trim(),
        body.trim(),
        scheduledAt,
        now,
        actor.id,
        updateId,
        currentUpdate.status,
        currentUpdate.updatedAt
      );
      if (updateResult.changes !== 1) return { error: 'conflict' };
      const insertAttachment = database.prepare(`
        INSERT INTO update_attachments (update_id, stored_name, original_name, mime_type, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const attachment of savedAttachments) {
        insertAttachment.run(
          updateId,
          attachment.storedName,
          attachment.originalName,
          attachment.mimeType,
          attachment.size,
          now
        );
      }
      return { success: true };
    });
    const result = saveUpdate();
    if (!result.success) {
      removeSavedAttachments(savedAttachments);
      if (result.error === 'unauthorized') {
        return res.status(401).json({ error: 'ログイン状態が更新されました。再ログインしてください。' });
      }
      return res.status(409).json({ error: '投稿状態が変更されました。画面を再読み込みしてください。' });
    }
    res.json({ success: true, update: getUpdate(updateId) });
  } catch (error) {
    cleanupTemporaryFiles(req.files);
    if (savedAttachments.length > 0) removeSavedAttachments(savedAttachments);
    next(error);
  }
});

app.delete('/api/admin/updates/:id/attachments/:attachmentId', requireAdmin, requireCsrf, (req, res) => {
  const updateId = Number(req.params.id);
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isSafeInteger(updateId) || updateId < 1
    || !Number.isSafeInteger(attachmentId) || attachmentId < 1) {
    return res.status(400).json({ error: '投稿IDまたは添付ファイルIDが正しくありません。' });
  }
  const attachment = database.prepare(`
    SELECT stored_name AS storedName
    FROM update_attachments WHERE id = ? AND update_id = ?
  `).get(attachmentId, updateId);
  if (!attachment) return res.status(404).json({ error: '添付ファイルが見つかりません。' });
  database.prepare('DELETE FROM update_attachments WHERE id = ?').run(attachmentId);
  deleteStoredAttachment(attachment.storedName);
  res.status(204).end();
});

app.delete('/api/admin/updates/:id', requireAdmin, requireCsrf, (req, res) => {
  const updateId = Number(req.params.id);
  if (!Number.isSafeInteger(updateId) || updateId < 1) {
    return res.status(400).json({ error: '投稿IDが正しくありません。' });
  }
  const attachments = database.prepare(`
    SELECT stored_name AS storedName FROM update_attachments WHERE update_id = ?
  `).all(updateId);
  const result = database.prepare('DELETE FROM updates WHERE id = ?').run(updateId);
  if (result.changes !== 1) return res.status(404).json({ error: '投稿が見つかりません。' });
  removeSavedAttachments(attachments);
  res.status(204).end();
});

app.post('/api/admin/updates', requireAdmin, requireCsrf, receiveAttachments, async (req, res, next) => {
  const { type, title, body, status, scheduledAt: scheduledAtInput = '' } = req.body ?? {};
  if (!['news', 'notice'].includes(type)
    || !['draft', 'published', 'scheduled'].includes(status)
    || typeof title !== 'string'
    || title.trim().length === 0
    || title.trim().length > 200
    || typeof body !== 'string'
    || body.trim().length === 0
    || body.trim().length > 5000
    || typeof scheduledAtInput !== 'string') {
    cleanupTemporaryFiles(req.files);
    return res.status(400).json({ error: '種別、タイトル（1〜200文字）、本文（1〜5000文字）、公開方法を確認してください。' });
  }

  let scheduledAt = null;
  if (status === 'scheduled') {
    scheduledAt = parseJstDateTime(scheduledAtInput);
    if (!scheduledAt) {
      cleanupTemporaryFiles(req.files);
      return res.status(400).json({ error: '予約日時は現在より後の日本時間で指定してください。' });
    }
  } else if (scheduledAtInput) {
    cleanupTemporaryFiles(req.files);
    return res.status(400).json({ error: '予約日時は予約公開を選んだ場合のみ指定できます。' });
  }

  let savedAttachments = [];
  try {
    savedAttachments = await persistAttachments(req.files || []);
    const now = new Date().toISOString();
    const updateStatus = status === 'published' ? 'published' : 'draft';
    const publishedAt = status === 'published' ? now : null;
    const createUpdate = database.transaction(() => {
      const actor = adminById.get(req.admin.id);
      if (!actor || !actor.is_active || actor.session_version !== req.session.adminVersion) {
        return { error: 'unauthorized' };
      }
      const result = database.prepare(`
        INSERT INTO updates (
          type, title, body, status, published_at, scheduled_at,
          created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        type,
        title.trim(),
        body.trim(),
        updateStatus,
        publishedAt,
        scheduledAt,
        actor.id,
        actor.id,
        now,
        now
      );
      const insertAttachment = database.prepare(`
        INSERT INTO update_attachments (update_id, stored_name, original_name, mime_type, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const attachment of savedAttachments) {
        insertAttachment.run(
          result.lastInsertRowid,
          attachment.storedName,
          attachment.originalName,
          attachment.mimeType,
          attachment.size,
          now
        );
      }
      return { updateId: Number(result.lastInsertRowid) };
    });
    const result = createUpdate();
    if (result.error === 'unauthorized') {
      removeSavedAttachments(savedAttachments);
      return res.status(401).json({ error: 'ログイン状態が更新されました。再ログインしてください。' });
    }
    res.status(201).json({ success: true, update: getUpdate(result.updateId) });
  } catch (error) {
    cleanupTemporaryFiles(req.files);
    if (savedAttachments.length > 0) removeSavedAttachments(savedAttachments);
    next(error);
  }
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
  const status = error.status === 400 ? 400 : error.status === 413 ? 413 : 500;
  res.status(status).json({
    error: status === 400
      ? 'リクエストの形式が正しくありません。'
      : status === 413
        ? 'リクエストが大きすぎます。'
        : 'サーバーエラーが発生しました。'
  });
});

function publishScheduledUpdates() {
  try {
    processScheduledUpdates();
  } catch (error) {
    process.stderr.write(`予約投稿を公開できませんでした: ${error.stack || error}\n`);
  }
}

publishScheduledUpdates();
const scheduler = setInterval(publishScheduledUpdates, 1000);
scheduler.unref();

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORTには1から65535までの整数を設定してください。');
}
app.listen(port, () => {
  process.stdout.write(`CMS管理画面: http://localhost:${port}/admin/login\n`);
});
