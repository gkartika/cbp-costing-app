import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { exportTableXlsx } from "@/lib/masterdata/exportTable";
import { TAB_SPECS } from "@/lib/guide/importSchema";

export const GET = apiHandler(async (_req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);
  const { table } = await ctx.params;

  const buffer = await exportTableXlsx(table);
  const tabName = TAB_SPECS.find((s) => s.table === table)?.tabName ?? table;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${tabName}.xlsx"`,
    },
  });
});
