-- Up Migration
-- Manual override of a line's quoted unit price — set by the owner directly
-- on top of whatever Calculate All produced. Purely a display/quoting layer:
-- when set, it's what the workspace, reports, dashboard totals, and the
-- exported quotation show instead of the calculated (or Trading) price; the
-- underlying snapshot and its "needs recalculation" status are untouched, so
-- overriding a price never bypasses having calculated it at least once.
ALTER TABLE costing_lines
  ADD COLUMN unit_price_override NUMERIC CHECK (unit_price_override IS NULL OR unit_price_override >= 0);

-- Down Migration

ALTER TABLE costing_lines DROP COLUMN unit_price_override;
