import { describe, it, expect, beforeEach } from "vitest";
import { seedGuideVersion } from "./fixtures/seedGuideVersion";
import { createUser, login, apiFetch } from "./helpers";

const PASSWORD = "correct horse battery staple";

beforeEach(async () => {
  await seedGuideVersion(`ROLE-TEST-${Date.now()}`);
});

describe("AT-USER-001: Super Admin can change another user's role", () => {
  it("promotes a costing_user to costing_head", async () => {
    await createUser({ username: "role_admin_001", password: PASSWORD, roles: ["super_admin"] });
    const targetId = await createUser({ username: "role_target_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("role_admin_001", PASSWORD);

    const res = await apiFetch(`/api/admin/users/${targetId}/roles`, {
      method: "PATCH",
      cookie,
      body: { roles: ["costing_head"] },
    });
    expect(res.status).toBe(200);
    expect(res.json.roles).toEqual(["costing_head"]);

    const list = await apiFetch("/api/admin/users", { cookie });
    const target = (list.json.users as { userId: string; roles: string[] }[]).find((u) => u.userId === targetId);
    expect(target?.roles).toEqual(["costing_head"]);
  });

  it("a plain costing_user cannot change roles", async () => {
    const actorId = await createUser({ username: "role_002", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("role_002", PASSWORD);

    const res = await apiFetch(`/api/admin/users/${actorId}/roles`, {
      method: "PATCH",
      cookie,
      body: { roles: ["costing_head"] },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a Super Admin removing their own super_admin role", async () => {
    const actorId = await createUser({ username: "role_admin_002", password: PASSWORD, roles: ["super_admin"] });
    const { cookie } = await login("role_admin_002", PASSWORD);

    const res = await apiFetch(`/api/admin/users/${actorId}/roles`, {
      method: "PATCH",
      cookie,
      body: { roles: ["costing_user"] },
    });
    expect(res.status).toBe(400);
  });
});
