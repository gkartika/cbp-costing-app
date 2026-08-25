import type { PoolClient } from "pg";
import { generateId } from "@/lib/ids";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";

/**
 * Resolves a customer by exact name, creating one inline if it doesn't exist yet.
 * Phase 1 has no imported Customer Masterlist (none exists in the source data),
 * so Costing Users build the list organically as they create quotations.
 */
export async function resolveOrCreateCustomer(
  client: Pick<PoolClient, "query">,
  params: { customerName: string; customerCode?: string | null; actorUserId: string; actorRole: string; requestId: string },
): Promise<{ customerId: string; customerName: string; customerCode: string | null }> {
  const existing = await client.query<{ customer_id: string; customer_name: string; customer_code: string | null }>(
    `SELECT customer_id, customer_name, customer_code FROM customers WHERE customer_name = $1 AND active = TRUE`,
    [params.customerName],
  );
  if (existing.rows.length > 0) {
    return {
      customerId: existing.rows[0].customer_id,
      customerName: existing.rows[0].customer_name,
      customerCode: existing.rows[0].customer_code,
    };
  }

  const customerId = generateId("cust");
  await client.query(
    `INSERT INTO customers (customer_id, customer_name, customer_code, created_by)
     VALUES ($1, $2, $3, $4)`,
    [customerId, params.customerName, params.customerCode ?? null, params.actorUserId],
  );
  await writeAuditEvent(
    {
      action: "CUSTOMER_CREATED",
      entityType: "customers",
      entityId: customerId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      requestId: params.requestId,
      afterJson: { customerName: params.customerName, customerCode: params.customerCode ?? null },
    },
    client,
  );
  return { customerId, customerName: params.customerName, customerCode: params.customerCode ?? null };
}
