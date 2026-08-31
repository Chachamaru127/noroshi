-- Rollout order: apply 0020 and 0021 before deploying a Worker that reads or
-- writes emails.address_id. The previous Worker remains compatible while these
-- additive migrations run; no dual-schema runtime machinery is required.
--
-- A conversation belongs to one mailbox domain bucket. NULL is a real bucket:
-- legacy mail without a domain must never be joined to a connected domain.
CREATE TABLE _thread_domain_split (
	email_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	old_thread_id TEXT NOT NULL,
	new_thread_id TEXT NOT NULL
);

INSERT INTO _thread_domain_split (email_id, user_id, old_thread_id, new_thread_id)
SELECT e.id,
	e.user_id,
	COALESCE(e.thread_id, e.id),
	(
		SELECT root.id
		FROM emails root
		WHERE root.user_id = e.user_id
		  AND COALESCE(root.thread_id, root.id) = COALESCE(e.thread_id, e.id)
		  AND root.domain_id IS e.domain_id
		ORDER BY datetime(root.created_at) ASC, root.id ASC
		LIMIT 1
	)
FROM emails e
WHERE EXISTS (
	SELECT 1
	FROM emails other
	WHERE other.user_id = e.user_id
	  AND COALESCE(other.thread_id, other.id) = COALESCE(e.thread_id, e.id)
	  AND other.domain_id IS NOT e.domain_id
);

-- Snapshot folder metadata before changing the conversation identities.
CREATE TABLE _thread_folder_split AS
SELECT DISTINCT split.user_id,
	split.new_thread_id AS thread_id,
	assignment.folder_id,
	assignment.assigned_by,
	assignment.created_at,
	assignment.updated_at
FROM _thread_domain_split split
JOIN mail_thread_folders assignment
  ON assignment.user_id = split.user_id
 AND assignment.thread_id = split.old_thread_id;

CREATE TABLE _thread_suppression_split AS
SELECT DISTINCT split.user_id,
	split.new_thread_id AS thread_id,
	suppression.created_at,
	suppression.updated_at
FROM _thread_domain_split split
JOIN mail_thread_folder_suppressions suppression
  ON suppression.user_id = split.user_id
 AND suppression.thread_id = split.old_thread_id;

UPDATE emails
SET thread_id = (
	SELECT split.new_thread_id
	FROM _thread_domain_split split
	WHERE split.email_id = emails.id
)
WHERE id IN (SELECT email_id FROM _thread_domain_split);

-- Drop metadata whose old conversation identity no longer exists, then copy
-- the old choice to every domain-specific conversation created above.
DELETE FROM mail_thread_folders
WHERE NOT EXISTS (
	SELECT 1 FROM emails remaining
	WHERE remaining.user_id = mail_thread_folders.user_id
	  AND COALESCE(remaining.thread_id, remaining.id) = mail_thread_folders.thread_id
);

DELETE FROM mail_thread_folder_suppressions
WHERE NOT EXISTS (
	SELECT 1 FROM emails remaining
	WHERE remaining.user_id = mail_thread_folder_suppressions.user_id
	  AND COALESCE(remaining.thread_id, remaining.id) = mail_thread_folder_suppressions.thread_id
);

INSERT OR REPLACE INTO mail_thread_folders
	(user_id, thread_id, folder_id, assigned_by, created_at, updated_at)
SELECT user_id, thread_id, folder_id, assigned_by, created_at, updated_at
FROM _thread_folder_split;

INSERT OR REPLACE INTO mail_thread_folder_suppressions
	(user_id, thread_id, created_at, updated_at)
SELECT user_id, thread_id, created_at, updated_at
FROM _thread_suppression_split;

DROP TABLE _thread_suppression_split;
DROP TABLE _thread_folder_split;
DROP TABLE _thread_domain_split;

CREATE INDEX idx_emails_domain_thread_key
	ON emails(user_id, domain_id, thread_key);
CREATE INDEX idx_emails_domain_message_id
	ON emails(user_id, domain_id, message_id);
