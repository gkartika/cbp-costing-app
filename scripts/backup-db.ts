/**
 * Backs up the database at DATABASE_URL to a timestamped pg_dump custom-format
 * file under backups/. Custom format (-Fc) supports pg_restore's --clean,
 * --if-exists and parallel restore, unlike plain SQL dumps.
 *
 * Usage: npm run backup -- [outputDir]
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { findPgBinary } from "./pgBinaries";

function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const outDir = process.argv[2] ?? path.join(process.cwd(), "backups");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const dbName = new URL(databaseUrl).pathname.replace(/^\//, "");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(outDir, `${dbName}_${timestamp}.backup`);

  const pgDump = findPgBinary("pg_dump");
  console.log(`Backing up ${dbName} -> ${outFile}`);
  const result = spawnSync(pgDump, ["-Fc", "-f", outFile, databaseUrl], { stdio: "inherit" });

  if (result.status !== 0) {
    console.error(`pg_dump failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
  console.log(`Backup complete: ${outFile}`);
}

main();
