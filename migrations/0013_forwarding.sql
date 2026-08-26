-- Automatic forwarding configuration and store-first delivery attempts.
--
-- 0012 is reserved for the provider-id uniqueness migration. These tables are
-- intentionally additive: disabling or deleting a rule never deletes mail or
-- its historical attempts.

CREATE TABLE forwarding_destinations (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	source_address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
	destination_address TEXT NOT NULL COLLATE NOCASE,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'verified')),
	verification_token_hash TEXT,
	verification_expires_at TEXT,
	verification_used_at TEXT,
	verified_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (user_id, source_address_id)
);

CREATE INDEX idx_forwarding_destinations_user
	ON forwarding_destinations(user_id, source_address_id);

CREATE TABLE forwarding_rules (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	source_address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
	destination_id TEXT NOT NULL REFERENCES forwarding_destinations(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'disabled'
		CHECK (status IN ('disabled', 'enabled', 'failed')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (user_id, source_address_id)
);

CREATE INDEX idx_forwarding_rules_user
	ON forwarding_rules(user_id, source_address_id);

CREATE TABLE forwarding_attempts (
	id TEXT PRIMARY KEY,
	rule_id TEXT NOT NULL REFERENCES forwarding_rules(id) ON DELETE CASCADE,
	email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
	provider_id TEXT,
	status TEXT NOT NULL DEFAULT 'queued'
		CHECK (status IN ('queued', 'processing', 'sent', 'failed', 'bounced', 'complained')),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	next_attempt_at TEXT,
	last_attempt_at TEXT,
	error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (rule_id, email_id)
);

CREATE INDEX idx_forwarding_attempts_due
	ON forwarding_attempts(status, next_attempt_at);

CREATE INDEX idx_forwarding_attempts_rule
	ON forwarding_attempts(rule_id, created_at DESC);
