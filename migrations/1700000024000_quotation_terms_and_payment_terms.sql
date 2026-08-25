-- Up Migration
-- DEC-016 close-out: the quotation's boilerplate stops being placeholder text
-- in the generator and becomes versioned business content like everything else.
--
-- 1) Standard terms, ordered. A table rather than app_config because these are
--    an ordered list that CBP will reword over time, and every past quotation
--    must stay reproducible from the guide version it was priced against.
CREATE TABLE quotation_terms (
  term_id            TEXT PRIMARY KEY,
  guide_version_id     TEXT NOT NULL REFERENCES guide_versions(guide_version_id),
  source_key             TEXT NOT NULL,
  sort_order               INTEGER NOT NULL,
  term_text                  TEXT NOT NULL,
  active                       BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guide_version_id, source_key)
);

CREATE INDEX quotation_terms_order_idx ON quotation_terms (guide_version_id, sort_order);

-- 2) Payment terms are negotiated per customer, so they belong on the customer
--    record rather than in the shared terms list. The costing keeps its own
--    nullable override for the deal that differs from the account default.
ALTER TABLE customers ADD COLUMN payment_terms TEXT;
ALTER TABLE costing_headers ADD COLUMN payment_terms_override TEXT;

-- Down Migration

ALTER TABLE costing_headers DROP COLUMN IF EXISTS payment_terms_override;
ALTER TABLE customers DROP COLUMN IF EXISTS payment_terms;
DROP TABLE IF EXISTS quotation_terms;
