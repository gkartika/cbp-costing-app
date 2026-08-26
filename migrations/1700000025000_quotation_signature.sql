-- Up Migration
-- Who signs a quotation is not always who priced it: the owner builds the
-- costing, but the letter may go out over a manager's name (Brand Guidelines
-- p37 signs "name + jabatan"). Both nullable — when unset the document falls
-- back to the owner's display name, so existing quotations are unaffected.
ALTER TABLE costing_headers
  ADD COLUMN signed_by_name  TEXT,
  ADD COLUMN signed_by_title TEXT;

-- Down Migration

ALTER TABLE costing_headers
  DROP COLUMN IF EXISTS signed_by_name,
  DROP COLUMN IF EXISTS signed_by_title;
