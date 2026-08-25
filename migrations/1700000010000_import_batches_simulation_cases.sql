-- Up Migration

CREATE TABLE import_batches (
  import_batch_id     TEXT PRIMARY KEY,
  guide_version_id      TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  uploaded_by             TEXT NOT NULL REFERENCES users(user_id),
  original_filename         TEXT NOT NULL,
  file_checksum               TEXT NOT NULL,
  status                        TEXT NOT NULL DEFAULT 'staged'
                                   CHECK (status IN ('staged', 'validated', 'rejected')),
  validation_report               JSONB,
  created_at                        TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX import_batches_guide_version_idx ON import_batches (guide_version_id);

ALTER TABLE guide_versions
  ADD CONSTRAINT guide_versions_import_batch_fk
  FOREIGN KEY (import_batch_id) REFERENCES import_batches(import_batch_id);

-- Golden regression cases (PKG-014). Stored as JSONB rather than one column
-- per possible field because cases span very different shapes (Bolt/Nut vs.
-- Washer vs. Trading-quote vs. coating-only) — a fixed relational shape would
-- either force dozens of always-null columns or silently drop fields.
CREATE TABLE simulation_cases (
  simulation_id        TEXT PRIMARY KEY,
  guide_version_id       TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key               TEXT NOT NULL,
  route                       TEXT NOT NULL,
  product_family                 TEXT,
  input_json                        JSONB NOT NULL,
  expected_json                       JSONB NOT NULL,
  notes                                 TEXT,
  active                                   BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);

-- Down Migration

DROP TABLE IF EXISTS simulation_cases;
ALTER TABLE guide_versions DROP CONSTRAINT IF EXISTS guide_versions_import_batch_fk;
DROP TABLE IF EXISTS import_batches;
