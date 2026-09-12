-- Up Migration
-- Restores trading_items.pitch, dropped in 1700000028000 as apparently-dead
-- import leftover. It isn't a pricing input (still true -- the engine prices
-- off trading_price_tiers.unit_price alone), but it turns out to be real
-- reference information for Super Admin: the thread-pitch designation (e.g.
-- "T16", "T14") shown next to size in the new Trading pricelist matrix
-- editor, and now also folded into the line description on a costing so a
-- quotation names the exact thread the price applies to. TEXT rather than
-- the original NUMERIC -- inch thread pitch is conventionally written as a
-- "T"-number code, not a decimal.
ALTER TABLE trading_items ADD COLUMN IF NOT EXISTS pitch TEXT;

-- Down Migration

ALTER TABLE trading_items DROP COLUMN IF EXISTS pitch;
