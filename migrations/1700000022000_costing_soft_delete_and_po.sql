-- Up Migration
-- Dashboard needs two things the header could not express:
--
-- 1) Soft delete. Draft/Calculated costings can be removed from the dashboard,
--    but the row is retained rather than dropped — audit_events reference these
--    ids, and the app's whole premise is that history stays reconstructable.
--    Finalized/Revised are never deletable; those use Void, which is a
--    different, reason-bearing business act.
--
-- 2) PO tracking. Marks which issued quotations actually converted into a
--    purchase order. Deliberately editable while the costing itself is locked:
--    a PO can only arrive *after* finalization, so gating it on the edit lock
--    would make the flag impossible to set exactly when it matters.
ALTER TABLE costing_headers
  ADD COLUMN deleted_at   TIMESTAMPTZ,
  ADD COLUMN deleted_by   TEXT REFERENCES users(user_id),
  ADD COLUMN is_po        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN po_marked_at TIMESTAMPTZ,
  ADD COLUMN po_marked_by TEXT REFERENCES users(user_id);

-- The dashboard's default view is "not deleted, newest first".
CREATE INDEX costing_headers_active_idx ON costing_headers (created_at DESC) WHERE deleted_at IS NULL;

-- Down Migration

DROP INDEX IF EXISTS costing_headers_active_idx;
ALTER TABLE costing_headers
  DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS deleted_by,
  DROP COLUMN IF EXISTS is_po,
  DROP COLUMN IF EXISTS po_marked_at,
  DROP COLUMN IF EXISTS po_marked_by;
