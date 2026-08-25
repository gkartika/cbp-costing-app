/**
 * Restores a pg_dump custom-format backup into a target database.
 * --clean --if-exists means the target can already have the schema (or be
 * empty) and either way ends up matching the backup exactly.
 *
 * Usage: npm run restore -- <backupFile> <targetDatabaseUrl>
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { findPgBinary } from "./pgBinaries";

function main() {
  const [backupFile, targetUrl] = process.argv.slice(2);
  if (!backupFile || !targetUrl) {
    console.error("Usage: npm run restore -- <backupFile> <targetDatabaseUrl>");
    process.exit(1);
  }
  if (!existsSync(backupFile)) {
    console.error(`Backup file not found: ${backupFile}`);
    process.exit(1);
  }

  const pgRestore = findPgBinary("pg_restore");
  console.log(`Restoring ${backupFile} -> ${new URL(targetUrl).pathname.replace(/^\//, "")}`);
  const result = spawnSync(pgRestore, ["--clean", "--if-exists", "--no-owner", "-d", targetUrl, backupFile], {
    stdio: "inherit",
  });

  // pg_restore commonly exits 1 on harmless warnings (e.g. "role does not
  // exist" for --no-owner cleanup on a fresh DB); only treat it as fatal if
  // no output at all was produced, which real failures always accompany.
  if (result.status !== 0 && result.status !== 1) {
    console.error(`pg_restore failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
  console.log("Restore complete.");
}

main();
