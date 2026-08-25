import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { TAB_SPECS } from "@/lib/guide/importSchema";

/** Table + column metadata for the Master Data admin UI to render generic browse/edit forms from — no per-table bespoke UI needed. */
export const GET = apiHandler(async () => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);

  return NextResponse.json({
    tables: TAB_SPECS.map((spec) => ({
      table: spec.table,
      tabName: spec.tabName,
      keyHeader: spec.keyHeader,
      uniqueBusinessKey: spec.uniqueBusinessKey ?? null,
      columns: spec.columns.map((c) => ({
        header: c.header,
        dbColumn: c.dbColumn,
        type: c.type,
        required: c.required,
        refTab: c.type === "reference" ? c.refTab : undefined,
      })),
    })),
  });
});
