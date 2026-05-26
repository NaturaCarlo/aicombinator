import { describe, expect, it, vi } from "vitest";
import {
  extractFrontmatter,
  parsePackageRef,
  parseCompaniesShPackage,
  importToDb,
  type FetchFn,
  type ImportResult,
} from "../../supervisor/src/importers/companies-sh.ts";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const COMPANY_MD = `---
name: GStack Technologies
description: A full-stack SaaS company building developer tools
goals:
  - Launch MVP by Q2
  - Acquire 100 beta users
  - Achieve product-market fit
---

# GStack Technologies

Building the future of developer tooling.
`;

const COMPANY_MD_NO_GOALS = `---
name: SimpleCorptest
description: A simple company
---

Just a company.
`;

const COMPANY_MD_MALFORMED = `---
name: BrokenCo
description this is missing the colon somehow
goals:
  - Goal one
---

Body content.
`;

const COMPANY_MD_NO_FRONTMATTER = `# No Frontmatter
This file has no YAML frontmatter at all.
`;

const COMPANY_MD_UNCLOSED = `---
name: Unclosed
description: Missing closing delimiter
`;

const CEO_AGENTS_MD = `---
name: CEO Agent
role: executive
title: Chief Executive Officer
reportsTo:
skills:
  - strategy
---

The CEO oversees all company operations.
`;

const CTO_AGENTS_MD = `---
name: CTO Agent
role: engineering
title: Chief Technology Officer
reportsTo: CEO Agent
skills:
  - coding
---

The CTO leads engineering.
`;

const DEV_AGENTS_MD = `---
name: Developer
role: engineering
title: Senior Developer
reportsTo: CTO Agent
skills:
  - coding
---

A senior developer.
`;

const AGENT_MD_MALFORMED = `---
role: broken
title: Missing Name Agent
---

This agent is missing the required name field.
`;

const STRATEGY_SKILL_MD = `---
name: Strategy
description: Strategic planning and execution
---

## Strategy Skill

This skill covers strategic planning, competitive analysis, and goal setting.
`;

const CODING_SKILL_MD = `---
name: Coding
description: Software development
---

## Coding Skill

Write clean, maintainable code following best practices.
`;

const SKILL_NO_FRONTMATTER = `# Leadership Skill

This skill file has no frontmatter, just plain markdown content.
`;

// ---------------------------------------------------------------------------
// Mock GitHub API tree response
// ---------------------------------------------------------------------------

function makeTreeResponse(files: string[]): string {
  return JSON.stringify({
    tree: files.map((path) => ({ path, type: "blob" })),
    truncated: false,
  });
}

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function createMockFetch(
  responses: Record<string, { ok: boolean; status: number; body: string }>,
): FetchFn {
  return async (url: string) => {
    const entry = responses[url];
    if (!entry) {
      return { ok: false, status: 404, text: async () => "Not Found" };
    }
    return {
      ok: entry.ok,
      status: entry.status,
      text: async () => entry.body,
    };
  };
}

// ---------------------------------------------------------------------------
// Tests: extractFrontmatter
// ---------------------------------------------------------------------------

describe("companies.sh parser", () => {
  describe("extractFrontmatter", () => {
    it("extracts name, description, and goals from COMPANY.md", () => {
      const result = extractFrontmatter(COMPANY_MD);
      expect(result).not.toBeNull();
      expect(result!.frontmatter["name"]).toBe("GStack Technologies");
      expect(result!.frontmatter["description"]).toBe(
        "A full-stack SaaS company building developer tools",
      );
      expect(result!.frontmatter["goals"]).toEqual([
        "Launch MVP by Q2",
        "Acquire 100 beta users",
        "Achieve product-market fit",
      ]);
      expect(result!.body).toContain("Building the future");
    });

    it("handles files without goals list", () => {
      const result = extractFrontmatter(COMPANY_MD_NO_GOALS);
      expect(result).not.toBeNull();
      expect(result!.frontmatter["name"]).toBe("SimpleCorptest");
      expect(result!.frontmatter["goals"]).toBeUndefined();
    });

    it("handles malformed YAML gracefully (partial parse)", () => {
      const result = extractFrontmatter(COMPANY_MD_MALFORMED);
      expect(result).not.toBeNull();
      // 'name' should still be extracted
      expect(result!.frontmatter["name"]).toBe("BrokenCo");
      // The malformed line should not crash
      expect(result!.frontmatter["goals"]).toEqual(["Goal one"]);
    });

    it("returns null for files without frontmatter", () => {
      const result = extractFrontmatter(COMPANY_MD_NO_FRONTMATTER);
      expect(result).toBeNull();
    });

    it("returns null for unclosed frontmatter", () => {
      const result = extractFrontmatter(COMPANY_MD_UNCLOSED);
      expect(result).toBeNull();
    });

    it("extracts agent definition fields", () => {
      const result = extractFrontmatter(CEO_AGENTS_MD);
      expect(result).not.toBeNull();
      expect(result!.frontmatter["name"]).toBe("CEO Agent");
      expect(result!.frontmatter["role"]).toBe("executive");
      expect(result!.frontmatter["title"]).toBe("Chief Executive Officer");
      expect(result!.frontmatter["skills"]).toEqual(["strategy"]);
    });

    it("extracts reportsTo for child agents", () => {
      const result = extractFrontmatter(CTO_AGENTS_MD);
      expect(result).not.toBeNull();
      expect(result!.frontmatter["reportsTo"]).toBe("CEO Agent");
    });

    it("handles quoted YAML values", () => {
      const content = `---
name: "Quoted Name"
description: 'Single Quoted'
---
Body.
`;
      const result = extractFrontmatter(content);
      expect(result).not.toBeNull();
      expect(result!.frontmatter["name"]).toBe("Quoted Name");
      expect(result!.frontmatter["description"]).toBe("Single Quoted");
    });

    it("handles leading whitespace before frontmatter", () => {
      const content = `   \n---\nname: Spaced\n---\nBody.`;
      const result = extractFrontmatter(content);
      expect(result).not.toBeNull();
      expect(result!.frontmatter["name"]).toBe("Spaced");
    });

    it("extracts skill definitions from SKILL.md", () => {
      const result = extractFrontmatter(STRATEGY_SKILL_MD);
      expect(result).not.toBeNull();
      expect(result!.frontmatter["name"]).toBe("Strategy");
      expect(result!.frontmatter["description"]).toBe(
        "Strategic planning and execution",
      );
      expect(result!.body).toContain("## Strategy Skill");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: parsePackageRef
  // ---------------------------------------------------------------------------

  describe("parsePackageRef", () => {
    it("parses owner/repo/path format", () => {
      const result = parsePackageRef("paperclipai/companies/gstack");
      expect(result).toEqual({
        owner: "paperclipai",
        repo: "companies",
        path: "gstack",
      });
    });

    it("parses owner/repo format (root package)", () => {
      const result = parsePackageRef("paperclipai/companies");
      expect(result).toEqual({
        owner: "paperclipai",
        repo: "companies",
        path: "",
      });
    });

    it("parses full GitHub URL", () => {
      const result = parsePackageRef(
        "https://github.com/paperclipai/companies",
      );
      expect(result).toEqual({
        owner: "paperclipai",
        repo: "companies",
        path: "",
      });
    });

    it("parses GitHub URL with tree path", () => {
      const result = parsePackageRef(
        "https://github.com/paperclipai/companies/tree/main/gstack",
      );
      expect(result).toEqual({
        owner: "paperclipai",
        repo: "companies",
        path: "gstack",
      });
    });

    it("parses GitHub URL with .git suffix", () => {
      const result = parsePackageRef(
        "https://github.com/paperclipai/companies.git",
      );
      expect(result).toEqual({
        owner: "paperclipai",
        repo: "companies",
        path: "",
      });
    });

    it("returns null for invalid reference (single segment)", () => {
      const result = parsePackageRef("justoneword");
      expect(result).toBeNull();
    });

    it("returns null for empty string", () => {
      const result = parsePackageRef("");
      expect(result).toBeNull();
    });

    it("handles trailing slashes", () => {
      const result = parsePackageRef("owner/repo/path/");
      expect(result).toEqual({
        owner: "owner",
        repo: "repo",
        path: "path",
      });
    });

    it("handles nested paths", () => {
      const result = parsePackageRef("owner/repo/deep/nested/path");
      expect(result).toEqual({
        owner: "owner",
        repo: "repo",
        path: "deep/nested/path",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: parseCompaniesShPackage (VAL-IMPORT-003, VAL-IMPORT-004, VAL-IMPORT-005, VAL-IMPORT-006)
  // ---------------------------------------------------------------------------

  describe("parseCompaniesShPackage", () => {
    it("parses complete package with company, agents, and skills (VAL-IMPORT-003, 004, 006)", async () => {
      const treeFiles = [
        "gstack/COMPANY.md",
        "gstack/agents/ceo/AGENTS.md",
        "gstack/agents/cto/AGENTS.md",
        "gstack/agents/dev/AGENTS.md",
        "gstack/skills/strategy/SKILL.md",
        "gstack/skills/coding/SKILL.md",
      ];

      const mockFetch = createMockFetch({
        "https://raw.githubusercontent.com/paperclipai/companies/main/gstack/COMPANY.md": {
          ok: true,
          status: 200,
          body: COMPANY_MD,
        },
        "https://api.github.com/repos/paperclipai/companies/git/trees/main?recursive=1": {
          ok: true,
          status: 200,
          body: makeTreeResponse(treeFiles),
        },
        "https://raw.githubusercontent.com/paperclipai/companies/main/gstack/agents/ceo/AGENTS.md": {
          ok: true,
          status: 200,
          body: CEO_AGENTS_MD,
        },
        "https://raw.githubusercontent.com/paperclipai/companies/main/gstack/agents/cto/AGENTS.md": {
          ok: true,
          status: 200,
          body: CTO_AGENTS_MD,
        },
        "https://raw.githubusercontent.com/paperclipai/companies/main/gstack/agents/dev/AGENTS.md": {
          ok: true,
          status: 200,
          body: DEV_AGENTS_MD,
        },
        "https://raw.githubusercontent.com/paperclipai/companies/main/gstack/skills/strategy/SKILL.md": {
          ok: true,
          status: 200,
          body: STRATEGY_SKILL_MD,
        },
        "https://raw.githubusercontent.com/paperclipai/companies/main/gstack/skills/coding/SKILL.md": {
          ok: true,
          status: 200,
          body: CODING_SKILL_MD,
        },
      });

      const result = await parseCompaniesShPackage(
        "paperclipai/companies/gstack",
        mockFetch,
      );

      // VAL-IMPORT-003: Company metadata
      expect(result.company.name).toBe("GStack Technologies");
      expect(result.company.description).toBe(
        "A full-stack SaaS company building developer tools",
      );
      expect(result.company.goals).toEqual([
        "Launch MVP by Q2",
        "Acquire 100 beta users",
        "Achieve product-market fit",
      ]);

      // VAL-IMPORT-004: Agent definitions
      expect(result.agents).toHaveLength(3);
      const ceo = result.agents.find((a) => a.name === "CEO Agent");
      expect(ceo).toBeDefined();
      expect(ceo!.role).toBe("executive");
      expect(ceo!.title).toBe("Chief Executive Officer");
      expect(ceo!.slug).toBe("ceo");

      const cto = result.agents.find((a) => a.name === "CTO Agent");
      expect(cto).toBeDefined();
      expect(cto!.role).toBe("engineering");
      expect(cto!.slug).toBe("cto");

      const dev = result.agents.find((a) => a.name === "Developer");
      expect(dev).toBeDefined();
      expect(dev!.slug).toBe("dev");

      // VAL-IMPORT-005: reportsTo hierarchy
      expect(ceo!.reportsTo).toBeNull();
      expect(cto!.reportsTo).toBe("CEO Agent");
      expect(dev!.reportsTo).toBe("CTO Agent");

      // VAL-IMPORT-006: Skills resolved
      expect(result.skills).toHaveLength(2);
      const strategySkill = result.skills.find((s) => s.slug === "strategy");
      expect(strategySkill).toBeDefined();
      expect(strategySkill!.name).toBe("Strategy");
      expect(strategySkill!.instructions).toContain("strategic planning");

      const codingSkill = result.skills.find((s) => s.slug === "coding");
      expect(codingSkill).toBeDefined();
      expect(codingSkill!.name).toBe("Coding");

      // No errors for valid package
      expect(result.errors).toHaveLength(0);
    });

    it("handles missing COMPANY.md (404) gracefully", async () => {
      const mockFetch = createMockFetch({
        "https://raw.githubusercontent.com/owner/repo/main/COMPANY.md": {
          ok: false,
          status: 404,
          body: "Not Found",
        },
        "https://api.github.com/repos/owner/repo/git/trees/main?recursive=1": {
          ok: true,
          status: 200,
          body: makeTreeResponse([]),
        },
      });

      const result = await parseCompaniesShPackage("owner/repo", mockFetch);

      expect(result.company.name).toBe("");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes("COMPANY.md") && e.includes("not found"))).toBe(true);
    });

    it("handles malformed YAML in COMPANY.md gracefully (returns error, not crash)", async () => {
      const mockFetch = createMockFetch({
        "https://raw.githubusercontent.com/owner/repo/main/COMPANY.md": {
          ok: true,
          status: 200,
          body: COMPANY_MD_NO_FRONTMATTER,
        },
        "https://api.github.com/repos/owner/repo/git/trees/main?recursive=1": {
          ok: true,
          status: 200,
          body: makeTreeResponse([]),
        },
      });

      const result = await parseCompaniesShPackage("owner/repo", mockFetch);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes("COMPANY.md") && e.includes("frontmatter"))).toBe(true);
      // Should not throw — returns result with errors
      expect(result.company.name).toBe("");
    });

    it("handles invalid package reference (VAL-IMPORT-008)", async () => {
      const result = await parseCompaniesShPackage("invalid");

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Invalid package reference");
    });

    it("handles empty package reference", async () => {
      const result = await parseCompaniesShPackage("");

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Invalid package reference");
    });

    it("handles agent with missing name field", async () => {
      const treeFiles = [
        "COMPANY.md",
        "agents/broken/AGENTS.md",
      ];

      const mockFetch = createMockFetch({
        "https://raw.githubusercontent.com/owner/repo/main/COMPANY.md": {
          ok: true,
          status: 200,
          body: COMPANY_MD,
        },
        "https://api.github.com/repos/owner/repo/git/trees/main?recursive=1": {
          ok: true,
          status: 200,
          body: makeTreeResponse(treeFiles),
        },
        "https://raw.githubusercontent.com/owner/repo/main/agents/broken/AGENTS.md": {
          ok: true,
          status: 200,
          body: AGENT_MD_MALFORMED,
        },
      });

      const result = await parseCompaniesShPackage("owner/repo", mockFetch);

      // Should report error for the broken agent but not crash
      expect(result.errors.some((e) => e.includes("Missing required field 'name'"))).toBe(true);
      expect(result.agents).toHaveLength(0);
    });

    it("handles skill with no frontmatter (plain markdown)", async () => {
      const treeFiles = [
        "COMPANY.md",
        "skills/leadership/SKILL.md",
      ];

      const mockFetch = createMockFetch({
        "https://raw.githubusercontent.com/owner/repo/main/COMPANY.md": {
          ok: true,
          status: 200,
          body: COMPANY_MD,
        },
        "https://api.github.com/repos/owner/repo/git/trees/main?recursive=1": {
          ok: true,
          status: 200,
          body: makeTreeResponse(treeFiles),
        },
        "https://raw.githubusercontent.com/owner/repo/main/skills/leadership/SKILL.md": {
          ok: true,
          status: 200,
          body: SKILL_NO_FRONTMATTER,
        },
      });

      const result = await parseCompaniesShPackage("owner/repo", mockFetch);

      expect(result.skills).toHaveLength(1);
      // Should use slug as name when no frontmatter
      expect(result.skills[0]!.slug).toBe("leadership");
      expect(result.skills[0]!.name).toBe("leadership");
      expect(result.skills[0]!.instructions).toContain("Leadership Skill");
    });

    it("handles fetch network error gracefully", async () => {
      const mockFetch: FetchFn = async () => {
        throw new Error("Network error: ECONNREFUSED");
      };

      const result = await parseCompaniesShPackage(
        "owner/repo",
        mockFetch,
      );

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes("ECONNREFUSED"))).toBe(true);
    });

    it("handles non-200 HTTP response for COMPANY.md", async () => {
      const mockFetch = createMockFetch({
        "https://raw.githubusercontent.com/owner/repo/main/COMPANY.md": {
          ok: false,
          status: 500,
          body: "Internal Server Error",
        },
        "https://api.github.com/repos/owner/repo/git/trees/main?recursive=1": {
          ok: true,
          status: 200,
          body: makeTreeResponse([]),
        },
      });

      const result = await parseCompaniesShPackage("owner/repo", mockFetch);

      expect(result.errors.some((e) => e.includes("HTTP 500"))).toBe(true);
    });

    it("warns about unresolved skill references on agents", async () => {
      const agentWithBadSkill = `---
name: Agent With Bad Skill
role: specialist
title: Specialist
skills:
  - nonexistent-skill
---
Body.
`;

      const treeFiles = [
        "COMPANY.md",
        "agents/bad/AGENTS.md",
      ];

      const mockFetch = createMockFetch({
        "https://raw.githubusercontent.com/owner/repo/main/COMPANY.md": {
          ok: true,
          status: 200,
          body: COMPANY_MD,
        },
        "https://api.github.com/repos/owner/repo/git/trees/main?recursive=1": {
          ok: true,
          status: 200,
          body: makeTreeResponse(treeFiles),
        },
        "https://raw.githubusercontent.com/owner/repo/main/agents/bad/AGENTS.md": {
          ok: true,
          status: 200,
          body: agentWithBadSkill,
        },
      });

      const result = await parseCompaniesShPackage("owner/repo", mockFetch);

      expect(result.agents).toHaveLength(1);
      expect(
        result.errors.some(
          (e) =>
            e.includes("nonexistent-skill") && e.includes("not found"),
        ),
      ).toBe(true);
    });

    it("handles GitHub tree API failure gracefully", async () => {
      const mockFetch = createMockFetch({
        "https://raw.githubusercontent.com/owner/repo/main/COMPANY.md": {
          ok: true,
          status: 200,
          body: COMPANY_MD,
        },
        "https://api.github.com/repos/owner/repo/git/trees/main?recursive=1": {
          ok: false,
          status: 403,
          body: "Rate limited",
        },
      });

      const result = await parseCompaniesShPackage("owner/repo", mockFetch);

      // Should still return company data
      expect(result.company.name).toBe("GStack Technologies");
      // Agents and skills will be empty since we couldn't list directories
      expect(result.agents).toHaveLength(0);
      expect(result.skills).toHaveLength(0);
    });

    it("parses root-level package (owner/repo) correctly", async () => {
      const treeFiles = [
        "COMPANY.md",
        "agents/ceo/AGENTS.md",
        "skills/strategy/SKILL.md",
      ];

      const mockFetch = createMockFetch({
        "https://raw.githubusercontent.com/owner/repo/main/COMPANY.md": {
          ok: true,
          status: 200,
          body: COMPANY_MD,
        },
        "https://api.github.com/repos/owner/repo/git/trees/main?recursive=1": {
          ok: true,
          status: 200,
          body: makeTreeResponse(treeFiles),
        },
        "https://raw.githubusercontent.com/owner/repo/main/agents/ceo/AGENTS.md": {
          ok: true,
          status: 200,
          body: CEO_AGENTS_MD,
        },
        "https://raw.githubusercontent.com/owner/repo/main/skills/strategy/SKILL.md": {
          ok: true,
          status: 200,
          body: STRATEGY_SKILL_MD,
        },
      });

      const result = await parseCompaniesShPackage("owner/repo", mockFetch);

      expect(result.company.name).toBe("GStack Technologies");
      expect(result.agents).toHaveLength(1);
      expect(result.skills).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: importToDb (VAL-IMPORT-009 — idempotency)
  // ---------------------------------------------------------------------------

  describe("importToDb", () => {
    const baseImportResult: ImportResult = {
      company: {
        name: "Test Co",
        description: "A test company",
        goals: ["Goal 1"],
      },
      agents: [
        {
          name: "CEO",
          role: "executive",
          title: "Chief Executive Officer",
          reportsTo: null,
          skills: ["strategy"],
          slug: "ceo",
        },
        {
          name: "CTO",
          role: "engineering",
          title: "Chief Technology Officer",
          reportsTo: "CEO",
          skills: ["architecture"],
          slug: "cto",
        },
        {
          name: "Developer",
          role: "engineering",
          title: "Senior Developer",
          reportsTo: "CTO",
          skills: ["coding"],
          slug: "developer",
        },
      ],
      skills: [
        {
          slug: "strategy",
          name: "Strategy",
          description: "Strategic planning",
          instructions: "Plan strategically.",
        },
      ],
      errors: [],
    };

    it("creates all agents on first import", () => {
      let nextId = 1;
      const createdAgents: Array<{ id: string; name: string; role: string }> = [];

      const result = importToDb({
        companyId: "company-001",
        importResult: baseImportResult,
        getExistingAgentsByName: () => new Map(),
        createAgent: (agent) => {
          const id = `agent-${nextId++}`;
          createdAgents.push({ id, name: agent.name, role: agent.role });
          return id;
        },
      });

      expect(result.created).toEqual(["CEO", "CTO", "Developer"]);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(createdAgents).toHaveLength(3);
    });

    it("skips existing agents on second import (idempotent) (VAL-IMPORT-009)", () => {
      const existingAgents = new Map([
        ["CEO", "existing-ceo-id"],
        ["CTO", "existing-cto-id"],
        ["Developer", "existing-dev-id"],
      ]);

      const createAgent = vi.fn(() => "should-not-be-called");
      const updateAgent = vi.fn();

      const result = importToDb({
        companyId: "company-001",
        importResult: baseImportResult,
        getExistingAgentsByName: () => existingAgents,
        createAgent,
        updateAgent,
      });

      expect(result.created).toEqual([]);
      expect(result.skipped).toEqual(["CEO", "CTO", "Developer"]);
      expect(result.errors).toEqual([]);
      // createAgent should NOT have been called
      expect(createAgent).not.toHaveBeenCalled();
    });

    it("creates only new agents on partial overlap (VAL-IMPORT-009)", () => {
      const existingAgents = new Map([["CEO", "existing-ceo-id"]]);

      let nextId = 1;
      const createdAgents: string[] = [];

      const result = importToDb({
        companyId: "company-001",
        importResult: baseImportResult,
        getExistingAgentsByName: () => existingAgents,
        createAgent: (agent) => {
          const id = `new-agent-${nextId++}`;
          createdAgents.push(agent.name);
          return id;
        },
      });

      expect(result.created).toEqual(["CTO", "Developer"]);
      expect(result.skipped).toEqual(["CEO"]);
      expect(result.errors).toEqual([]);
    });

    it("reports reportsTo resolution errors", () => {
      const importResult: ImportResult = {
        ...baseImportResult,
        agents: [
          {
            name: "Orphan",
            role: "specialist",
            title: "Orphan Agent",
            reportsTo: "NonexistentManager",
            skills: [],
            slug: "orphan",
          },
        ],
      };

      let nextId = 1;
      const updateAgent = vi.fn();

      const result = importToDb({
        companyId: "company-001",
        importResult,
        getExistingAgentsByName: () => new Map(),
        createAgent: () => `agent-${nextId++}`,
        updateAgent,
      });

      expect(result.created).toEqual(["Orphan"]);
      expect(result.errors.some((e) => e.includes("NonexistentManager") && e.includes("not found"))).toBe(true);
    });

    it("handles createAgent throwing an error", () => {
      const result = importToDb({
        companyId: "company-001",
        importResult: {
          ...baseImportResult,
          agents: [
            {
              name: "FailAgent",
              role: "specialist",
              title: "Failing Agent",
              reportsTo: null,
              skills: [],
              slug: "fail-agent",
            },
          ],
        },
        getExistingAgentsByName: () => new Map(),
        createAgent: () => {
          throw new Error("DB constraint violation");
        },
      });

      expect(result.created).toEqual([]);
      expect(result.errors.some((e) => e.includes("DB constraint violation"))).toBe(true);
    });

    it("handles empty agents list", () => {
      const result = importToDb({
        companyId: "company-001",
        importResult: {
          ...baseImportResult,
          agents: [],
        },
        getExistingAgentsByName: () => new Map(),
        createAgent: () => "should-not-be-called",
      });

      expect(result.created).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("preserves reportsTo hierarchy after import (VAL-IMPORT-005)", () => {
      const agentIds = new Map<string, string>();
      let nextId = 1;
      const updateAgent = vi.fn();

      importToDb({
        companyId: "company-001",
        importResult: baseImportResult,
        getExistingAgentsByName: () => new Map(),
        createAgent: (agent) => {
          const id = `agent-${nextId++}`;
          agentIds.set(agent.name, id);
          return id;
        },
        updateAgent,
      });

      // After import, the agent IDs should be tracked for reportsTo resolution
      expect(agentIds.has("CEO")).toBe(true);
      expect(agentIds.has("CTO")).toBe(true);
      expect(agentIds.has("Developer")).toBe(true);
    });

    it("resolves reportsTo by directory slug when slug != display name", () => {
      // This is the key test for the reportsTo bug fix:
      // reportsTo uses directory slugs (e.g. "ceo", "cto") but display names differ
      const slugImportResult: ImportResult = {
        company: { name: "Slug Co", description: "Test", goals: [] },
        agents: [
          {
            name: "CEO Agent",
            role: "executive",
            title: "Chief Executive Officer",
            reportsTo: null,
            skills: [],
            slug: "ceo",
          },
          {
            name: "CTO Agent",
            role: "engineering",
            title: "Chief Technology Officer",
            reportsTo: "ceo", // Uses slug, not display name "CEO Agent"
            skills: [],
            slug: "cto",
          },
          {
            name: "QA Engineer",
            role: "quality",
            title: "QA Engineer",
            reportsTo: "cto", // Uses slug, not display name "CTO Agent"
            skills: [],
            slug: "qa-engineer",
          },
        ],
        skills: [],
        errors: [],
      };

      let nextId = 1;
      const updateAgent = vi.fn();

      const result = importToDb({
        companyId: "company-001",
        importResult: slugImportResult,
        getExistingAgentsByName: () => new Map(),
        createAgent: () => `agent-${nextId++}`,
        updateAgent,
      });

      // All agents should be created without errors
      expect(result.created).toEqual(["CEO Agent", "CTO Agent", "QA Engineer"]);
      expect(result.errors).toEqual([]);

      // updateAgent should have been called for agents with reportsTo
      // (CTO reports to ceo slug, QA reports to cto slug)
      expect(updateAgent).toHaveBeenCalledTimes(2);
    });

    it("resolves reportsTo via case-insensitive name fallback", () => {
      const caseImportResult: ImportResult = {
        company: { name: "Case Co", description: "Test", goals: [] },
        agents: [
          {
            name: "CEO Agent",
            role: "executive",
            title: "Chief Executive Officer",
            reportsTo: null,
            skills: [],
            slug: "ceo",
          },
          {
            name: "CTO Agent",
            role: "engineering",
            title: "Chief Technology Officer",
            reportsTo: "ceo agent", // lowercase version of display name
            skills: [],
            slug: "cto",
          },
        ],
        skills: [],
        errors: [],
      };

      let nextId = 1;
      const updateAgent = vi.fn();

      const result = importToDb({
        companyId: "company-001",
        importResult: caseImportResult,
        getExistingAgentsByName: () => new Map(),
        createAgent: () => `agent-${nextId++}`,
        updateAgent,
      });

      expect(result.created).toEqual(["CEO Agent", "CTO Agent"]);
      // No errors: "ceo agent" should match "CEO Agent" via case-insensitive fallback
      expect(result.errors).toEqual([]);
      expect(updateAgent).toHaveBeenCalledTimes(1);
    });

    it("slug resolution takes priority over name resolution", () => {
      // Edge case: slug matches a different agent than name would
      const priorityImportResult: ImportResult = {
        company: { name: "Priority Co", description: "Test", goals: [] },
        agents: [
          {
            name: "Alpha",
            role: "lead",
            title: "Alpha Lead",
            reportsTo: null,
            skills: [],
            slug: "alpha",
          },
          {
            name: "Beta",
            role: "lead",
            title: "Beta Lead",
            reportsTo: null,
            skills: [],
            slug: "beta",
          },
          {
            name: "Worker",
            role: "dev",
            title: "Developer",
            reportsTo: "alpha", // slug lookup should find Alpha
            skills: [],
            slug: "worker",
          },
        ],
        skills: [],
        errors: [],
      };

      let nextId = 1;
      const createdIds: Record<string, string> = {};
      const updateCalls: Array<{ agentId: string }> = [];

      const result = importToDb({
        companyId: "company-001",
        importResult: priorityImportResult,
        getExistingAgentsByName: () => new Map(),
        createAgent: (agent) => {
          const id = `agent-${nextId++}`;
          createdIds[agent.name] = id;
          return id;
        },
        updateAgent: (agentId) => {
          updateCalls.push({ agentId });
        },
      });

      expect(result.created).toEqual(["Alpha", "Beta", "Worker"]);
      expect(result.errors).toEqual([]);
      // Worker's reportsTo "alpha" should resolve via slug to Alpha's ID
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.agentId).toBe(createdIds["Worker"]);
    });

    it("import result has agent count equal after two imports (VAL-IMPORT-009)", () => {
      const db = new Map<string, { id: string; name: string }>();
      let nextId = 1;

      const doImport = () => {
        const existingByName = new Map<string, string>();
        for (const [, agent] of db) {
          existingByName.set(agent.name, agent.id);
        }

        return importToDb({
          companyId: "company-001",
          importResult: baseImportResult,
          getExistingAgentsByName: () => existingByName,
          createAgent: (agent) => {
            const id = `agent-${nextId++}`;
            db.set(id, { id, name: agent.name });
            return id;
          },
        });
      };

      // First import
      const first = doImport();
      expect(first.created).toHaveLength(3);
      expect(db.size).toBe(3);

      // Second import (idempotent)
      const second = doImport();
      expect(second.created).toHaveLength(0);
      expect(second.skipped).toHaveLength(3);
      expect(db.size).toBe(3); // Same count — no duplicates
    });
  });
});
