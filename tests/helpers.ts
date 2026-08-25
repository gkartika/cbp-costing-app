import { pool } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { generateId } from "../src/lib/ids";
import { BASE_URL } from "./globalSetup";

export { BASE_URL };

export async function createUser(opts: {
  username: string;
  password: string;
  displayName?: string;
  roles: string[];
  active?: boolean;
}): Promise<string> {
  const userId = generateId("usr");
  const passwordHash = await hashPassword(opts.password);
  await pool.query(
    `INSERT INTO users (user_id, username, password_hash, display_name, active) VALUES ($1, $2, $3, $4, $5)`,
    [userId, opts.username, passwordHash, opts.displayName ?? opts.username, opts.active ?? true],
  );
  for (const roleName of opts.roles) {
    const { rows } = await pool.query<{ role_id: string }>(
      `SELECT role_id FROM roles WHERE role_name = $1`,
      [roleName],
    );
    if (rows.length === 0) throw new Error(`Unknown role: ${roleName}`);
    await pool.query(
      `INSERT INTO user_roles (user_role_id, user_id, role_id) VALUES ($1, $2, $3)`,
      [generateId("urole"), userId, rows[0].role_id],
    );
  }
  return userId;
}

type LoginResult = { cookie: string; status: number; body: Record<string, unknown> };

export async function login(username: string, password: string): Promise<LoginResult> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  return { cookie, status: res.status, body };
}

type ApiResult = { status: number; json: Record<string, unknown> };

export async function apiFetch(
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
