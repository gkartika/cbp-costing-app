-- Up Migration
-- The weight tolerance applied on top of raw_weight before pricing was
-- previously always app_config.CUSTOM_WEIGHT_TOLERANCE (hardcoded at 2%).
-- This lets a Custom Production line override it per line, still defaulting
-- to the guide's config value when left blank.

ALTER TABLE costing_lines ADD COLUMN weight_tolerance_percent NUMERIC;

-- Down Migration

ALTER TABLE costing_lines DROP COLUMN IF EXISTS weight_tolerance_percent;
