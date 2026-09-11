/**
 * One-off backfill for the customer_id bug fixed 2026-09-12: PATCH
 * /api/costings/:id used to write only customer_name_snapshot, never
 * customer_id, so any costing whose customer was set AFTER creation (the
 * normal "+ New Costing" then pick-a-customer flow) never actually linked
 * to the customer record — which meant its per-customer markup silently
 * never applied, regardless of what rate that customer had.
 *
 * The code fix self-heals a costing the next time its customer field is
 * touched through the UI, but does nothing for costings nobody re-touches.
 * This backfills every remaining one by exact customer_name_snapshot match,
 * a pure metadata link — it does not recalculate or change any already-
 * recorded price, including on finalized/revised quotations, so it is safe
 * to run against real historical data at any time.
 *
 * Usage: npm run backfill:costing-customer-ids
 */
import { pool, withTransaction } from "../src/lib/db";
import { writeAuditEvent } from "../src/lib/audit/writeAuditEvent";

async function resolveActorUserId(): Promise<string> {
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT u.user_id FROM users u
     JOIN user_roles ur ON ur.user_id = u.user_id AND ur.valid_to IS NULL
     JOIN roles r ON r.role_id = ur.role_id
     WHERE r.role_name = 'super_admin' AND u.active
     ORDER BY u.created_at LIMIT 1`,
  );
  if (rows.length === 0) throw new Error("No active super_admin user found to attribute this change to.");
  return rows[0].user_id;
}

async function main() {
  const actorUserId = await resolveActorUserId();

  const { rows: affected } = await pool.query<{ costing_id: string; customer_name_snapshot: string }>(
    `SELECT costing_id, customer_name_snapshot FROM costing_headers
     WHERE deleted_at IS NULL AND customer_id IS NULL AND customer_name_snapshot != ''`,
  );
  console.log(`Found ${affected.length} costing(s) with a customer name but no customer_id link.`);

  let linked = 0;
  let noMatch = 0;
  for (const row of affected) {
    const { rows: custRows } = await pool.query<{ customer_id: string; customer_code: string | null }>(
      `SELECT customer_id, customer_code FROM customers WHERE customer_name = $1 AND active = TRUE`,
      [row.customer_name_snapshot],
    );
    if (custRows.length === 0) {
      console.log(`  SKIP ${row.costing_id}: no active customer named "${row.customer_name_snapshot}".`);
      noMatch++;
      continue;
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE costing_headers SET customer_id = $1, customer_code_snapshot = $2 WHERE costing_id = $3`,
        [custRows[0].customer_id, custRows[0].customer_code, row.costing_id],
      );
      await writeAuditEvent(
        {
          action: "COSTING_UPDATED",
          entityType: "costing_headers",
          entityId: row.costing_id,
          actorUserId,
          actorRole: "super_admin",
          requestId: `script-backfill-costing-customer-ids-${Date.now()}`,
          beforeJson: { customerId: null },
          afterJson: { customerId: custRows[0].customer_id, bulkBackfill: true },
          changedFields: ["customerId"],
        },
        client,
      );
    });
    console.log(`  LINKED ${row.costing_id} -> "${row.customer_name_snapshot}" (${custRows[0].customer_id})`);
    linked++;
  }

  console.log(`\nDone. Linked ${linked}, skipped ${noMatch} (no matching active customer).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
