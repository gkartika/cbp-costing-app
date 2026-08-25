import { randomBytes, createHash } from "crypto";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";

export const SESSION_COOKIE_NAME = "cbp_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export type SessionUser = {
  userId: string;
  username: string;
  displayName: string;
  active: boolean;
  roles: string[];
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Creates a session row and returns the raw token to be set as the session cookie.
 * The stored session_id is the SHA-256 hash of the token (not the token itself),
 * so a database read alone never yields a usable session credential.
 */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO sessions (session_id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(token), userId, expiresAt],
  );
  return { token, expiresAt };
}

export async function revokeSessionByToken(token: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}

async function loadSessionUser(token: string): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);
  const { rows } = await pool.query<{
    user_id: string;
    username: string;
    display_name: string;
    active: boolean;
    role_name: string | null;
  }>(
    `SELECT u.user_id, u.username, u.display_name, u.active, r.role_name
     FROM sessions s
     JOIN users u ON u.user_id = s.user_id
     LEFT JOIN user_roles ur ON ur.user_id = u.user_id AND ur.valid_to IS NULL
     LEFT JOIN roles r ON r.role_id = ur.role_id
     WHERE s.session_id = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()`,
    [tokenHash],
  );
  if (rows.length === 0) return null;
  const [first] = rows;
  return {
    userId: first.user_id,
    username: first.username,
    displayName: first.display_name,
    active: first.active,
    roles: rows.map((r) => r.role_name).filter((r): r is string => r !== null),
  };
}

/** Reads and validates the session cookie for the current request. Returns null when unauthenticated. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const user = await loadSessionUser(token);
  if (!user || !user.active) return null;
  return user;
}
