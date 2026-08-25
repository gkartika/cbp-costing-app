-- Up Migration

CREATE TABLE costing_headers (
  costing_id              TEXT PRIMARY KEY,
  quotation_no             TEXT UNIQUE,
  customer_id              TEXT REFERENCES customers(customer_id),
  customer_name_snapshot   TEXT NOT NULL,
  customer_code_snapshot   TEXT,
  owner_user_id            TEXT NOT NULL REFERENCES users(user_id),
  status                    TEXT NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'calculated', 'finalized', 'revised', 'voided')),
  guide_version_id         TEXT REFERENCES guide_versions(guide_version_id),
  revision_no               INTEGER NOT NULL DEFAULT 0 CHECK (revision_no >= 0),
  parent_costing_id         TEXT REFERENCES costing_headers(costing_id),
  currency                  TEXT NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  tax_output_mode           TEXT NOT NULL DEFAULT 'EXCLUDE_PPN' CHECK (tax_output_mode = 'EXCLUDE_PPN'),
  validity_days             INTEGER NOT NULL DEFAULT 30 CHECK (validity_days > 0),
  created_by                TEXT NOT NULL REFERENCES users(user_id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at              TIMESTAMPTZ,
  voided_at                 TIMESTAMPTZ,
  void_reason                TEXT
);

CREATE INDEX costing_headers_owner_idx ON costing_headers (owner_user_id);
CREATE INDEX costing_headers_status_idx ON costing_headers (status);
CREATE INDEX costing_headers_customer_idx ON costing_headers (customer_id);

CREATE TABLE costing_lines (
  costing_line_id            TEXT PRIMARY KEY,
  costing_id                  TEXT NOT NULL REFERENCES costing_headers(costing_id),
  line_no                      INTEGER NOT NULL,
  route                        TEXT CHECK (route IN ('TRADING', 'CUSTOM')),
  product_family               TEXT,
  description                  TEXT,
  grade_input                  TEXT,
  profile_resolved             TEXT,
  diameter_mm                  NUMERIC,
  length_mm                    NUMERIC,
  developed_cut_length_mm      NUMERIC,
  width_corner_mm              NUMERIC,
  width_flat_mm                NUMERIC,
  raw_diameter_mm               NUMERIC,
  raw_thickness_mm              NUMERIC,
  qty                           INTEGER CHECK (qty IS NULL OR qty >= 1),
  lead_time_days                INTEGER,
  coating_code                  TEXT,
  dies_available                 BOOLEAN,
  dies_total_cost                NUMERIC CHECK (dies_total_cost IS NULL OR dies_total_cost >= 0),
  margin_percent                 NUMERIC CHECK (margin_percent IS NULL OR (margin_percent >= 0 AND margin_percent < 1)),
  trading_item_id                TEXT,
  trading_quote_id               TEXT,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                     TIMESTAMPTZ
);

CREATE UNIQUE INDEX costing_lines_line_no_unique
  ON costing_lines (costing_id, line_no)
  WHERE deleted_at IS NULL;

CREATE INDEX costing_lines_costing_id_idx ON costing_lines (costing_id);

-- Down Migration

DROP TABLE IF EXISTS costing_lines;
DROP TABLE IF EXISTS costing_headers;
