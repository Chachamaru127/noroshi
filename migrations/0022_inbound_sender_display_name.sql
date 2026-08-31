-- Preserve the human-readable RFC From display name separately from the
-- mailbox address used for search, replies, and thread identity.
ALTER TABLE emails ADD COLUMN from_name TEXT;
