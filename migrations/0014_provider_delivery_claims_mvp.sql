-- Recipient-scoped inbound identity. The trigger claim and destination insert
-- are one SQLite statement, so concurrent redelivery cannot create two emails.
CREATE TABLE provider_delivery_claims (
	provider_id TEXT NOT NULL,
	recipient TEXT NOT NULL COLLATE NOCASE,
	destination TEXT NOT NULL CHECK (destination IN ('email', 'unrouted')),
	record_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (provider_id, recipient)
);

INSERT OR IGNORE INTO provider_delivery_claims (provider_id, recipient, destination, record_id)
	SELECT provider_id, lower(to_addr), 'email', id
	FROM emails
	WHERE provider_id IS NOT NULL AND direction = 'inbound';

INSERT OR IGNORE INTO provider_delivery_claims (provider_id, recipient, destination, record_id)
	SELECT provider_id, lower(to_addr), 'unrouted', id
	FROM unrouted_emails
	WHERE provider_id IS NOT NULL;

CREATE TRIGGER claim_email_provider_delivery
	BEFORE INSERT ON emails
	WHEN NEW.provider_id IS NOT NULL AND NEW.direction = 'inbound'
BEGIN
	INSERT OR IGNORE INTO provider_delivery_claims (provider_id, recipient, destination, record_id)
		VALUES (NEW.provider_id, lower(NEW.to_addr), 'email', NEW.id);
	SELECT (CASE WHEN changes() = 0 THEN RAISE(IGNORE) END);
END;

CREATE TRIGGER claim_unrouted_provider_delivery
	BEFORE INSERT ON unrouted_emails
	WHEN NEW.provider_id IS NOT NULL
BEGIN
	INSERT OR IGNORE INTO provider_delivery_claims (provider_id, recipient, destination, record_id)
		VALUES (NEW.provider_id, lower(NEW.to_addr), 'unrouted', NEW.id);
	SELECT (CASE WHEN changes() = 0 THEN RAISE(IGNORE) END);
END;
