-- Up Migration
-- Replaces the vestigial, always-empty `raw_material_bars` table (added in
-- phase 2 "so a guide package round-trips without silently dropping source
-- data", never wired to any formula, resolver, or import tab) with a real
-- material-aware raw bar stock catalog.
--
-- Why this has to be its own table rather than another material_size_guides
-- column: raw bar availability is keyed by (material, diameter), not by
-- (product_profile, size_label). The same Heavy Hex M22 needs a 22mm bar for
-- A325/SCM440 but a 22.23mm bar for A193-B8/SUS304 -- one row per profile+size
-- cannot represent two different answers for two different materials sharing
-- that row. See 14_DECISION_LOG DEC-039.
DROP TABLE IF EXISTS raw_material_bars;

CREATE TABLE raw_bar_stock (
  stock_id           TEXT PRIMARY KEY,
  guide_version_id     TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key             TEXT NOT NULL,
  material_id               TEXT NOT NULL REFERENCES materials(material_id),
  diameter_mm                 NUMERIC NOT NULL CHECK (diameter_mm > 0),
  -- Market label as CBP's supplier quotes it, e.g. "D20" or "3/4\"" -- purely
  -- informational for purchasing; calculations only ever use diameter_mm.
  size_code                     TEXT,
  active                          BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);

CREATE INDEX raw_bar_stock_material_idx ON raw_bar_stock (guide_version_id, material_id, diameter_mm);

-- Down Migration

DROP TABLE IF EXISTS raw_bar_stock;

CREATE TABLE raw_material_bars (
  raw_bar_id         TEXT PRIMARY KEY,
  guide_version_id     TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key            TEXT NOT NULL,
  raw_diameter_mm         NUMERIC NOT NULL CHECK (raw_diameter_mm > 0),
  bar_length_mm             NUMERIC CHECK (bar_length_mm IS NULL OR bar_length_mm > 0),
  bar_weight_kg               NUMERIC CHECK (bar_weight_kg IS NULL OR bar_weight_kg > 0),
  active                        BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);
