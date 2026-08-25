/**
 * Creates a non-Super-Admin account (costing_user or auditor) from the command
 * line. The app's own Super Admin > Users screen is the normal way to do this;
 * this script exists for local/dev setup and for seeding a pilot's first
 * regular users without clicking through the UI.
 *
 * Usage:
 *   npm run seed:user -- --username=budi --password=... --displayName="Budi" --role=costing_user
 */
import { pool } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { generateId } from "../src/lib/ids";

const ALLOWED_ROLES = ["costing_user", "auditor"] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((a) => a.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function main() {
  const username = arg("username");
  const password = arg("password");
  const displayName = arg("displayName") ?? username;
  const role = (arg("role") ?? "costing_user") as AllowedRole;

  if (!username || !password) {
    console.error("Usage: npm run seed:user -- --username=<u> --password=<p> [--displayName=<name>] [--role=costing_user|auditor]");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }
  // super_admin is deliberately not creatable here: privilege escalation should
  // go through seed:admin (bootstrap) or an existing Super Admin in the app.
  if (!ALLOWED_ROLES.includes(role)) {
    console.error(`--role must be one of: ${ALLOWED_ROLES.join(", ")}`);
    process.exit(1);
  }

  const existing = await pool.query("SELECT user_id FROM users WHERE username = $1", [username]);
  if (existing.rows.length > 0) {
    console.log(`User "${username}" already exists — skipping.`);
    await pool.end();
    return;
  }

  const roleRow = await pool.query<{ role_id: string }>("SELECT role_id FROM roles WHERE role_name = $1", [role]);
  if (roleRow.rows.length === 0) {
    console.error(`${role} role not found — run migrations first.`);
    process.exit(1);
  }

  const userId = generateId("usr");
  const passwordHash = await hashPassword(password);
  await pool.query(`INSERT INTO users (user_id, username, password_hash, display_name) VALUES ($1, $2, $3, $4)`, [
    userId,
    username,
    passwordHash,
    displayName,
  ]);
  await pool.query(`INSERT INTO user_roles (user_role_id, user_id, role_id) VALUES ($1, $2, $3)`, [
    generateId("urole"),
    userId,
    roleRow.rows[0].role_id,
  ]);

  console.log(`Created ${role} "${username}" (${userId}).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
