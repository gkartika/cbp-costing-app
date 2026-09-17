-- Up Migration
-- Splits Costing User into two tiers: Costing Head gets everything Costing
-- User has, plus the right to edit an existing customer (previously Super
-- Admin only).

INSERT INTO roles (role_id, role_name) VALUES
  ('role_costing_head', 'costing_head');

-- Down Migration

DELETE FROM roles WHERE role_id = 'role_costing_head';
