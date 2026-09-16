-- Up Migration
-- Per-line and total (pre-PPN) discounts, either a percent or a flat Rupiah
-- amount. Total discount is applied after all line discounts, both before
-- PPN. Editing these on an already-finalized costing is blocked the same way
-- every other line/header edit is (policy.assertCanEditCosting) — a discount
-- change only ever lands via a new Revision, never rewriting a finalized
-- quotation_no in place.

ALTER TABLE costing_lines
  ADD COLUMN discount_type TEXT CHECK (discount_type IN ('PERCENT', 'AMOUNT')),
  ADD COLUMN discount_value NUMERIC CHECK (discount_value IS NULL OR discount_value >= 0);

ALTER TABLE costing_headers
  ADD COLUMN total_discount_type TEXT CHECK (total_discount_type IN ('PERCENT', 'AMOUNT')),
  ADD COLUMN total_discount_value NUMERIC CHECK (total_discount_value IS NULL OR total_discount_value >= 0);

-- Down Migration

ALTER TABLE costing_headers DROP COLUMN total_discount_type, DROP COLUMN total_discount_value;
ALTER TABLE costing_lines DROP COLUMN discount_type, DROP COLUMN discount_value;
