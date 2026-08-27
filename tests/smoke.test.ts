import { describe, it, expect } from "vitest";
import { createUser, login, apiFetch, BASE_URL } from "./helpers";

const PASSWORD = "correct horse battery staple";

describe("App starts and serves requests (Phase 1 exit criteria)", () => {
  it("serves the login page", async () => {
    const res = await fetch(`${BASE_URL}/login`);
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated API access", async () => {
    const { status, json } = await apiFetch("/api/me");
    expect(status).toBe(401);
    expect((json.error as { code: string }).code).toBe("AUTH_REQUIRED");
  });

  it("logs in and reports the authenticated user's roles", async () => {
    await createUser({ username: "smoke_user_001", password: PASSWORD, roles: ["costing_user", "auditor"] });
    const { status, cookie } = await login("smoke_user_001", PASSWORD);
    expect(status).toBe(200);

    const me = await apiFetch("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(me.json.username).toBe("smoke_user_001");
    expect(me.json.roles).toEqual(expect.arrayContaining(["costing_user", "auditor"]));
  });

  it("rejects an inactive account at login", async () => {
    await createUser({ username: "inactive_001", password: PASSWORD, roles: ["costing_user"], active: false });
    const { status, body } = await login("inactive_001", PASSWORD);
    expect(status).toBe(403);
    expect((body.error as { code: string }).code).toBe("ACCOUNT_INACTIVE");
  });

  it("rejects wrong password with a generic message", async () => {
    await createUser({ username: "wrongpw_001", password: PASSWORD, roles: ["costing_user"] });
    const { status, body } = await login("wrongpw_001", "not the right password");
    expect(status).toBe(401);
    expect((body.error as { code: string }).code).toBe("INVALID_CREDENTIALS");
  });
});

describe("Super Admin restrictions", () => {
  it("non-admin cannot list or create users", async () => {
    await createUser({ username: "plain_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("plain_user_001", PASSWORD);

    const list = await apiFetch("/api/admin/users", { cookie });
    expect(list.status).toBe(403);

    const create = await apiFetch("/api/admin/users", {
      method: "POST",
      cookie,
      body: { username: "hacker", displayName: "Hacker", roles: ["super_admin"] },
    });
    expect(create.status).toBe(403);
  });

  it("super_admin can create a user and the new user can log in", async () => {
    await createUser({ username: "admin_001", password: PASSWORD, roles: ["super_admin"] });
    const { cookie } = await login("admin_001", PASSWORD);

    const create = await apiFetch("/api/admin/users", {
      method: "POST",
      cookie,
      body: { username: "new_hire_001", displayName: "New Hire", roles: ["costing_user"] },
    });
    expect(create.status).toBe(201);
    const tempPassword = create.json.temporaryPassword as string;
    expect(tempPassword).toBeTruthy();

    const newLogin = await login("new_hire_001", tempPassword);
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.mustResetPassword).toBe(true);
  });

  it("a Super Admin can set the password directly, and it works immediately", async () => {
    await createUser({ username: "admin_002", password: PASSWORD, roles: ["super_admin"] });
    const { cookie } = await login("admin_002", PASSWORD);

    // Username and password is the whole form: display name defaults to the
    // username and the role to costing_user.
    const create = await apiFetch("/api/admin/users", {
      method: "POST",
      cookie,
      body: { username: "sari_001", password: "sari" },
    });
    expect(create.status).toBe(201);
    expect(create.json.displayName).toBe("sari_001");
    expect(create.json.roles).toEqual(["costing_user"]);
    // Nothing to echo back — the admin already has the password they chose.
    expect(create.json.temporaryPassword).toBeNull();

    const newLogin = await login("sari_001", "sari");
    expect(newLogin.status).toBe(200);
    // The point of setting a password is that it keeps working; a forced reset
    // would break it at first login.
    expect(newLogin.body.mustResetPassword).toBe(false);
  });

  it("rejects a duplicate username and a password under 4 characters", async () => {
    await createUser({ username: "admin_003", password: PASSWORD, roles: ["super_admin"] });
    const { cookie } = await login("admin_003", PASSWORD);

    const first = await apiFetch("/api/admin/users", {
      method: "POST",
      cookie,
      body: { username: "taken_001", password: "budi" },
    });
    expect(first.status).toBe(201);

    const dup = await apiFetch("/api/admin/users", {
      method: "POST",
      cookie,
      body: { username: "taken_001", password: "lain" },
    });
    expect(dup.status).toBe(400);

    const short = await apiFetch("/api/admin/users", {
      method: "POST",
      cookie,
      body: { username: "shorty_001", password: "ab" },
    });
    expect(short.status).toBe(400);
  });
});
