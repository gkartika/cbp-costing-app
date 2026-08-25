import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { Errors } from "@/lib/errors";

const CreateQuoteSchema = z.object({
  quotedPrice: z.number().positive(),
  taxBasis: z.enum(["INCLUDE_PPN", "EXCLUDE_PPN"]),
  ppnRate: z.number().min(0).optional(),
  landedCostConfirmed: z.boolean(),
});

/**
 * Every submission creates a new trading_quotes row rather than mutating one
 * in place — a full history of what the owner tried survives even though
 * the line only ever points at the latest quote (AUD-010).
 */
export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  const requestId = getRequestId(req);
  const { id, lineId } = await ctx.params;

  const header = await loadCostingHeader(id);
  policy.assertCanEditCosting(user, { ownerUserId: header.owner_user_id, status: header.status });

  const body = CreateQuoteSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Data quote tidak valid.");

  if (body.data.taxBasis === "INCLUDE_PPN" && body.data.ppnRate === undefined) {
    throw Errors.ppnRateRequired();
  }
  if (!body.data.landedCostConfirmed) {
    throw Errors.landedCostConfirmationRequired();
  }

  const lineCheck = await pool.query(
    `SELECT 1 FROM costing_lines WHERE costing_id = $1 AND costing_line_id = $2 AND deleted_at IS NULL`,
    [id, lineId],
  );
  if (lineCheck.rows.length === 0) throw Errors.notFound("Line");

  const quoteId = await withTransaction(async (client) => {
    const newQuoteId = generateId("tq");
    await client.query(
      `INSERT INTO trading_quotes (trading_quote_id, costing_line_id, quoted_price, tax_basis, ppn_rate, landed_cost_confirmed, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newQuoteId, lineId, body.data.quotedPrice, body.data.taxBasis, body.data.ppnRate ?? null, body.data.landedCostConfirmed, user.userId],
    );
    await client.query(`UPDATE costing_lines SET trading_quote_id = $1, updated_at = now() WHERE costing_line_id = $2`, [
      newQuoteId,
      lineId,
    ]);
    if (header.status === "calculated") {
      await client.query(`UPDATE costing_headers SET status = 'draft', updated_at = now() WHERE costing_id = $1`, [id]);
    }
    await writeAuditEvent(
      {
        action: "TRADING_QUOTE_CREATED",
        entityType: "trading_quotes",
        entityId: newQuoteId,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        afterJson: body.data,
      },
      client,
    );
    return newQuoteId;
  });

  return NextResponse.json({ tradingQuoteId: quoteId }, { status: 201 });
});
