import { writeFileSync } from "fs";
import { buildGuidePackageXlsx } from "../tests/fixtures/buildGuidePackageXlsx";

async function main() {
  const versionCode = process.argv[2] ?? `manual-test-${Date.now()}`;
  const buffer = await buildGuidePackageXlsx({ versionCode });
  const outPath = process.argv[3] ?? "scratch-guide-package.xlsx";
  writeFileSync(outPath, buffer);
  console.log(`Wrote ${outPath} (version ${versionCode})`);
}

main();
