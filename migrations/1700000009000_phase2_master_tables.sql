-- Up Migration
-- Versioned CBP business master data (04_DATA_MODEL / 05_FIELD_DICTIONARY /
-- 07_MASTER_VERSIONING). Every row is scoped to one guide_version_id and is
-- only ever written by the import pipeline while that version is Draft — once
-- a version is Published its rows are immutable by convention (no UPDATE/
-- DELETE endpoint exists for these tables; a new version is imported instead).
--
-- source_key preserves the exact ID from the imported package (e.g. the
-- "MAT-SCM440" in the CBP data inventory) for cross-sheet reference
-- resolution at import time and for version-to-version diffing (VER-004).
-- The primary key is always a fresh server-generated id, because the same
-- source_key legitimately reappears as a new row in every new version.

CREATE TABLE materials (
  material_id       TEXT PRIMARY KEY,
  guide_version_id   TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key          TEXT NOT NULL,
  material_name        TEXT NOT NULL,
  density_kg_m3          NUMERIC NOT NULL CHECK (density_kg_m3 > 0),
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);

-- Raw stock bar catalog from the data inventory. Not referenced by any
-- documented calculation formula or acceptance test; kept so a guide package
-- round-trips through import/export without silently dropping source data.
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

CREATE TABLE material_grade_map (
  map_id             TEXT PRIMARY KEY,
  guide_version_id     TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key            TEXT NOT NULL,
  material_id             TEXT NOT NULL REFERENCES materials(material_id),
  product_family            TEXT NOT NULL,
  grade_or_spec               TEXT NOT NULL,
  active                        BOOLEAN NOT NULL DEFAULT TRUE,
  notes                          TEXT,
  UNIQUE (guide_version_id, source_key)
);
CREATE INDEX material_grade_map_lookup_idx
  ON material_grade_map (guide_version_id, product_family, grade_or_spec);

CREATE TABLE grade_profile_rules (
  rule_id             TEXT PRIMARY KEY,
  guide_version_id      TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key             TEXT NOT NULL,
  product_family           TEXT NOT NULL,
  grade_or_spec              TEXT NOT NULL,
  default_product_profile     TEXT NOT NULL,
  mapping_status                TEXT,
  override_allowed                BOOLEAN NOT NULL DEFAULT FALSE,
  priority                          INTEGER NOT NULL DEFAULT 0,
  active                             BOOLEAN NOT NULL DEFAULT TRUE,
  notes                               TEXT,
  standard_reference                   TEXT,
  reference_url                          TEXT,
  UNIQUE (guide_version_id, source_key)
);
CREATE INDEX grade_profile_rules_lookup_idx
  ON grade_profile_rules (guide_version_id, product_family, grade_or_spec) WHERE active;

CREATE TABLE grade_price_aliases (
  alias_id            TEXT PRIMARY KEY,
  guide_version_id      TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key             TEXT NOT NULL,
  product_family           TEXT NOT NULL,
  input_grade                TEXT NOT NULL,
  canonical_price_grade        TEXT NOT NULL,
  active                         BOOLEAN NOT NULL DEFAULT TRUE,
  decision_source                 TEXT,
  notes                             TEXT,
  UNIQUE (guide_version_id, source_key)
);
CREATE INDEX grade_price_aliases_lookup_idx
  ON grade_price_aliases (guide_version_id, product_family, input_grade) WHERE active;

CREATE TABLE material_size_guides (
  size_guide_id        TEXT PRIMARY KEY,
  guide_version_id       TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key              TEXT NOT NULL,
  unit_system                TEXT,
  standard_group                TEXT,
  product_profile                  TEXT NOT NULL,
  size_label                         TEXT NOT NULL,
  diameter                             NUMERIC,
  diameter_mm                            NUMERIC,
  material_diameter_mm                     NUMERIC,
  width_flat                                 NUMERIC,
  width_corner                                 NUMERIC,
  head_thickness                                 NUMERIC,
  washer_od                                        NUMERIC,
  washer_thickness                                   NUMERIC,
  active                                               BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);
CREATE INDEX material_size_guides_lookup_idx
  ON material_size_guides (guide_version_id, product_profile, size_label) WHERE active;

CREATE TABLE price_per_kg (
  price_id             TEXT PRIMARY KEY,
  guide_version_id       TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key              TEXT NOT NULL,
  product_family             TEXT NOT NULL,
  product_type                  TEXT,
  thread_condition                 TEXT,
  grade_or_spec                      TEXT NOT NULL,
  material                             TEXT,
  unit_system                            TEXT,
  size_label                               TEXT,
  diameter_mm                                NUMERIC,
  selling_price_per_kg                         NUMERIC NOT NULL CHECK (selling_price_per_kg >= 0),
  currency                                       TEXT NOT NULL DEFAULT 'IDR',
  valid_from                                       DATE,
  valid_to                                           DATE,
  active                                               BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);
CREATE INDEX price_per_kg_lookup_idx
  ON price_per_kg (guide_version_id, product_family, grade_or_spec, size_label) WHERE active;

CREATE TABLE coating_price_guides (
  coating_rule_id       TEXT PRIMARY KEY,
  guide_version_id        TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key               TEXT NOT NULL,
  process_group               TEXT NOT NULL,
  process_name                   TEXT NOT NULL,
  item_scope                       TEXT,
  material_scope                     TEXT,
  size_label                           TEXT,
  min_diameter_mm                        NUMERIC,
  basis                                    TEXT NOT NULL,
  rate                                       NUMERIC NOT NULL CHECK (rate >= 0),
  currency                                     TEXT NOT NULL DEFAULT 'IDR',
  active                                         BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);
CREATE INDEX coating_price_guides_lookup_idx
  ON coating_price_guides (guide_version_id, process_name) WHERE active;

CREATE TABLE adjustment_rules (
  adjustment_rule_id    TEXT PRIMARY KEY,
  guide_version_id        TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key                TEXT NOT NULL,
  costing_route                TEXT NOT NULL,
  rule_group                     TEXT NOT NULL,
  scope                            TEXT NOT NULL,
  condition_field                    TEXT NOT NULL,
  operator                             TEXT NOT NULL DEFAULT 'range',
  threshold_min                          NUMERIC,
  threshold_max                            NUMERIC,
  adjustment_type                            TEXT NOT NULL,
  adjustment_value                             NUMERIC NOT NULL,
  applies_to_component                           TEXT NOT NULL,
  min_inclusive                                    BOOLEAN NOT NULL DEFAULT TRUE,
  max_inclusive                                      BOOLEAN NOT NULL DEFAULT TRUE,
  active                                               BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);
CREATE INDEX adjustment_rules_lookup_idx
  ON adjustment_rules (guide_version_id, scope, rule_group) WHERE active;

CREATE TABLE trading_items (
  trading_item_id       TEXT PRIMARY KEY,
  guide_version_id        TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key                TEXT NOT NULL,
  product_category             TEXT NOT NULL,
  product_name                    TEXT NOT NULL,
  grade_or_spec                      TEXT,
  material                             TEXT,
  unit_system                            TEXT,
  size_label                               TEXT NOT NULL,
  pitch                                      NUMERIC,
  width_flat                                   NUMERIC,
  thickness                                      NUMERIC,
  weight_kg                                        NUMERIC,
  purchase_price                                     NUMERIC,
  purchase_price_ex_tax                                NUMERIC,
  market_min                                             NUMERIC,
  market_max                                               NUMERIC,
  price_per_kg                                               NUMERIC,
  currency                                                     TEXT NOT NULL DEFAULT 'IDR',
  active                                                         BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);
CREATE INDEX trading_items_lookup_idx
  ON trading_items (guide_version_id, product_category, size_label) WHERE active;

CREATE TABLE trading_price_tiers (
  tier_id               TEXT PRIMARY KEY,
  guide_version_id        TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key                TEXT NOT NULL,
  trading_item_id              TEXT NOT NULL REFERENCES trading_items(trading_item_id),
  tier_label                     TEXT,
  qty_min                          INTEGER NOT NULL CHECK (qty_min >= 1),
  qty_max                            INTEGER CHECK (qty_max IS NULL OR qty_max >= qty_min),
  unit_price                          NUMERIC NOT NULL CHECK (unit_price >= 0),
  currency                              TEXT NOT NULL DEFAULT 'IDR',
  pricing_unit                            TEXT NOT NULL DEFAULT 'pcs',
  active                                     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);
CREATE INDEX trading_price_tiers_lookup_idx
  ON trading_price_tiers (trading_item_id, qty_min) WHERE active;

CREATE TABLE calculation_formulas (
  formula_id            TEXT PRIMARY KEY,
  guide_version_id        TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key                TEXT NOT NULL,
  product_family                TEXT NOT NULL,
  formula_scope                    TEXT NOT NULL,
  formula_expression                 TEXT NOT NULL,
  required_inputs                      TEXT NOT NULL,
  tolerance_pct                          NUMERIC,
  verification_status                      TEXT,
  active                                      BOOLEAN NOT NULL DEFAULT TRUE,
  standard_reference                            TEXT,
  notes                                           TEXT,
  UNIQUE (guide_version_id, source_key)
);
CREATE INDEX calculation_formulas_lookup_idx
  ON calculation_formulas (guide_version_id, product_family, formula_scope) WHERE active;

CREATE TABLE costing_route_rules (
  route_rule_id          TEXT PRIMARY KEY,
  guide_version_id         TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key                 TEXT NOT NULL,
  product_family                 TEXT NOT NULL,
  grade_or_spec                     TEXT NOT NULL,
  allowed_costing_route                TEXT NOT NULL CHECK (allowed_costing_route IN ('Trading', 'Custom Production')),
  price_source                            TEXT,
  enforcement                               TEXT NOT NULL DEFAULT 'required',
  priority                                    INTEGER NOT NULL DEFAULT 0,
  active                                        BOOLEAN NOT NULL DEFAULT TRUE,
  notes                                           TEXT,
  UNIQUE (guide_version_id, source_key)
);
CREATE INDEX costing_route_rules_lookup_idx
  ON costing_route_rules (guide_version_id, product_family, grade_or_spec) WHERE active;

-- Down Migration

DROP TABLE IF EXISTS costing_route_rules;
DROP TABLE IF EXISTS calculation_formulas;
DROP TABLE IF EXISTS trading_price_tiers;
DROP TABLE IF EXISTS trading_items;
DROP TABLE IF EXISTS adjustment_rules;
DROP TABLE IF EXISTS coating_price_guides;
DROP TABLE IF EXISTS price_per_kg;
DROP TABLE IF EXISTS material_size_guides;
DROP TABLE IF EXISTS grade_price_aliases;
DROP TABLE IF EXISTS grade_profile_rules;
DROP TABLE IF EXISTS material_grade_map;
DROP TABLE IF EXISTS raw_material_bars;
DROP TABLE IF EXISTS materials;
