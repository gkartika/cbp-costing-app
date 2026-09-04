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
import { generateQuotationPdf } from "@/lib/quotation/generateQuotationPdf";
import { Errors } from "@/lib/errors";

const TEMPLATE_VERSION = "phase4-placeholder-v1"; // DEC-016 open — real CBP template swaps this in later.

const FORMATS = {
  xlsx: {
    generate: generateQuotationXlsx,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  },
  pdf: {
    generate: generateQuotationPdf,
    contentType: "application/pdf",
    extension: "pdf",
  },
} as const;

/**
 * DEC-015/VAL-030: only Finalized/Revised quotations export, output always
 * excludes PPN. Unlike the read-only Preview, this is a real
 * download/artifact and is always audited (AUD-016). `?format=pdf` for the
 * letterhead PDF, otherwise XLSX (unchanged default so existing callers of
 * this route are unaffected).
 */
export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.canViewCosting(user);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const formatParam = req.nextUrl.searchParams.get("format") ?? "xlsx";
  if (formatParam !== "xlsx" && formatParam !== "pdf") {
    throw Errors.validation("Format export tidak dikenal.");
  }
  const format = FORMATS[formatParam];

  const header = await loadCostingHeader(id);
  if (header.status !== "finalized" && header.status !== "revised") {
    throw Errors.quotationNotFinal();
  }

  const document = await buildQuotationDocument(header);
  const fileBuffer = await format.generate(document);
  const checksum = createHash("sha256").update(fileBuffer).digest("hex");

  await withTransaction(async (client) => {
    const exportId = generateId("exp");
    await client.query(
      `INSERT INTO quotation_exports (export_id, costing_id, generated_by, file_checksum, template_version, format)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [exportId, id, user.userId, checksum, TEMPLATE_VERSION, formatParam],
    );
    await writeAuditEvent(
      {
        action: "QUOTATION_EXPORTED",
        entityType: "quotation_exports",
        entityId: exportId,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        afterJson: { costingId: id, checksum, templateVersion: TEMPLATE_VERSION, format: formatParam },
      },
      client,
    );
  });

  const filename = `${header.quotation_no ?? id}.${format.extension}`;
  return new NextResponse(new Uint8Array(fileBuffer), {
    status: 200,
    headers: {
      "Content-Type": format.contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Checksum-SHA256": checksum,
    },
  });
});
