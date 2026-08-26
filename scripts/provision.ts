/**
 * Stands up a fresh environment: migrations, the first Super Admin, then a
 * readiness check. Reads DATABASE_URL from the environment so the same script
 * serves staging and production without editing anything.
 *
 * Guarded rather than idempotent: it refuses to run against a database that
 * already holds users or costings. Provisioning is a one-time act, and the
 * failure mode of re-running it against live data (a second "first" admin
 * account nobody expected) is the kind that is discovered late.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run provision -- \
 *     --username=admin --password='...' --displayName='CBP Admin'
 *
 *   Add --force only to re-run against a database you know is disposable.
 */
import { spawnSync } from "child_process";
import { pool } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { generateId } from "../src/lib/ids";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}
const has = (flag: string) => process.argv.includes(`--${flag}`);

function step(n: number, label: string) {
  console.log(`\n[${n}/4] ${label}`);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const username = arg("username");
  const password = arg("password");
  const displayName = arg("displayName") ?? username;
  if (!username || !password) {
    console.error("Usage: npm run provision -- --username=<u> --password=<p> [--displayName=<name>] [--force]");
    process.exit(1);
  }
  if (password.length < 12) {
    // Longer than the 8 the seed scripts accept: this account administers
    // every price in the system and is created once, so there is no
    // convenience argument for a weak one.
    console.error("Provisioning password must be at least 12 characters.");
    process.exit(1);
  }

  console.log(`Target database: ${new URL(databaseUrl).pathname.replace(/^\//, "")} @ ${new URL(databaseUrl).host}`);

  step(1, "Checking the database is fresh");
  const existing = await pool.query<{ users: string; costings: string }>(
    `SELECT
       (SELECT count(*) FROM users) AS users,
       (SELECT count(*) FROM costing_headers) AS costings`,
  ).catch(() => null);
  if (existing) {
    const users = Number(existing.rows[0].users);
    const costings = Number(existing.rows[0].costings);
    if ((users > 0 || costings > 0) && !has("force")) {
      console.error(
        `\nRefusing to provision: database already has ${users} user(s) and ${costings} costing(s).\n` +
          `This looks like a live environment. Re-run with --force only if it is disposable.`,
      );
      process.exit(1);
    }
    console.log(`  existing users=${users} costings=${costings}${has("force") ? " (--force given)" : ""}`);
  } else {
    console.log("  no schema yet — first run");
  }

  step(2, "Applying migrations");
  const migrate = spawnSync("npx", ["node-pg-migrate", "-j", "sql", "up"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (migrate.status !== 0) {
    console.error("Migrations failed — stopping before any account is created.");
    process.exit(1);
  }

  step(3, "Creating the first Super Admin");
  const dup = await pool.query(`SELECT 1 FROM users WHERE username = $1`, [username]);
  if (dup.rows.length > 0) {
    console.log(`  user "${username}" already exists — leaving it untouched`);
  } else {
    const roleRow = await pool.query<{ role_id: string }>(`SELECT role_id FROM roles WHERE role_name = 'super_admin'`);
    if (roleRow.rows.length === 0) throw new Error("super_admin role missing — migrations did not seed roles");
    const userId = generateId("usr");
    await pool.query(
      `INSERT INTO users (user_id, username, password_hash, display_name) VALUES ($1, $2, $3, $4)`,
      [userId, username, await hashPassword(password), displayName],
    );
    await pool.query(`INSERT INTO user_roles (user_role_id, user_id, role_id) VALUES ($1, $2, $3)`, [
      generateId("urole"),
      userId,
      roleRow.rows[0].role_id,
    ]);
    console.log(`  created super_admin "${username}" (${userId})`);
  }

  step(4, "Readiness check");
  const published = await pool.query<{ version_code: string }>(
    `SELECT version_code FROM guide_versions WHERE status = 'published' LIMIT 1`,
  );
  if (published.rows.length === 0) {
    console.log("  NO published guide version — the app cannot price anything yet.");
    console.log("  Next: export from the source environment (npm run export:guide),");
    console.log("        then import it in Guide Admin and publish. Validation runs on import.");
  } else {
    console.log(`  published guide version: ${published.rows[0].version_code}`);
    const sims = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM simulation_cases WHERE active
        AND guide_version_id = (SELECT guide_version_id FROM guide_versions WHERE status = 'published' LIMIT 1)`,
    );
    console.log(`  golden simulation cases available: ${sims.rows[0].n}`);
  }

  console.log("\nProvisioning complete. See docs/GO-LIVE.md for the cutover checklist.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
