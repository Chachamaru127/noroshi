-- Purpose-specific, privacy-minimized throttling for public login and first-admin setup.
-- Raw IP addresses, email addresses, and setup keys are never stored.
CREATE TABLE auth_rate_limits (
	scope TEXT NOT NULL CHECK (scope IN ('login', 'setup')),
	key_hash TEXT NOT NULL,
	window_started_at TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
	expires_at TEXT NOT NULL,
	PRIMARY KEY (scope, key_hash)
);

CREATE INDEX idx_auth_rate_limits_expiry ON auth_rate_limits(expires_at);

CREATE TABLE setup_bootstrap_claim (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	lease_token TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
