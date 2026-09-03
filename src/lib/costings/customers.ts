import type { PoolClient } from "pg";
import { pool, withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { Errors } from "@/lib/errors";

export const CUSTOMER_SEGMENTS = ["Distributor", "Fabricator", "Subcontractor", "End User"] as const;
export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];

export type CustomerRow = {
  customer_id: string;
  customer_name: string;
  customer_code: string | null;
  segment: CustomerSegment | null;
  markup_percent: string | null;
  payment_terms: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

export function serializeCustomer(row: CustomerRow) {
  return {
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerCode: row.customer_code,
    segment: row.segment,
    markupPercent: row.markup_percent !== null ? Number(row.markup_percent) : null,
    paymentTerms: row.payment_terms,
    active: row.active,
  };
}

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

/**
 * Explicit "+ Add Customer" action from the Customers page — open to any
 * authenticated user (business decision 2026-09-04), same low bar as the
 * inline create-by-name flow above. Deliberately narrow: only identity
 * (name, code). Segment, markup and payment terms are commercial decisions
 * and are set afterward via updateCustomer, which is Super Admin only.
 */
export async function createCustomer(params: {
  customerName: string;
  customerCode?: string | null;
  actorUserId: string;
  actorRole: string;
  requestId: string;
}): Promise<CustomerRow> {
  const name = params.customerName.trim();
  if (!name) throw Errors.validation("Nama customer wajib diisi.");

  return withTransaction(async (client) => {
    const dup = await client.query(`SELECT 1 FROM customers WHERE customer_name = $1 AND active = TRUE`, [name]);
    if (dup.rows.length > 0) throw Errors.validation("Customer dengan nama ini sudah ada.");

    const customerId = generateId("cust");
    const { rows } = await client.query<CustomerRow>(
      `INSERT INTO customers (customer_id, customer_name, customer_code, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [customerId, name, params.customerCode?.trim() || null, params.actorUserId],
    );
    await writeAuditEvent(
      {
        action: "CUSTOMER_CREATED",
        entityType: "customers",
        entityId: customerId,
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        requestId: params.requestId,
        afterJson: { customerName: name, customerCode: params.customerCode ?? null },
      },
      client,
    );
    return rows[0];
  });
}

const EDITABLE_FIELDS: Record<string, string> = {
  customerName: "customer_name",
  customerCode: "customer_code",
  segment: "segment",
  markupPercent: "markup_percent",
  paymentTerms: "payment_terms",
};

/** Super Admin only (policy.assertCanEditCustomer) — every field on an existing customer record. */
export async function updateCustomer(
  customerId: string,
  fields: Partial<Record<keyof typeof EDITABLE_FIELDS, unknown>>,
  actor: { actorUserId: string; actorRole: string; requestId: string },
): Promise<CustomerRow> {
  const before = await pool.query<CustomerRow>(`SELECT * FROM customers WHERE customer_id = $1 AND active = TRUE`, [
    customerId,
  ]);
  if (before.rows.length === 0) throw Errors.notFound("Customer");

  const setClauses: string[] = [];
  const values: unknown[] = [];
  const changed: string[] = [];
  for (const [key, column] of Object.entries(EDITABLE_FIELDS)) {
    if (!(key in fields)) continue;
    changed.push(key);
    values.push(fields[key as keyof typeof fields]);
    setClauses.push(`${column} = $${values.length}`);
  }
  if (setClauses.length === 0) return before.rows[0];

  return withTransaction(async (client) => {
    values.push(customerId);
    const { rows } = await client.query<CustomerRow>(
      `UPDATE customers SET ${setClauses.join(", ")}, updated_at = now() WHERE customer_id = $${values.length} RETURNING *`,
      values,
    );
    await writeAuditEvent(
      {
        action: "CUSTOMER_UPDATED",
        entityType: "customers",
        entityId: customerId,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        requestId: actor.requestId,
        beforeJson: Object.fromEntries(changed.map((k) => [k, (before.rows[0] as unknown as Record<string, unknown>)[EDITABLE_FIELDS[k]]])),
        afterJson: Object.fromEntries(changed.map((k) => [k, fields[k as keyof typeof fields]])),
        changedFields: changed,
      },
      client,
    );
    return rows[0];
  });
}
