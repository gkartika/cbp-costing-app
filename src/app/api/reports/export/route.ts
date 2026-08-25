import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser, getRequestId, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { buildReport } from "@/lib/reports/buildReport";
import { generateReportXlsx } from "@/lib/reports/generateReportXlsx";
import { parseFilters } from "../route";

export const GET = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  policy.canViewCosting(user);
  const requestId = getRequestId(req);

  const filters = parseFilters(req);
  const result = await buildReport(filters);
  const fileBuffer = await generateReportXlsx(result, filters);
  const checksum = createHash("sha256").update(fileBuffer).digest("hex");

  // Unlike the quotation-summary preview, an exported report leaves the
  // building, so it is audited: what was pulled, by whom, over which filters.
  await writeAuditEvent({
    action: "REPORT_EXPORTED",
    entityType: "reports",
    entityId: checksum.slice(0, 26),
    actorUserId: user.userId,
    actorRole: primaryAuditRole(user),
    requestId,
    afterJson: { filters, costingCount: result.totals.costingCount, checksum },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `CBP-Report-${stamp}.xlsx`;

  return new NextResponse(new Uint8Array(fileBuffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Checksum-SHA256": checksum,
    },
  });
});
