-- Up Migration
-- Trading pricing route (Nut/Washer fixed pricelist) is priced entirely off
-- trading_price_tiers.unit_price -- these trading_items columns were carried
-- over from the source spreadsheet import but were never read by any calc,
-- API, or UI code. Dropping them to stop them looking like real pricing
-- inputs when they're just unused import leftovers (audit, 2026-09-12).
-- purchase_price / purchase_price_ex_tax are kept: real internal cost
-- reference for Super Admin, even though the engine doesn't price off them.
ALTER TABLE trading_items
  DROP COLUMN IF EXISTS weight_kg,
  DROP COLUMN IF EXISTS market_min,
  DROP COLUMN IF EXISTS market_max,
  DROP COLUMN IF EXISTS price_per_kg,
  DROP COLUMN IF EXISTS pitch,
  DROP COLUMN IF EXISTS width_flat,
  DROP COLUMN IF EXISTS thickness,
  DROP COLUMN IF EXISTS material,
  DROP COLUMN IF EXISTS unit_system,
  DROP COLUMN IF EXISTS currency;

-- Down Migration

ALTER TABLE trading_items
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC,
  ADD COLUMN IF NOT EXISTS market_min NUMERIC,
  ADD COLUMN IF NOT EXISTS market_max NUMERIC,
  ADD COLUMN IF NOT EXISTS price_per_kg NUMERIC,
  ADD COLUMN IF NOT EXISTS pitch NUMERIC,
  ADD COLUMN IF NOT EXISTS width_flat NUMERIC,
  ADD COLUMN IF NOT EXISTS thickness NUMERIC,
  ADD COLUMN IF NOT EXISTS material TEXT,
  ADD COLUMN IF NOT EXISTS unit_system TEXT,
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'IDR';
