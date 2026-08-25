import type { PoolClient } from "pg";
import { pool } from "@/lib/db";
import { generateId } from "@/lib/ids";

export type AuditEventInput = {
  action: string;
  entityType: string;
  entityId: string;
  actorUserId: string | null;
  actorRole: string;
  requestId: string;
  beforeJson?: unknown;
  afterJson?: unknown;
  changedFields?: string[];
  reason?: string;
};

/**
 * Appends one audit_events row. Accepts an optional transaction client so the
 * audit write commits atomically with the domain mutation it documents
 * (08_AUDIT_TRAIL) — a mutation must never succeed without its audit event,
 * or vice versa.
 */
export async function writeAuditEvent(
  input: AuditEventInput,
  client?: Pick<PoolClient, "query">,
): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO audit_events
       (audit_event_id, action, entity_type, entity_id, before_json, after_json,
        changed_fields, reason, actor_user_id, actor_role, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      generateId("evt"),
      input.action,
      input.entityType,
      input.entityId,
      input.beforeJson ? JSON.stringify(input.beforeJson) : null,
      input.afterJson ? JSON.stringify(input.afterJson) : null,
      input.changedFields ? JSON.stringify(input.changedFields) : null,
      input.reason ?? null,
      input.actorUserId,
      input.actorRole,
      input.requestId,
    ],
  );
}
