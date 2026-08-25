-- Up Migration
-- calculateOneLine previously always re-derived size_label as "M<diameterMm>"
-- (deriveSizeLabel), which only happens to match real Metric size_labels —
-- an Inch size like "1/2" (12.7mm) synthesized to the nonexistent "M12.7"
-- and failed to match any material_size_guides/price_per_kg row. Storing the
-- real, user-selected size_label on the line fixes this. Existing lines keep
-- size_label NULL; calculateOneLine falls back to deriveSizeLabel for those,
-- same as before, so no existing Metric line's calculation changes.

ALTER TABLE costing_lines ADD COLUMN size_label TEXT;

-- Down Migration

ALTER TABLE costing_lines DROP COLUMN IF EXISTS size_label;
