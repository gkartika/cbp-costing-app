-- Up Migration
-- Pitch/Thread: STANDARD (no price impact) or CUSTOM (a user-typed pitch,
-- +10% surcharge applied in the calc pipeline). No master lookup table —
-- "custom" always costs the same +10%, regardless of the actual value typed.
ALTER TABLE costing_lines
  ADD COLUMN pitch_type TEXT CHECK (pitch_type IN ('STANDARD', 'CUSTOM')),
  ADD COLUMN pitch_value TEXT;

-- Route merge: every line now always gets a Production price, and a Trading
-- price only when the line's attributes auto-match a trading_items row.
-- chosen_price_kind is the user's pick between the two before Finalize —
-- required only when both exist; a line with just one price needs no choice.
ALTER TABLE costing_lines
  ADD COLUMN chosen_price_kind TEXT CHECK (chosen_price_kind IN ('PRODUCTION', 'TRADING'));

-- A line can now carry up to two snapshots per Calculate All pass (one per
-- price kind actually available for it) instead of exactly one.
ALTER TABLE line_calculation_snapshots
  ADD COLUMN price_kind TEXT NOT NULL DEFAULT 'PRODUCTION' CHECK (price_kind IN ('PRODUCTION', 'TRADING'));

-- Down Migration

ALTER TABLE line_calculation_snapshots DROP COLUMN price_kind;
ALTER TABLE costing_lines DROP COLUMN chosen_price_kind;
ALTER TABLE costing_lines DROP COLUMN pitch_type, DROP COLUMN pitch_value;
