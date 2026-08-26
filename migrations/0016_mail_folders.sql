-- User-owned, flat folders for organizing whole conversations. Assignments are
-- metadata only: deleting a folder must never delete an email or attachment.
CREATE TABLE mail_folders (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	name_key TEXT NOT NULL,
	position INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (user_id, name_key),
	UNIQUE (user_id, id)
);

CREATE INDEX idx_mail_folders_user_position
	ON mail_folders(user_id, position, created_at);

CREATE TABLE mail_thread_folders (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	folder_id TEXT NOT NULL,
	assigned_by TEXT NOT NULL DEFAULT 'manual' CHECK (assigned_by IN ('manual', 'rule')),
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, thread_id),
	FOREIGN KEY (user_id, folder_id) REFERENCES mail_folders(user_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_mail_thread_folders_folder
	ON mail_thread_folders(user_id, folder_id, thread_id);

-- Folder views join through the stable conversation identity. The expression
-- index keeps both legacy rows (thread_id NULL) and threaded rows indexable.
CREATE INDEX idx_emails_user_thread_identity
	ON emails(user_id, COALESCE(thread_id, id), deleted_at, status, domain_id);

-- Task 5.3 owns evaluation and CRUD. The additive table lives here so folder
-- deletion can already have a complete, non-destructive cascade contract.
CREATE TABLE mail_sort_rules (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	folder_id TEXT NOT NULL,
	sender_contains TEXT,
	subject_contains TEXT,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	position INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	CHECK (sender_contains IS NULL OR length(trim(sender_contains)) BETWEEN 1 AND 256),
	CHECK (subject_contains IS NULL OR length(trim(subject_contains)) BETWEEN 1 AND 256),
	CHECK (sender_contains IS NOT NULL OR subject_contains IS NOT NULL),
	FOREIGN KEY (user_id, folder_id) REFERENCES mail_folders(user_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_mail_sort_rules_user_position
	ON mail_sort_rules(user_id, enabled, position, created_at);

CREATE INDEX idx_mail_sort_rules_folder
	ON mail_sort_rules(user_id, folder_id);
