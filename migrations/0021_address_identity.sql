-- Keep the registered mailbox identity independently from the domain. Exact
-- address matches are backfilled; catch-all and other synthetic identities stay
-- NULL so deleting a saved address cannot delete mail.
ALTER TABLE emails ADD COLUMN address_id TEXT REFERENCES addresses(id) ON DELETE SET NULL;
CREATE INDEX idx_emails_address ON emails(address_id, created_at DESC);

UPDATE emails
SET address_id = (
	SELECT a.id
	FROM addresses a
	WHERE a.user_id = emails.user_id
	  AND a.address = emails.to_addr COLLATE NOCASE
)
WHERE direction = 'inbound' AND address_id IS NULL;

UPDATE emails
SET address_id = (
	SELECT a.id
	FROM addresses a
	WHERE a.user_id = emails.user_id
	  AND a.address = emails.from_addr COLLATE NOCASE
)
WHERE direction = 'outbound' AND address_id IS NULL;
