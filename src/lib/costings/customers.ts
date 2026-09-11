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

export type BulkImportRow = {
  customerName: string;
  customerCode?: string | null;
  segment?: CustomerSegment | null;
  /** Fraction like the rest of the calc engine (0.05 = +5%), not a whole percent. */
  markupPercent?: number | null;
  paymentTerms?: string | null;
};

export type BulkImportOutcome = {
  row: number;
  customerName: string;
  outcome: "created" | "updated" | "error";
  message?: string;
};

/**
 * Loads a customer masterlist in one pass, upserting by exact name — a new
 * name creates a row, an existing active name is updated with whatever
 * fields this row supplies. A blank field in the row leaves the existing
 * value alone rather than clobbering it with null, so the same file can be
 * re-run later (e.g. to add newly-onboarded customers) without disturbing
 * ones already classified by hand. Super Admin only (policy.assertCanEditCustomer),
 * same as single-record editing, since a row can carry segment/markup/terms.
 */
export async function bulkImportCustomers(
  rows: BulkImportRow[],
  actor: { actorUserId: string; actorRole: string; requestId: string },
): Promise<BulkImportOutcome[]> {
  const results: BulkImportOutcome[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNo = i + 1;
    const name = row.customerName?.trim();
    if (!name) {
      results.push({ row: rowNo, customerName: row.customerName ?? "", outcome: "error", message: "Nama customer wajib diisi." });
      continue;
    }

    try {
      const outcome = await withTransaction(async (client) => {
        const existing = await client.query<CustomerRow>(
          `SELECT * FROM customers WHERE customer_name = $1 AND active = TRUE FOR UPDATE`,
          [name],
        );

        if (existing.rows.length > 0) {
          const before = existing.rows[0];
          const setClauses: string[] = [];
          const values: unknown[] = [];
          const changed: string[] = [];
          const maybeSet = (column: string, key: string, value: unknown) => {
            if (value === undefined || value === null || value === "") return;
            changed.push(key);
            values.push(value);
            setClauses.push(`${column} = $${values.length}`);
          };
          maybeSet("customer_code", "customerCode", row.customerCode?.trim());
          maybeSet("segment", "segment", row.segment);
          maybeSet("markup_percent", "markupPercent", row.markupPercent);
          maybeSet("payment_terms", "paymentTerms", row.paymentTerms?.trim());
          if (setClauses.length === 0) return "updated" as const;

          values.push(before.customer_id);
          await client.query(
            `UPDATE customers SET ${setClauses.join(", ")}, updated_at = now() WHERE customer_id = $${values.length}`,
            values,
          );
          await writeAuditEvent(
            {
              action: "CUSTOMER_UPDATED",
              entityType: "customers",
              entityId: before.customer_id,
              actorUserId: actor.actorUserId,
              actorRole: actor.actorRole,
              requestId: actor.requestId,
              changedFields: changed,
              afterJson: { ...row, bulkImport: true },
            },
            client,
          );
          return "updated" as const;
        }

        const customerId = generateId("cust");
        await client.query(
          `INSERT INTO customers (customer_id, customer_name, customer_code, segment, markup_percent, payment_terms, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            customerId,
            name,
            row.customerCode?.trim() || null,
            row.segment || null,
            row.markupPercent ?? null,
            row.paymentTerms?.trim() || null,
            actor.actorUserId,
          ],
        );
        await writeAuditEvent(
          {
            action: "CUSTOMER_CREATED",
            entityType: "customers",
            entityId: customerId,
            actorUserId: actor.actorUserId,
            actorRole: actor.actorRole,
            requestId: actor.requestId,
            afterJson: { ...row, customerName: name, bulkImport: true },
          },
          client,
        );
        return "created" as const;
      });

      results.push({ row: rowNo, customerName: name, outcome });
    } catch (e) {
      results.push({ row: rowNo, customerName: name, outcome: "error", message: e instanceof Error ? e.message : "Gagal menyimpan." });
    }
  }

  return results;
}

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
