-- Up Migration
-- 1) Minimum selling price floor per item (CBP's "minimum harga", 2026-08-25).
--    Keyed by product_family + material_class (Stainless vs Non-Stainless),
--    which is the same split the Quantity rate card already uses, so the
--    existing grade->stainless classifier is reused rather than duplicated.
--    Values stay versioned master data (DEC-001): never hardcoded in the engine.
CREATE TABLE minimum_prices (
  minimum_price_id   TEXT PRIMARY KEY,
  guide_version_id     TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key             TEXT NOT NULL,
  product_family           TEXT NOT NULL,
  material_class             TEXT NOT NULL CHECK (material_class IN ('Stainless', 'Non-Stainless')),
  minimum_price                NUMERIC NOT NULL CHECK (minimum_price >= 0),
  currency                       TEXT NOT NULL DEFAULT 'IDR',
  active                           BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);

CREATE INDEX minimum_prices_lookup_idx ON minimum_prices (guide_version_id, product_family, material_class);

-- 2) Human-facing coating names ("Plain", "Zinc") separate from the process
--    code the engine matches on ("Dies"), mirroring grade_profile_rules.
--    display_label added for the same reason (DEC-041).
ALTER TABLE coating_price_guides ADD COLUMN display_label TEXT;

-- Down Migration

ALTER TABLE coating_price_guides DROP COLUMN IF EXISTS display_label;
DROP TABLE IF EXISTS minimum_prices;
