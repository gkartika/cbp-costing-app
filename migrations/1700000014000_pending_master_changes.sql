-- Up Migration
-- Staging area for row-level master-data edits (create/update/deactivate) made
-- through the app UI or a single-table bulk import, awaiting review + publish.
-- This decouples "edit one price" from "reassemble the whole 14-tab package":
-- a pending change targets exactly one table by its business key (source_key),
-- and publishing clones the current Published guide version forward, applying
-- only the pending changes for the table being published (07_MASTER_VERSIONING
-- reused as-is — see cloneForward.ts).

CREATE TABLE pending_master_changes (
  pending_change_id       TEXT PRIMARY KEY,
  table_name                TEXT NOT NULL,
  operation                    TEXT NOT NULL CHECK (operation IN ('create', 'update', 'deactivate')),
  source_key                     TEXT NOT NULL,
  fields_json                       JSONB,
  reason                                TEXT,
  status                                   TEXT NOT NULL DEFAULT 'pending'
                                              CHECK (status IN ('pending', 'published', 'discarded')),
  created_by                                  TEXT NOT NULL REFERENCES users(user_id),
  created_at                                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_guide_version_id                        TEXT REFERENCES guide_versions(guide_version_id),
  published_at                                         TIMESTAMPTZ
);

CREATE INDEX pending_master_changes_table_status_idx
  ON pending_master_changes (table_name, status);

-- Down Migration

DROP TABLE IF EXISTS pending_master_changes;
