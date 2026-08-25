-- Up Migration
-- material_size_guides.diameter/material_diameter_mm as originally modeled were
-- ambiguous about which value the Custom pipeline should actually cut raw stock
-- to. Renamed to raw_diameter_mm to make its role explicit (06_RULE_ENGINE
-- step 4: recommended raw material dimension), and dropped the redundant
-- unitless `diameter` column (diameter_mm already carries the nominal size).

ALTER TABLE material_size_guides DROP COLUMN diameter;
ALTER TABLE material_size_guides RENAME COLUMN material_diameter_mm TO raw_diameter_mm;

-- Down Migration

ALTER TABLE material_size_guides RENAME COLUMN raw_diameter_mm TO material_diameter_mm;
ALTER TABLE material_size_guides ADD COLUMN diameter NUMERIC;
