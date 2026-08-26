-- Lean automatic-forwarding outbox: one immutable destination snapshot and
-- one lease. Daily quota and provider-phase reservation are deliberately absent.
ALTER TABLE emails ADD COLUMN forwarding_hop INTEGER NOT NULL DEFAULT 0
	CHECK (forwarding_hop >= 0 AND forwarding_hop <= 1);
ALTER TABLE emails ADD COLUMN attachments_ready INTEGER NOT NULL DEFAULT 0
	CHECK (attachments_ready IN (0, 1));

ALTER TABLE forwarding_rules ADD COLUMN enabled_at TEXT;

UPDATE forwarding_rules
	SET enabled_at = datetime('now')
	WHERE status = 'enabled' AND enabled_at IS NULL;

ALTER TABLE forwarding_attempts ADD COLUMN lease_token TEXT;
ALTER TABLE forwarding_attempts ADD COLUMN lease_expires_at TEXT;
ALTER TABLE forwarding_attempts ADD COLUMN hop INTEGER NOT NULL DEFAULT 0
	CHECK (hop >= 0 AND hop <= 1);
ALTER TABLE forwarding_attempts ADD COLUMN destination_id TEXT
	REFERENCES forwarding_destinations(id) ON DELETE SET NULL;
ALTER TABLE forwarding_attempts ADD COLUMN destination_address TEXT;

UPDATE forwarding_attempts
	SET destination_id = (SELECT destination_id FROM forwarding_rules WHERE id = forwarding_attempts.rule_id)
	WHERE destination_id IS NULL;

UPDATE forwarding_attempts
	SET destination_address = (
		SELECT d.destination_address
		FROM forwarding_rules r
		JOIN forwarding_destinations d ON d.id = r.destination_id
		WHERE r.id = forwarding_attempts.rule_id
	)
	WHERE destination_address IS NULL;

CREATE INDEX idx_forwarding_attempts_lease
	ON forwarding_attempts(status, lease_expires_at);

CREATE INDEX idx_forwarding_attempts_current_destination
	ON forwarding_attempts(rule_id, destination_id, created_at DESC);
