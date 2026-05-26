import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestToken } from "../setup/auth.js";
import { ApiClient, ApiError } from "../setup/api-client.js";
import { TestDataManager } from "../setup/test-data.js";
import { TEST_COMPANY_ID } from "../setup/constants.js";

let api: ApiClient;
let data: TestDataManager;

beforeAll(async () => {
  const token = await getTestToken();
  api = new ApiClient(token);
  data = new TestDataManager(api);
});

afterAll(async () => {
  await data.cleanup();
});

describe("Approvals API", () => {
  let approvalId: string;
  let rejectApprovalId: string;

  describe("POST /api/companies/:id/approvals", () => {
    it("creates an approval", async () => {
      const approval = await data.createApproval({
        type: "strategy",
        payload: { description: "New marketing strategy" },
      });
      approvalId = approval.id as string;
      expect(approval.type).toBe("strategy");
      expect(approval.status).toBe("pending");
      expect(approval.company_id).toBe(TEST_COMPANY_ID);
    });

    it("creates another approval for rejection test", async () => {
      const approval = await data.createApproval({
        type: "budget_override",
        payload: { amount: 5000 },
      });
      rejectApprovalId = approval.id as string;
    });
  });

  describe("GET /api/companies/:id/approvals", () => {
    it("lists approvals", async () => {
      const res = await api.get<{ approvals: Array<{ id: string }> }>(
        `/api/companies/${TEST_COMPANY_ID}/approvals`,
      );
      expect(res.approvals).toBeInstanceOf(Array);
    });

    it("filters by status", async () => {
      const res = await api.get<{ approvals: Array<{ status: string }> }>(
        `/api/companies/${TEST_COMPANY_ID}/approvals?status=pending`,
      );
      for (const a of res.approvals) {
        expect(a.status).toBe("pending");
      }
    });
  });

  describe("GET /api/approvals/:id", () => {
    it("returns approval with comments array", async () => {
      const res = await api.get<{ approval: Record<string, unknown>; comments: unknown[] }>(
        `/api/approvals/${approvalId}`,
      );
      expect(res.approval.id).toBe(approvalId);
      expect(res.comments).toBeInstanceOf(Array);
    });
  });

  describe("POST /api/approvals/:id/approve", () => {
    it("approves a pending approval", async () => {
      const res = await api.post<{ success: boolean; status: string }>(
        `/api/approvals/${approvalId}/approve`,
        { note: "Looks good" },
      );
      expect(res.success).toBe(true);
      expect(res.status).toBe("approved");
    });

    it("returns 400 when approving non-pending", async () => {
      try {
        await api.post(`/api/approvals/${approvalId}/approve`);
        expect.fail("Should have thrown");
      } catch (e) {
        expect((e as ApiError).status).toBe(400);
      }
    });
  });

  describe("POST /api/approvals/:id/reject", () => {
    it("rejects a pending approval", async () => {
      const res = await api.post<{ success: boolean; status: string }>(
        `/api/approvals/${rejectApprovalId}/reject`,
        { note: "Not approved" },
      );
      expect(res.success).toBe(true);
      expect(res.status).toBe("rejected");
    });
  });

  describe("POST /api/approvals/:id/comments", () => {
    it("adds a comment to an approval", async () => {
      const res = await api.post<{ comment: Record<string, unknown> }>(
        `/api/approvals/${approvalId}/comments`,
        { body: "Great decision" },
      );
      expect(res.comment.body).toBe("Great decision");
      expect(res.comment.approval_id).toBe(approvalId);
    });
  });
});
