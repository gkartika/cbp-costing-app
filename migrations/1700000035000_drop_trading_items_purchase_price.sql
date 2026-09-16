-- Up Migration
-- purchase_price / purchase_price_ex_tax were kept in the prior cleanup
-- (1700000028000) as an internal cost reference for Super Admin, but no
-- admin screen ever surfaced them and no calc code reads them -- confirmed
-- unused in practice, not just unused by the pricing engine. Dropping them;
-- trading_items itself is untouched and still required for item matching.
ALTER TABLE trading_items
  DROP COLUMN IF EXISTS purchase_price,
  DROP COLUMN IF EXISTS purchase_price_ex_tax;

-- Down Migration

ALTER TABLE trading_items
  ADD COLUMN IF NOT EXISTS purchase_price NUMERIC,
  ADD COLUMN IF NOT EXISTS purchase_price_ex_tax NUMERIC;
