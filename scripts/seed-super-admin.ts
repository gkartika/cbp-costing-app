/**
 * Bootstraps the first Super Admin account. Needed because "Super Admin
 * creates users" (DEC-013) is otherwise a chicken-and-egg problem on a fresh
 * database with zero users.
 *
 * Usage:
 *   npm run seed:admin -- --username=admin --password=... --displayName="CBP Admin"
 */
import { pool } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { generateId } from "../src/lib/ids";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((a) => a.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function main() {
  const username = arg("username");
  const password = arg("password");
  const displayName = arg("displayName") ?? username;

  if (!username || !password) {
    console.error("Usage: npm run seed:admin -- --username=<u> --password=<p> [--displayName=<name>]");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const existing = await pool.query("SELECT user_id FROM users WHERE username = $1", [username]);
  if (existing.rows.length > 0) {
    console.log(`User "${username}" already exists — skipping.`);
    await pool.end();
    return;
  }

  const roleRow = await pool.query<{ role_id: string }>(
    "SELECT role_id FROM roles WHERE role_name = 'super_admin'",
  );
  if (roleRow.rows.length === 0) {
    console.error("super_admin role not found — run migrations first.");
    process.exit(1);
  }

  const userId = generateId("usr");
  const passwordHash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (user_id, username, password_hash, display_name) VALUES ($1, $2, $3, $4)`,
    [userId, username, passwordHash, displayName],
  );
  await pool.query(
    `INSERT INTO user_roles (user_role_id, user_id, role_id) VALUES ($1, $2, $3)`,
    [generateId("urole"), userId, roleRow.rows[0].role_id],
  );

  console.log(`Created super_admin "${username}" (${userId}).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
