import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool } from "@/lib/db";
import { serializeCustomer, type CustomerRow } from "@/lib/costings/customers";

/**
 * Exports every active customer to a single-sheet .xlsx in exactly the shape
 * the Bulk Import (.xlsx) button reads back (same header row, same
 * matching-by-customerName semantics as the existing paste-CSV import) --
 * Export, edit in Excel, re-import round-trips without a translation step,
 * same pattern as Master Data's per-table Export/Bulk import.
 */
export const GET = apiHandler(async () => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);

  const { rows } = await pool.query<CustomerRow>(`SELECT * FROM customers WHERE active = TRUE ORDER BY customer_name`);
  const customers = rows.map(serializeCustomer);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "CBP Costing App";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Customers");
  sheet.addRow(["customerName", "customerCode", "segment", "markupPercent", "paymentTerms"]);
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((c) => {
    c.width = 24;
  });

  for (const c of customers) {
    sheet.addRow([
      c.customerName,
      c.customerCode,
      c.segment,
      // Stored as a fraction (0.05 = +5%); exported as a plain percent (5) to
      // match what the Bulk Import column already expects back.
      c.markupPercent !== null ? c.markupPercent * 100 : null,
      c.paymentTerms,
    ]);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="Customers.xlsx"`,
    },
  });
});
