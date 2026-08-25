-- Up Migration
-- The real CBP price guide prices Bolt HT and FT separately at the same
-- grade+size, so a Custom Production Bolt line needs to record which one was
-- priced (see resolvePricePerKg's discriminators in src/lib/calc/resolvers.ts).

ALTER TABLE costing_lines ADD COLUMN thread_condition TEXT;

-- Down Migration

ALTER TABLE costing_lines DROP COLUMN IF EXISTS thread_condition;
