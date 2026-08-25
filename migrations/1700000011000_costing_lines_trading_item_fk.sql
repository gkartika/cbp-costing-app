-- Up Migration

ALTER TABLE costing_lines
  ADD CONSTRAINT costing_lines_trading_item_fk
  FOREIGN KEY (trading_item_id) REFERENCES trading_items(trading_item_id);

-- Down Migration

ALTER TABLE costing_lines DROP CONSTRAINT IF EXISTS costing_lines_trading_item_fk;
