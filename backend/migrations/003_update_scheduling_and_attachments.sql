ALTER TABLE updates ADD COLUMN scheduled_at TEXT;

CREATE INDEX updates_scheduled_at_idx ON updates (scheduled_at)
  WHERE scheduled_at IS NOT NULL AND status = 'draft';

CREATE TABLE update_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id INTEGER NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
  stored_name TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN (
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'
  )),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 5242880),
  created_at TEXT NOT NULL
);

CREATE INDEX update_attachments_update_id_idx ON update_attachments (update_id, id);
