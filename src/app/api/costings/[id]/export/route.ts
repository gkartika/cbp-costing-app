import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { buildQuotationDocument } from "@/lib/costings/quotationDocument";
import { generateQuotationXlsx } from "@/lib/quotation/generateQuotationXlsx";
import { Errors } from "@/lib/errors";

const TEMPLATE_VERSION = "phase4-placeholder-v1"; // DEC-016 open — real CBP template swaps this in later.

/**
 * DEC-015/VAL-030: only Finalized/Revised quotations export, output always
 * excludes PPN. Unlike the read-only Preview, this is a real
 * download/artifact and is always audited (AUD-016).
 */
export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.canViewCosting(user);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const header = await loadCostingHeader(id);
  if (header.status !== "finalized" && header.status !== "revised") {
    throw Errors.quotationNotFinal();
  }

  const document = await buildQuotationDocument(header);
  const fileBuffer = await generateQuotationXlsx(document);
  const checksum = createHash("sha256").update(fileBuffer).digest("hex");

  await withTransaction(async (client) => {
    const exportId = generateId("exp");
    await client.query(
      `INSERT INTO quotation_exports (export_id, costing_id, generated_by, file_checksum, template_version, format)
       VALUES ($1, $2, $3, $4, $5, 'xlsx')`,
      [exportId, id, user.userId, checksum, TEMPLATE_VERSION],
    );
    await writeAuditEvent(
      {
        action: "QUOTATION_EXPORTED",
        entityType: "quotation_exports",
        entityId: exportId,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        afterJson: { costingId: id, checksum, templateVersion: TEMPLATE_VERSION },
      },
      client,
    );
  });

  const filename = `${header.quotation_no ?? id}.xlsx`;
  return new NextResponse(new Uint8Array(fileBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Checksum-SHA256": checksum,
    },
  });
});
