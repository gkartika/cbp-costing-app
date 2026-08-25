import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { buildQuotationDocument } from "@/lib/costings/quotationDocument";

/**
 * Read-only preview data for the in-Workspace Preview panel — works at any
 * status (Draft through Finalized) and is never audited (AUD-016: ordinary
 * screen views are not logged). The actual downloadable file comes from
 * POST /export, which is Finalized-only and is audited.
 */
export const GET = apiHandler(async (_req, ctx) => {
  const user = await requireUser();
  policy.canViewCosting(user);
  const { id } = await ctx.params;

  const header = await loadCostingHeader(id);
  const document = await buildQuotationDocument(header);
  return NextResponse.json({ document });
});
