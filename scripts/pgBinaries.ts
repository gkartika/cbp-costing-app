import { existsSync } from "fs";
import { spawnSync } from "child_process";

/**
 * Locates a PostgreSQL client binary (pg_dump/pg_restore/psql). Prefers PATH;
 * falls back to the standard Windows install location since this project's
 * local Postgres was installed via winget without adding bin/ to PATH.
 */
export function findPgBinary(name: "pg_dump" | "pg_restore" | "psql"): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", [exe]);
  if (onPath.status === 0) {
    return exe; // resolvable via PATH as-is
  }
  const windowsDefault = `C:\\Program Files\\PostgreSQL\\16\\bin\\${exe}`;
  if (existsSync(windowsDefault)) return windowsDefault;
  throw new Error(`Could not locate ${exe} on PATH or at ${windowsDefault}`);
}
