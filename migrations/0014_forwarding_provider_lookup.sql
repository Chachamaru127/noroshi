-- Keep provider delivery correlation indexed without changing attempt history.
CREATE INDEX idx_forwarding_attempts_provider
	ON forwarding_attempts(provider_id)
	WHERE provider_id IS NOT NULL;
