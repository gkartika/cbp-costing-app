-- Up Migration
-- Marking a quotation as won now requires the customer's own PO number.
-- It doubles as the confirmation step: a stray click on the PO checkbox
-- cannot flip the flag without the user having a real document reference to
-- hand, and the number is what ties the quotation to the customer's paperwork.
ALTER TABLE costing_headers ADD COLUMN po_number TEXT;

-- Down Migration

ALTER TABLE costing_headers DROP COLUMN IF EXISTS po_number;
