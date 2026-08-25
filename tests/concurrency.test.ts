import { describe, it, expect } from "vitest";
import { createUser, login, apiFetch } from "./helpers";

const PASSWORD = "correct horse battery staple";

describe("AT-CONCURRENCY-001: stale optimistic-lock write is rejected", () => {
  it("second save with an outdated expectedUpdatedAt gets 409 STALE_UPDATE; the first save wins", async () => {
    await createUser({ username: "owner_conc_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("owner_conc_001", PASSWORD);

    const created = await apiFetch("/api/costings", {
      method: "POST",
      cookie,
      body: { customerName: "PT Original" },
    });
    const costingId = created.json.costingId as string;
    const originalUpdatedAt = created.json.updatedAt as string;

    // First session saves successfully.
    const firstSave = await apiFetch(`/api/costings/${costingId}`, {
      method: "PATCH",
      cookie,
      body: { expectedUpdatedAt: originalUpdatedAt, customerName: "PT First Save" },
    });
    expect(firstSave.status).toBe(200);

    // Second session still holds the original (now stale) updatedAt.
    const secondSave = await apiFetch(`/api/costings/${costingId}`, {
      method: "PATCH",
      cookie,
      body: { expectedUpdatedAt: originalUpdatedAt, customerName: "PT Second Save" },
    });
    expect(secondSave.status).toBe(409);
    expect((secondSave.json.error as { code: string }).code).toBe("STALE_UPDATE");

    const current = await apiFetch(`/api/costings/${costingId}`, { cookie });
    expect(current.json.customerName).toBe("PT First Save");
  });
});
