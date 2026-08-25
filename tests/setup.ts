import { beforeEach, afterAll } from "vitest";
import { pool } from "../src/lib/db";

beforeEach(async () => {
  // `roles` is seeded reference data (DEC-006), not per-test fixture state — leave it in place.
  // Master/guide tables (app_config, guide_versions, price_per_kg, ...) are
  // deliberately NOT truncated here: calc-engine tests seed one guide_version
  // per file in beforeAll and only ever read it, scoped by its own
  // guide_version_id, so leaving prior versions in place across test files
  // causes no cross-contamination and avoids re-seeding master data per test.
  await pool.query(`
    TRUNCATE TABLE
      audit_events, quotation_exports, line_calculation_snapshots, trading_quotes,
      costing_lines, costing_headers, customers, password_reset_tokens, sessions,
      user_roles, users
    CASCADE
  `);
});

afterAll(async () => {
  await pool.end();
});
