import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { buildReport, REPORTABLE_STATUSES, type ReportFilters } from "@/lib/reports/buildReport";

/** Parses the shared filter set out of the query string for both this route and the export. */
export function parseFilters(req: NextRequest): ReportFilters {
  const p = req.nextUrl.searchParams;
  const statuses = p.getAll("status").filter((s) => (REPORTABLE_STATUSES as readonly string[]).includes(s));
  const poFilter = p.get("po");
  return {
    customer: p.get("customer") ?? undefined,
    salesperson: p.get("salesperson") ?? undefined,
    dateFrom: p.get("from") ?? undefined,
    dateTo: p.get("to") ?? undefined,
    statuses,
    poFilter: poFilter === "po" || poFilter === "no_po" ? poFilter : "all",
  };
}

/**
 * Reporting is read-only over costings the user can already see (DEC-003:
 * every authenticated user reads every costing), so it needs no ownership
 * filter — only the same authentication gate as the dashboard.
 */
export const GET = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  policy.canViewCosting(user);

  const result = await buildReport(parseFilters(req));
  return NextResponse.json(result);
});
