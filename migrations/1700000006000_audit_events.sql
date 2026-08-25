-- Up Migration

CREATE TABLE audit_events (
  audit_event_id    TEXT PRIMARY KEY,
  action              TEXT NOT NULL,
  entity_type          TEXT NOT NULL,
  entity_id             TEXT NOT NULL,
  before_json            JSONB,
  after_json              JSONB,
  changed_fields           JSONB,
  reason                    TEXT,
  actor_user_id              TEXT REFERENCES users(user_id),
  actor_role                  TEXT NOT NULL,
  occurred_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id                    TEXT NOT NULL
);

CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id);
CREATE INDEX audit_events_occurred_idx ON audit_events (occurred_at DESC);
CREATE INDEX audit_events_request_idx ON audit_events (request_id);

-- Append-only: database itself denies UPDATE and DELETE regardless of caller (AUD-020 / AT-AUDIT-003).
CREATE TRIGGER audit_events_deny_mutation
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;

-- Down Migration

DROP TRIGGER IF EXISTS audit_events_deny_mutation ON audit_events;
DROP TABLE IF EXISTS audit_events;
