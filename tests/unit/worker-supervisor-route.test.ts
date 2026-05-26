import { describe, expect, it, vi } from "vitest";

import { resolveSupervisorReportsTo } from "../../worker/src/routes/supervisor.ts";

function makeEnv(results: Array<{ id: string } | null>) {
  let index = 0;

  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => results[index++] ?? null),
        })),
      })),
    },
  } as any;
}

describe("resolveSupervisorReportsTo", () => {
  it("returns null when no manager is specified", async () => {
    const env = makeEnv([]);

    await expect(
      resolveSupervisorReportsTo(env, "company-1", null),
    ).resolves.toBeNull();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("accepts an existing agent id directly", async () => {
    const env = makeEnv([{ id: "agent-123" }]);

    await expect(
      resolveSupervisorReportsTo(env, "company-1", "agent-123"),
    ).resolves.toBe("agent-123");
    expect(env.DB.prepare).toHaveBeenCalledTimes(1);
  });

  it("resolves blueprint hierarchy labels to an existing company agent", async () => {
    const env = makeEnv([null, { id: "agent-ceo" }]);

    await expect(
      resolveSupervisorReportsTo(env, "company-1", "ceo"),
    ).resolves.toBe("agent-ceo");
    expect(env.DB.prepare).toHaveBeenCalledTimes(2);
  });

  it("returns null when the supervisor references a missing manager", async () => {
    const env = makeEnv([null, null]);

    await expect(
      resolveSupervisorReportsTo(env, "company-1", "cto"),
    ).resolves.toBeNull();
  });
});
