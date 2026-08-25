-- Up Migration
-- Postgres `now()` has microsecond precision but JS Date (used for optimistic
-- concurrency's expected_updated_at round-trip) only has millisecond precision.
-- Left as-is, a client echoing back a server-issued updated_at would never
-- exactly match the stored value, causing every first save to spuriously fail
-- as STALE_UPDATE. Pinning columns to timestamptz(3) makes the stored value
-- and any JS-derived value comparable byte-for-byte.

ALTER TABLE roles ALTER COLUMN created_at TYPE timestamptz(3);

ALTER TABLE users ALTER COLUMN created_at TYPE timestamptz(3);
ALTER TABLE users ALTER COLUMN updated_at TYPE timestamptz(3);

ALTER TABLE user_roles ALTER COLUMN valid_from TYPE timestamptz(3);
ALTER TABLE user_roles ALTER COLUMN valid_to TYPE timestamptz(3);
ALTER TABLE user_roles ALTER COLUMN created_at TYPE timestamptz(3);

ALTER TABLE sessions ALTER COLUMN created_at TYPE timestamptz(3);
ALTER TABLE sessions ALTER COLUMN expires_at TYPE timestamptz(3);
ALTER TABLE sessions ALTER COLUMN revoked_at TYPE timestamptz(3);

ALTER TABLE password_reset_tokens ALTER COLUMN expires_at TYPE timestamptz(3);
ALTER TABLE password_reset_tokens ALTER COLUMN used_at TYPE timestamptz(3);
ALTER TABLE password_reset_tokens ALTER COLUMN created_at TYPE timestamptz(3);

ALTER TABLE customers ALTER COLUMN created_at TYPE timestamptz(3);
ALTER TABLE customers ALTER COLUMN updated_at TYPE timestamptz(3);

ALTER TABLE guide_versions ALTER COLUMN effective_from TYPE timestamptz(3);
ALTER TABLE guide_versions ALTER COLUMN created_at TYPE timestamptz(3);

ALTER TABLE costing_headers ALTER COLUMN created_at TYPE timestamptz(3);
ALTER TABLE costing_headers ALTER COLUMN updated_at TYPE timestamptz(3);
ALTER TABLE costing_headers ALTER COLUMN finalized_at TYPE timestamptz(3);
ALTER TABLE costing_headers ALTER COLUMN voided_at TYPE timestamptz(3);

ALTER TABLE costing_lines ALTER COLUMN created_at TYPE timestamptz(3);
ALTER TABLE costing_lines ALTER COLUMN updated_at TYPE timestamptz(3);
ALTER TABLE costing_lines ALTER COLUMN deleted_at TYPE timestamptz(3);

ALTER TABLE trading_quotes ALTER COLUMN created_at TYPE timestamptz(3);
ALTER TABLE trading_quotes ALTER COLUMN updated_at TYPE timestamptz(3);

ALTER TABLE line_calculation_snapshots ALTER COLUMN created_at TYPE timestamptz(3);

ALTER TABLE quotation_exports ALTER COLUMN created_at TYPE timestamptz(3);

ALTER TABLE audit_events ALTER COLUMN occurred_at TYPE timestamptz(3);

-- Down Migration

ALTER TABLE audit_events ALTER COLUMN occurred_at TYPE timestamptz;
ALTER TABLE quotation_exports ALTER COLUMN created_at TYPE timestamptz;
ALTER TABLE line_calculation_snapshots ALTER COLUMN created_at TYPE timestamptz;
ALTER TABLE trading_quotes ALTER COLUMN updated_at TYPE timestamptz;
ALTER TABLE trading_quotes ALTER COLUMN created_at TYPE timestamptz;
ALTER TABLE costing_lines ALTER COLUMN deleted_at TYPE timestamptz;
ALTER TABLE costing_lines ALTER COLUMN updated_at TYPE timestamptz;
ALTER TABLE costing_lines ALTER COLUMN created_at TYPE timestamptz;
ALTER TABLE costing_headers ALTER COLUMN voided_at TYPE timestamptz;
ALTER TABLE costing_headers ALTER COLUMN finalized_at TYPE timestamptz;
ALTER TABLE costing_headers ALTER COLUMN updated_at TYPE timestamptz;
ALTER TABLE costing_headers ALTER COLUMN created_at TYPE timestamptz;
ALTER TABLE guide_versions ALTER COLUMN created_at TYPE timestamptz;
ALTER TABLE guide_versions ALTER COLUMN effective_from TYPE timestamptz;
ALTER TABLE customers ALTER COLUMN updated_at TYPE timestamptz;
ALTER TABLE customers ALTER COLUMN created_at TYPE timestamptz;
ALTER TABLE password_reset_tokens ALTER COLUMN created_at TYPE timestamptz;
ALTER TABLE password_reset_tokens ALTER COLUMN used_at TYPE timestamptz;
ALTER TABLE password_reset_tokens ALTER COLUMN expires_at TYPE timestamptz;
ALTER TABLE sessions ALTER COLUMN revoked_at TYPE timestamptz;
ALTER TABLE sessions ALTER COLUMN expires_at TYPE timestamptz;
ALTER TABLE sessions ALTER COLUMN created_at TYPE timestamptz;
ALTER TABLE user_roles ALTER COLUMN created_at TYPE timestamptz;
ALTER TABLE user_roles ALTER COLUMN valid_to TYPE timestamptz;
ALTER TABLE user_roles ALTER COLUMN valid_from TYPE timestamptz;
ALTER TABLE users ALTER COLUMN updated_at TYPE timestamptz;
ALTER TABLE users ALTER COLUMN created_at TYPE timestamptz;
ALTER TABLE roles ALTER COLUMN created_at TYPE timestamptz;
