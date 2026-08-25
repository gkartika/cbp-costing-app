import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool } from "@/lib/db";
import { loadCostingHeader } from "@/lib/costings/loadCosting";

/**
 * 09_API_CONTRACTS: same read visibility as the costing itself (all costing
 * users, per DEC-018) — audit is evidence for a record everyone can already
 * see, not a separately-gated resource. Pulls every entity type that can
 * legitimately be evidence for one costing: the header, its lines, any
 * trading quotes on those lines, and any exports.
 */
export const GET = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.canViewCosting(user);
  policy.assertCanViewAudit(user);
  const { id } = await ctx.params;
  await loadCostingHeader(id);

  const { rows } = await pool.query<{
    audit_event_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before_json: unknown;
    after_json: unknown;
    changed_fields: unknown;
    reason: string | null;
    actor_user_id: string | null;
    actor_role: string;
    occurred_at: Date;
    request_id: string;
    actor_display_name: string | null;
  }>(
    `SELECT ae.audit_event_id, ae.action, ae.entity_type, ae.entity_id, ae.before_json, ae.after_json,
            ae.changed_fields, ae.reason, ae.actor_user_id, ae.actor_role, ae.occurred_at, ae.request_id,
            u.display_name AS actor_display_name
     FROM audit_events ae
     LEFT JOIN users u ON u.user_id = ae.actor_user_id
     WHERE (ae.entity_type = 'costing_headers' AND ae.entity_id = $1)
        OR (ae.entity_type = 'costing_lines' AND ae.entity_id IN (
              SELECT costing_line_id FROM costing_lines WHERE costing_id = $1))
        OR (ae.entity_type = 'trading_quotes' AND ae.entity_id IN (
              SELECT trading_quote_id FROM trading_quotes WHERE costing_line_id IN (
                SELECT costing_line_id FROM costing_lines WHERE costing_id = $1)))
        OR (ae.entity_type = 'quotation_exports' AND ae.entity_id IN (
              SELECT export_id FROM quotation_exports WHERE costing_id = $1))
     ORDER BY ae.occurred_at DESC
     LIMIT 500`,
    [id],
  );

  return NextResponse.json({
    events: rows.map((r) => ({
      auditEventId: r.audit_event_id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      beforeJson: r.before_json,
      afterJson: r.after_json,
      changedFields: r.changed_fields,
      reason: r.reason,
      actorUserId: r.actor_user_id,
      actorDisplayName: r.actor_display_name,
      actorRole: r.actor_role,
      occurredAt: r.occurred_at,
      requestId: r.request_id,
    })),
  });
});
