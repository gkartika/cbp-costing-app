-- Up Migration
-- Real CBP dies/cetakan cost card, keyed by (product_family, product_profile,
-- size) rather than grade — the mold cost depends on the bolt/nut's physical
-- hex geometry, not what steel it's cut from. Backs the "Dies/Tooling
-- tersedia? -> Tidak" system-lookup option (as opposed to "Lainnya", which
-- still takes a manually-entered cost).

CREATE TABLE dies_cost_guides (
  dies_cost_id       TEXT PRIMARY KEY,
  guide_version_id     TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key              TEXT NOT NULL,
  product_family            TEXT NOT NULL,
  product_profile             TEXT NOT NULL,
  size_label                    TEXT NOT NULL,
  diameter_mm                     NUMERIC NOT NULL CHECK (diameter_mm > 0),
  cost                               NUMERIC NOT NULL CHECK (cost >= 0),
  currency                             TEXT NOT NULL DEFAULT 'IDR',
  active                                  BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);

CREATE INDEX dies_cost_guides_lookup_idx ON dies_cost_guides (guide_version_id, product_family, product_profile, diameter_mm);

-- costing_lines.dies_available (boolean) can't represent three states —
-- "Ya" (no cost), "Tidak" (system looks up a standard cost), "Lainnya"
-- (user enters the cost manually) — so it's replaced with a text enum.
-- Existing values map across without loss: TRUE -> 'yes', FALSE -> 'manual'
-- (FALSE previously always required a manually-supplied dies_total_cost).
ALTER TABLE costing_lines ADD COLUMN dies_option TEXT CHECK (dies_option IN ('yes', 'no_lookup', 'manual'));
UPDATE costing_lines SET dies_option = CASE
  WHEN dies_available = TRUE THEN 'yes'
  WHEN dies_available = FALSE THEN 'manual'
  ELSE NULL
END;
ALTER TABLE costing_lines DROP COLUMN dies_available;

-- Down Migration

ALTER TABLE costing_lines ADD COLUMN dies_available BOOLEAN;
UPDATE costing_lines SET dies_available = CASE
  WHEN dies_option = 'yes' THEN TRUE
  WHEN dies_option IN ('manual', 'no_lookup') THEN FALSE
  ELSE NULL
END;
ALTER TABLE costing_lines DROP COLUMN dies_option;

DROP TABLE IF EXISTS dies_cost_guides;
