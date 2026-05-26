import { describe, it, expect, beforeAll } from "vitest";
import { getTestToken } from "../setup/auth.js";
import { ApiClient } from "../setup/api-client.js";
import { TEST_COMPANY_ID } from "../setup/constants.js";

let api: ApiClient;

beforeAll(async () => {
  const token = await getTestToken();
  api = new ApiClient(token);
});

describe("Costs API", () => {
  describe("GET /api/companies/:id/costs/summary", () => {
    it("returns cost summary with numeric fields", async () => {
      const res = await api.get<Record<string, unknown>>(
        `/api/companies/${TEST_COMPANY_ID}/costs/summary`,
      );
      expect(typeof res.budgetMonthlyCents).toBe("number");
      expect(typeof res.spentMonthlyCents).toBe("number");
      expect(typeof res.totalCostCents).toBe("number");
      expect(typeof res.totalInputTokens).toBe("number");
      expect(typeof res.totalOutputTokens).toBe("number");
      expect(typeof res.eventCount).toBe("number");
    });

    it("returns 401 without auth", async () => {
      const res = await api.unauthenticated(
        "GET",
        `/api/companies/${TEST_COMPANY_ID}/costs/summary`,
      );
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/companies/:id/costs/by-agent", () => {
    it("returns per-agent cost array", async () => {
      const res = await api.get<{ agents: unknown[] }>(
        `/api/companies/${TEST_COMPANY_ID}/costs/by-agent`,
      );
      expect(res.agents).toBeInstanceOf(Array);
    });
  });
});
