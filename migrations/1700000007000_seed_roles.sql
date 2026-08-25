-- Up Migration
-- Seeds the fixed role vocabulary (DEC-006). These are structural application
-- roles, not CBP business data, so they are safe to define in a migration.

INSERT INTO roles (role_id, role_name) VALUES
  ('role_costing_user', 'costing_user'),
  ('role_super_admin', 'super_admin'),
  ('role_auditor', 'auditor');

-- Down Migration

DELETE FROM roles WHERE role_id IN ('role_costing_user', 'role_super_admin', 'role_auditor');
