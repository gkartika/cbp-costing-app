-- Up Migration
--
-- Customer record grows three fields the quotation itself never shows (the
-- printed document still carries only the name) but the business now wants
-- tracked and, for the markup, actually applied:
--
--   segment          Distributor / Fabricator / Subcontractor / End User —
--                     backend classification only.
--   markup_percent   A per-customer price increase applied to every line
--                     item quoted for them (business decision 2026-09-04).
--                     Nullable/0 means no adjustment — most customers.
--   payment_terms already existed (1700000024000); this just gives it a
--   real editing surface via the new Customers page instead of only being
--   set by direct SQL.
--
-- Anyone may create a customer (unchanged); only Super Admin may edit one —
-- enforced in policy.ts, not by a DB constraint, matching every other
-- ownership/role rule in this app.
ALTER TABLE customers
  ADD COLUMN segment TEXT CHECK (segment IN ('Distributor', 'Fabricator', 'Subcontractor', 'End User')),
  ADD COLUMN markup_percent NUMERIC CHECK (markup_percent IS NULL OR markup_percent > -1);

-- Down Migration

ALTER TABLE customers
  DROP COLUMN IF EXISTS markup_percent,
  DROP COLUMN IF EXISTS segment;
