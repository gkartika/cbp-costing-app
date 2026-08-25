import { pool } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";

export type AuthenticatedUser = {
  userId: string;
  username: string;
  displayName: string;
  active: boolean;
  mustResetPassword: boolean;
};

/**
 * Username/password authentication (DEC-013). This is the one place that
 * knows how credentials are checked; swapping to SSO later means replacing
 * only this function, not the session/authorization layers that depend on it.
 */
export async function authenticateWithPassword(
  username: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const { rows } = await pool.query<{
    user_id: string;
    username: string;
    password_hash: string;
    display_name: string;
    active: boolean;
    must_reset_password: boolean;
  }>(
    `SELECT user_id, username, password_hash, display_name, active, must_reset_password
     FROM users WHERE username = $1`,
    [username],
  );
  const user = rows[0];
  if (!user) {
    // Run a hash comparison anyway so the response time doesn't reveal whether the username exists.
    await verifyPassword(
      "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      password,
    );
    return null;
  }
  const valid = await verifyPassword(user.password_hash, password);
  if (!valid) return null;
  return {
    userId: user.user_id,
    username: user.username,
    displayName: user.display_name,
    active: user.active,
    mustResetPassword: user.must_reset_password,
  };
}

/** Active role names for a user, used at login time before a session (and therefore getSessionUser) exists. */
export async function getActiveRoleNames(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ role_name: string }>(
    `SELECT r.role_name FROM user_roles ur
     JOIN roles r ON r.role_id = ur.role_id
     WHERE ur.user_id = $1 AND ur.valid_to IS NULL`,
    [userId],
  );
  return rows.map((r) => r.role_name);
}
