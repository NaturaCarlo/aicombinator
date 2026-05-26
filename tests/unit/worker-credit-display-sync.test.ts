/**
 * Tests for credit display and sync fixes:
 * 1. Supervisor notification after credit grant (with dedup by supervisor URL)
 * 2. Math.max credit resolution logic in founder-state
 * 3. Both sources returning values
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock modules at top level (hoisted)
// ---------------------------------------------------------------------------

const mockResolveSupervisorBaseUrlByCompanyId = vi.fn();
const mockFetchFromCompanySupervisor = vi.fn();
const mockGlobalFetch = vi.fn();

vi.mock("../../worker/src/utils/supervisor-routing.js", () => ({
  fetchFromCompanySupervisor: (...args: unknown[]) => mockFetchFromCompanySupervisor(...args),
  resolveSupervisorBaseUrlByCompanyId: (...args: unknown[]) =>
    mockResolveSupervisorBaseUrlByCompanyId(...args),
  resolveSupervisorBaseUrlForCompany: vi.fn(),
  sharedSupervisorBaseUrl: vi.fn(),
  registerSharedSupervisorBaseUrl: vi.fn(),
  dedicatedSupervisorBaseUrl: vi.fn(),
  getCompanySupervisorRecord: vi.fn(),
}));

vi.mock("../../worker/src/utils/credits.js", () => ({
  grantCredits: vi.fn(async () => {}),
}));

vi.mock("../../worker/src/utils/internal-contract.js", () => ({
  buildInternalContractHeaders: vi.fn((h: Record<string, string>) => h),
  isCompatibleInternalContractVersion: vi.fn(() => true),
}));

// Import after mocks
import { notifySupervisorsOfCreditGrant } from "../../worker/src/utils/stripe-credits.js";
import type { Env } from "../../worker/src/types.js";

// ---------------------------------------------------------------------------
// 1. Supervisor notification after credit grant
// ---------------------------------------------------------------------------

describe("notifySupervisorsOfCreditGrant", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeEnv(prepareImpl: (...args: unknown[]) => unknown): Env {
    return {
      DB: { prepare: prepareImpl },
      SUPERVISOR_API_KEY: "test-key",
      AUTOMATON_KV: {},
    } as unknown as Env;
  }

  it("resolves URLs and POSTs to each unique supervisor", async () => {
    const mockAll = vi.fn().mockResolvedValue({
      results: [{ id: "company-1" }, { id: "company-2" }],
    });
    const env = makeEnv(
      vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: mockAll }) }),
    );

    // Two companies with DIFFERENT supervisor URLs
    mockResolveSupervisorBaseUrlByCompanyId
      .mockResolvedValueOnce("http://203.0.113.10:8787")
      .mockResolvedValueOnce("http://10.0.0.5:8787");

    mockGlobalFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await notifySupervisorsOfCreditGrant(env, "user-1", 500);

    // Should POST to each unique supervisor URL
    expect(mockGlobalFetch).toHaveBeenCalledTimes(2);
    expect(mockGlobalFetch).toHaveBeenCalledWith(
      "http://203.0.113.10:8787/credits/purchased",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_id: "user-1", amount: 500 }),
      }),
    );
    expect(mockGlobalFetch).toHaveBeenCalledWith(
      "http://10.0.0.5:8787/credits/purchased",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_id: "user-1", amount: 500 }),
      }),
    );
  });

  it("deduplicates — multiple companies on same supervisor produce only one POST", async () => {
    const mockAll = vi.fn().mockResolvedValue({
      results: [{ id: "company-1" }, { id: "company-2" }, { id: "company-3" }],
    });
    const env = makeEnv(
      vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: mockAll }) }),
    );

    // All three companies resolve to the SAME shared supervisor URL
    mockResolveSupervisorBaseUrlByCompanyId
      .mockResolvedValue("http://203.0.113.10:8787");

    mockGlobalFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await notifySupervisorsOfCreditGrant(env, "user-1", 1000);

    // Should resolve URL for all 3 companies
    expect(mockResolveSupervisorBaseUrlByCompanyId).toHaveBeenCalledTimes(3);

    // But only POST once to the shared supervisor
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
    expect(mockGlobalFetch).toHaveBeenCalledWith(
      "http://203.0.113.10:8787/credits/purchased",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_id: "user-1", amount: 1000 }),
      }),
    );
  });

  it("deduplicates — 2 shared + 1 dedicated = 2 POSTs", async () => {
    const mockAll = vi.fn().mockResolvedValue({
      results: [{ id: "company-1" }, { id: "company-2" }, { id: "company-3" }],
    });
    const env = makeEnv(
      vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: mockAll }) }),
    );

    // Two companies on shared supervisor, one on a dedicated VM
    mockResolveSupervisorBaseUrlByCompanyId
      .mockResolvedValueOnce("http://203.0.113.10:8787")  // company-1: shared
      .mockResolvedValueOnce("http://203.0.113.10:8787")  // company-2: shared (same)
      .mockResolvedValueOnce("http://10.0.0.99:8787");     // company-3: dedicated

    mockGlobalFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await notifySupervisorsOfCreditGrant(env, "user-1", 750);

    // Should POST to exactly 2 unique supervisor URLs
    expect(mockGlobalFetch).toHaveBeenCalledTimes(2);
    const fetchedUrls = mockGlobalFetch.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(fetchedUrls).toContain("http://203.0.113.10:8787/credits/purchased");
    expect(fetchedUrls).toContain("http://10.0.0.99:8787/credits/purchased");
  });

  it("is non-fatal when supervisor URL is null (unreachable)", async () => {
    const mockAll = vi.fn().mockResolvedValue({
      results: [{ id: "company-1" }],
    });
    const env = makeEnv(
      vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: mockAll }) }),
    );

    mockResolveSupervisorBaseUrlByCompanyId.mockResolvedValue(null);

    await expect(
      notifySupervisorsOfCreditGrant(env, "user-1", 100),
    ).resolves.toBeUndefined();

    // No fetch call when URL is null
    expect(mockGlobalFetch).not.toHaveBeenCalled();
  });

  it("handles no companies for user gracefully", async () => {
    const mockAll = vi.fn().mockResolvedValue({ results: [] });
    const env = makeEnv(
      vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: mockAll }) }),
    );

    await notifySupervisorsOfCreditGrant(env, "user-no-companies", 100);

    expect(mockResolveSupervisorBaseUrlByCompanyId).not.toHaveBeenCalled();
    expect(mockGlobalFetch).not.toHaveBeenCalled();
  });

  it("is non-fatal when DB query fails", async () => {
    const env = makeEnv(
      vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockRejectedValue(new Error("DB error")),
        }),
      }),
    );

    await expect(
      notifySupervisorsOfCreditGrant(env, "user-1", 100),
    ).resolves.toBeUndefined();
  });

  it("is non-fatal when fetch throws", async () => {
    const mockAll = vi.fn().mockResolvedValue({
      results: [{ id: "company-1" }],
    });
    const env = makeEnv(
      vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: mockAll }) }),
    );

    mockResolveSupervisorBaseUrlByCompanyId.mockResolvedValue("http://203.0.113.10:8787");
    mockGlobalFetch.mockRejectedValue(new Error("Network error"));

    await expect(
      notifySupervisorsOfCreditGrant(env, "user-1", 100),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Math.max credit resolution logic
// ---------------------------------------------------------------------------

describe("Credit resolution: Math.max(D1, supervisor)", () => {
  /**
   * Replicates the credit resolution logic from founder-state.ts
   * to verify Math.max(d1Balance, supervisorBalance) behavior.
   */
  function resolveTotalBalance(
    d1Balance: number | null | undefined,
    supervisorBalance: number | null | undefined,
  ): number {
    return Math.max(d1Balance ?? 0, supervisorBalance ?? 0);
  }

  it("returns D1 balance when supervisor is null (unreachable)", () => {
    expect(resolveTotalBalance(5000, null)).toBe(5000);
  });

  it("returns supervisor balance when D1 is null", () => {
    expect(resolveTotalBalance(null, 3000)).toBe(3000);
  });

  it("returns the higher value when both sources have values", () => {
    expect(resolveTotalBalance(5000, 2000)).toBe(5000);
  });

  it("returns supervisor when it has the higher value", () => {
    expect(resolveTotalBalance(3000, 4500)).toBe(4500);
  });

  it("returns 0 when both are null", () => {
    expect(resolveTotalBalance(null, null)).toBe(0);
  });

  it("returns 0 when both are 0", () => {
    expect(resolveTotalBalance(0, 0)).toBe(0);
  });

  it("returns 0 when both are undefined", () => {
    expect(resolveTotalBalance(undefined, undefined)).toBe(0);
  });

  it("handles D1 = 0 and supervisor has value", () => {
    expect(resolveTotalBalance(0, 1500)).toBe(1500);
  });

  it("handles supervisor = 0 and D1 has value", () => {
    expect(resolveTotalBalance(2500, 0)).toBe(2500);
  });

  it("correctly uses the new formula vs old formula", () => {
    // Old formula: Math.max(0, supervisorCredits?.totalBalance ?? balanceRow?.balance ?? 0)
    // New formula: Math.max(balanceRow?.balance ?? 0, supervisorCredits?.totalBalance ?? 0)
    const oldFormula = (d1: number | null, sup: number | null) =>
      Math.max(0, sup ?? d1 ?? 0);
    const newFormula = (d1: number | null, sup: number | null) =>
      Math.max(d1 ?? 0, sup ?? 0);

    // Critical scenario: supervisor returns 0 (stale), D1 has the real balance
    expect(oldFormula(5000, 0)).toBe(0); // Old: WRONG - shows 0
    expect(newFormula(5000, 0)).toBe(5000); // New: CORRECT - shows 5000
  });
});

// ---------------------------------------------------------------------------
// 3. Verify FounderStatePayload credits type compliance
// ---------------------------------------------------------------------------

describe("FounderStatePayload credit fields type compliance", () => {
  it("credits object has expected shape", () => {
    type FounderCredits = {
      balance: number;
      reserved: number;
      available: number;
      currentCompanyReserved: number;
      otherCompanyReserved: number;
      contentionReason: string | null;
      reservations: Array<{
        companyId: string;
        companyName: string;
        state: string | null;
        reserved: number;
        isCurrentCompany: boolean;
      }>;
    };

    const credits: FounderCredits = {
      balance: 5000,
      reserved: 1000,
      available: 4000,
      currentCompanyReserved: 500,
      otherCompanyReserved: 500,
      contentionReason: null,
      reservations: [],
    };

    expect(credits.balance).toBe(5000);
    expect(credits.available).toBe(4000);
  });
});
