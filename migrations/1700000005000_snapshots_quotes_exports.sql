-- Up Migration
-- Transaction-evidence tables from 04_DATA_MODEL. Calculation logic that populates
-- line_calculation_snapshots is built in Phase 2; quotation numbering/export
-- generation is built in Phases 3-4. The structures are created now so the schema
-- matches the data model and so append-only guarantees are in place from day one.

CREATE TABLE trading_quotes (
  trading_quote_id        TEXT PRIMARY KEY,
  costing_line_id          TEXT NOT NULL REFERENCES costing_lines(costing_line_id),
  quoted_price              NUMERIC NOT NULL CHECK (quoted_price > 0),
  tax_basis                  TEXT NOT NULL CHECK (tax_basis IN ('INCLUDE_PPN', 'EXCLUDE_PPN')),
  ppn_rate                   NUMERIC CHECK (ppn_rate IS NULL OR ppn_rate >= 0),
  landed_cost_confirmed       BOOLEAN NOT NULL DEFAULT FALSE,
  entered_by                  TEXT NOT NULL REFERENCES users(user_id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX trading_quotes_line_idx ON trading_quotes (costing_line_id);

CREATE TABLE line_calculation_snapshots (
  snapshot_id                     TEXT PRIMARY KEY,
  costing_line_id                  TEXT NOT NULL REFERENCES costing_lines(costing_line_id),
  guide_version_id                  TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  input_snapshot_json                JSONB NOT NULL,
  resolved_rule_ids                  JSONB NOT NULL,
  raw_weight_per_item_kg              NUMERIC,
  costing_weight_per_item_kg           NUMERIC,
  base_price_per_item                  NUMERIC NOT NULL CHECK (base_price_per_item >= 0),
  coating_price_per_item                NUMERIC NOT NULL DEFAULT 0 CHECK (coating_price_per_item >= 0),
  dies_price_per_item                    NUMERIC NOT NULL DEFAULT 0 CHECK (dies_price_per_item >= 0),
  unit_price_before_rounding              NUMERIC NOT NULL CHECK (unit_price_before_rounding >= 0),
  unit_selling_price                       NUMERIC NOT NULL CHECK (unit_selling_price >= 0),
  order_total                               NUMERIC NOT NULL CHECK (order_total >= 0),
  result_hash                               TEXT NOT NULL,
  created_at                                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX line_calculation_snapshots_line_idx ON line_calculation_snapshots (costing_line_id);
CREATE INDEX line_calculation_snapshots_line_created_idx
  ON line_calculation_snapshots (costing_line_id, created_at DESC);

CREATE TABLE quotation_exports (
  export_id       TEXT PRIMARY KEY,
  costing_id       TEXT NOT NULL REFERENCES costing_headers(costing_id),
  generated_by      TEXT NOT NULL REFERENCES users(user_id),
  file_checksum      TEXT NOT NULL,
  template_version    TEXT,
  format               TEXT NOT NULL DEFAULT 'xlsx',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX quotation_exports_costing_idx ON quotation_exports (costing_id);

-- Append-only guarantee: no role, including the table owner, may UPDATE or DELETE
-- rows in evidence/snapshot tables through ordinary SQL statements.
CREATE OR REPLACE FUNCTION deny_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER line_calculation_snapshots_deny_mutation
  BEFORE UPDATE OR DELETE ON line_calculation_snapshots
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER quotation_exports_deny_mutation
  BEFORE UPDATE OR DELETE ON quotation_exports
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Down Migration

DROP TRIGGER IF EXISTS quotation_exports_deny_mutation ON quotation_exports;
DROP TRIGGER IF EXISTS line_calculation_snapshots_deny_mutation ON line_calculation_snapshots;
DROP FUNCTION IF EXISTS deny_mutation();
DROP TABLE IF EXISTS quotation_exports;
DROP TABLE IF EXISTS line_calculation_snapshots;
DROP TABLE IF EXISTS trading_quotes;
