ALTER TABLE admins ADD COLUMN display_name TEXT;
ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'superadmin'));
ALTER TABLE admins ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));
ALTER TABLE admins ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE admins ADD COLUMN last_login_at TEXT;
ALTER TABLE admins ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0 CHECK (session_version >= 0);

UPDATE admins
SET role = 'superadmin'
WHERE id = (SELECT MIN(id) FROM admins WHERE is_active = 1)
  AND NOT EXISTS (SELECT 1 FROM admins WHERE role = 'superadmin' AND is_active = 1);

UPDATE admins SET updated_at = CURRENT_TIMESTAMP WHERE updated_at = '';
