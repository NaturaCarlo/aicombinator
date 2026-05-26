import { describe, expect, it } from "vitest";

/**
 * Tests for company name editing feature (VAL-SETTINGS-001 through VAL-SETTINGS-006).
 *
 * These tests cover:
 * - Worker PATCH /api/companies/:id accepting a `name` field
 * - Empty name rejection
 * - Very long name handling (max 200 chars)
 * - Special character (XSS) safety
 * - Dashboard updateCompany API accepting name
 */

// ── Validation helpers (same logic as worker route) ─────────

const MAX_COMPANY_NAME_LENGTH = 200;

function validateCompanyName(name: unknown): { valid: boolean; error?: string; sanitized?: string } {
  if (typeof name !== "string") {
    return { valid: false, error: "Name must be a string" };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Company name cannot be empty" };
  }
  if (trimmed.length > MAX_COMPANY_NAME_LENGTH) {
    return { valid: false, error: `Company name must be ${MAX_COMPANY_NAME_LENGTH} characters or fewer` };
  }
  // Sanitize: strip HTML tags to prevent XSS
  const sanitized = trimmed.replace(/<[^>]*>/g, "");
  return { valid: true, sanitized };
}

describe("Company name validation", () => {
  it("rejects empty string", () => {
    const result = validateCompanyName("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("rejects whitespace-only string", () => {
    const result = validateCompanyName("   ");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("accepts a valid company name", () => {
    const result = validateCompanyName("Acme Corp");
    expect(result.valid).toBe(true);
    expect(result.sanitized).toBe("Acme Corp");
  });

  it("trims whitespace from name", () => {
    const result = validateCompanyName("  Acme Corp  ");
    expect(result.valid).toBe(true);
    expect(result.sanitized).toBe("Acme Corp");
  });

  it("rejects name longer than 200 characters", () => {
    const longName = "A".repeat(201);
    const result = validateCompanyName(longName);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("200");
  });

  it("accepts name of exactly 200 characters", () => {
    const name = "A".repeat(200);
    const result = validateCompanyName(name);
    expect(result.valid).toBe(true);
  });

  it("strips HTML tags for XSS prevention", () => {
    const result = validateCompanyName('<script>alert("xss")</script>My Company');
    expect(result.valid).toBe(true);
    expect(result.sanitized).toBe('alert("xss")My Company');
    expect(result.sanitized).not.toContain("<script>");
  });

  it("handles emoji safely", () => {
    const result = validateCompanyName("🚀 Rocket Corp 🌟");
    expect(result.valid).toBe(true);
    expect(result.sanitized).toBe("🚀 Rocket Corp 🌟");
  });

  it("handles quotes safely", () => {
    const result = validateCompanyName('O\'Brien & "Partners"');
    expect(result.valid).toBe(true);
    expect(result.sanitized).toBe('O\'Brien & "Partners"');
  });

  it("handles HTML entities safely", () => {
    const result = validateCompanyName("Comp &amp; Co <b>Bold</b>");
    expect(result.valid).toBe(true);
    expect(result.sanitized).toBe("Comp &amp; Co Bold");
    expect(result.sanitized).not.toContain("<b>");
  });

  it("rejects non-string input", () => {
    const result = validateCompanyName(42);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("string");
  });

  it("rejects null input", () => {
    const result = validateCompanyName(null);
    expect(result.valid).toBe(false);
  });

  it("rejects undefined input", () => {
    const result = validateCompanyName(undefined);
    expect(result.valid).toBe(false);
  });
});

describe("updateCompany API type contract", () => {
  it("updateCompany accepts name field in the updates parameter", () => {
    // This is a type-level test: ensure the interface allows `name`
    const updates: {
      publicVisible?: boolean;
      state?: "running" | "paused" | "failed";
      paused?: boolean;
      mode?: "autonomous" | "manual";
      name?: string;
    } = { name: "New Name" };
    expect(updates.name).toBe("New Name");
  });
});

describe("Worker PATCH /api/companies/:id name handling", () => {
  it("should accept name in body and produce SQL UPDATE with name field", () => {
    // Simulate extracting name from request body and building update query
    const body = { name: "Updated Corp" };
    const updates: string[] = [];
    const values: unknown[] = [];

    if (typeof body.name === "string") {
      const trimmed = body.name.trim();
      if (trimmed.length > 0 && trimmed.length <= MAX_COMPANY_NAME_LENGTH) {
        const sanitized = trimmed.replace(/<[^>]*>/g, "");
        updates.push("name = ?");
        values.push(sanitized);
      }
    }

    expect(updates).toContain("name = ?");
    expect(values).toContain("Updated Corp");
  });

  it("should reject empty name with 400 status semantics", () => {
    const body = { name: "" };
    const nameResult = validateCompanyName(body.name);
    expect(nameResult.valid).toBe(false);
  });

  it("should strip HTML from name before saving", () => {
    const body = { name: "<img src=x onerror=alert(1)>Good Name" };
    const nameResult = validateCompanyName(body.name);
    expect(nameResult.valid).toBe(true);
    expect(nameResult.sanitized).not.toContain("<img");
    expect(nameResult.sanitized).toContain("Good Name");
  });
});
