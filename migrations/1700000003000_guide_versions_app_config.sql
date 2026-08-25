-- Up Migration
-- Minimal structure needed as a foreign-key target in Phase 1. Full import/validate/
-- publish/retire lifecycle and population is built in Phase 2 (06_RULE_ENGINE /
-- 07_MASTER_VERSIONING). No business values are seeded here.

CREATE TABLE guide_versions (
  guide_version_id      TEXT PRIMARY KEY,
  version_code           TEXT NOT NULL UNIQUE,
  status                  TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'validated', 'published', 'retired')),
  previous_version_id    TEXT REFERENCES guide_versions(guide_version_id),
  import_batch_id        TEXT,
  effective_from          TIMESTAMPTZ,
  package_checksum        TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_config (
  config_id           TEXT PRIMARY KEY,
  guide_version_id    TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  config_key          TEXT NOT NULL,
  config_value        TEXT NOT NULL,
  data_type           TEXT NOT NULL,
  unit                TEXT,
  editable_by         TEXT,
  status               TEXT NOT NULL DEFAULT 'active',
  UNIQUE (guide_version_id, config_key)
);

-- Down Migration

DROP TABLE IF EXISTS app_config;
DROP TABLE IF EXISTS guide_versions;
