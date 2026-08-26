-- Comparison keys are populated by the application for new mail and rule
-- writes. Deliberately do not backfill historical email: adding this migration
-- must never classify an existing conversation.
ALTER TABLE emails ADD COLUMN sort_sender_key TEXT;
ALTER TABLE emails ADD COLUMN sort_subject_key TEXT;
ALTER TABLE mail_sort_rules ADD COLUMN sender_match_key TEXT;
ALTER TABLE mail_sort_rules ADD COLUMN subject_match_key TEXT;

-- A manual "move back to inbox" must remain sticky when a later message joins
-- the conversation. This tombstone stores that preference without inventing a
-- system-folder row or changing any email.
CREATE TABLE mail_thread_folder_suppressions (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id,thread_id)
);

CREATE TRIGGER suppress_manual_inbox_assignment
	AFTER INSERT ON mail_thread_folder_suppressions
BEGIN
	DELETE FROM mail_thread_folders
	WHERE user_id = NEW.user_id AND thread_id = NEW.thread_id;
END;

CREATE TRIGGER clear_inbox_suppression_after_manual_folder_insert
	AFTER INSERT ON mail_thread_folders
	WHEN NEW.assigned_by = 'manual'
BEGIN
	DELETE FROM mail_thread_folder_suppressions
	WHERE user_id = NEW.user_id AND thread_id = NEW.thread_id;
END;

CREATE TRIGGER clear_inbox_suppression_after_manual_folder_update
	AFTER UPDATE OF folder_id,assigned_by ON mail_thread_folders
	WHEN NEW.assigned_by = 'manual'
BEGIN
	DELETE FROM mail_thread_folder_suppressions
	WHERE user_id = NEW.user_id AND thread_id = NEW.thread_id;
END;

-- Classify only live inbound deliveries. Both Cloudflare Email Routing and the
-- Resend receiving webhook insert the provider identity with the email. The
-- historical Outlook importer sets its synthetic identity after INSERT, so it
-- intentionally never enters this trigger.
CREATE TRIGGER classify_live_inbound_email
	AFTER INSERT ON emails
	WHEN NEW.direction = 'inbound'
	 AND NEW.provider_id IS NOT NULL
	 AND NEW.provider_id NOT LIKE 'outlook-import-v1-%'
BEGIN
	INSERT OR IGNORE INTO mail_thread_folders
		(user_id,thread_id,folder_id,assigned_by,created_at,updated_at)
	SELECT NEW.user_id,COALESCE(NEW.thread_id,NEW.id),r.folder_id,'rule',datetime('now'),datetime('now')
	FROM mail_sort_rules r
	JOIN mail_folders f ON f.id = r.folder_id AND f.user_id = r.user_id
	WHERE r.user_id = NEW.user_id
	  AND r.enabled = 1
	  AND NOT EXISTS (
		SELECT 1 FROM mail_thread_folders current_assignment
		WHERE current_assignment.user_id = NEW.user_id
		  AND current_assignment.thread_id = COALESCE(NEW.thread_id,NEW.id)
	  )
	  AND NOT EXISTS (
		SELECT 1 FROM mail_thread_folder_suppressions suppression
		WHERE suppression.user_id = NEW.user_id
		  AND suppression.thread_id = COALESCE(NEW.thread_id,NEW.id)
	  )
	  AND (r.sender_contains IS NULL OR instr(NEW.sort_sender_key,r.sender_match_key) > 0)
	  AND (r.subject_contains IS NULL OR instr(NEW.sort_subject_key,r.subject_match_key) > 0)
	ORDER BY r.position ASC,r.created_at ASC,r.id ASC
	LIMIT 1;
END;
