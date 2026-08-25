import ExcelJS from "exceljs";

async function main() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Price_Per_Kg");
  ws.addRow([
    "price_id", "product_family", "product_type", "thread_condition", "grade_or_spec",
    "material", "unit_system", "size_label", "diameter_mm", "selling_price_per_kg", "currency", "active",
  ]);
  // Existing row (M14) -> should be detected as UPDATE. Price left exactly as-is
  // (70000) so this test doesn't also trip the golden regression case that
  // pins M14/A325's exact price — that behavior is already proven separately.
  ws.addRow(["PRICE-BOLT-A325-M14", "Bolt", "Hex Bolt", "HT", "A325", "SCM440", "Metric", "M14", 14, 70000, "IDR", true]);
  // New row (M18) -> should be detected as CREATE.
  ws.addRow(["PRICE-BOLT-A325-M18", "Bolt", "Hex Bolt", "HT", "A325", "SCM440", "Metric", "M18", 18, 70000, "IDR", true]);

  const outPath = process.argv[2] ?? "scratch-price-import.xlsx";
  await wb.xlsx.writeFile(outPath);
  console.log(`Wrote ${outPath}`);
}

main();
