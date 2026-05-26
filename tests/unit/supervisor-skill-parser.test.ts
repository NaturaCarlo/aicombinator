import { describe, expect, it } from "vitest";
import {
  parsePaperclipSkill,
  parseClaudeSkill,
  parseGenericSkill,
  parseSkillFiles,
  type SkillDescriptor,
  type GenericSkillInput,
} from "../../supervisor/src/importers/skills.ts";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const PAPERCLIP_SKILL_MD = `---
name: Code Review
description: Automated code review skill for pull requests
---
# Code Review Instructions

When reviewing code:
1. Check for bugs
2. Check for security issues
3. Suggest improvements
`;

const PAPERCLIP_SKILL_NO_DESCRIPTION = `---
name: Testing Expert
---
# Testing Instructions

Write comprehensive unit tests for all code changes.
`;

const PAPERCLIP_SKILL_NO_FRONTMATTER = `# Plain Markdown Skill

This skill file has no YAML frontmatter.
Just plain markdown instructions.
`;

const CLAUDE_SKILL_MD = `# Database Migration Helper

Helps with database schema migrations and data transformations.

## Usage

When working with database changes:
1. Always create reversible migrations
2. Test with sample data first
3. Document schema changes
`;

const CLAUDE_SKILL_SIMPLE = `Simple skill with no heading.

Just some instructions.
`;

// ---------------------------------------------------------------------------
// Paperclip format (VAL-SKILL-001)
// ---------------------------------------------------------------------------

describe("parsePaperclipSkill", () => {
  it("parses skill with full YAML frontmatter", () => {
    const result = parsePaperclipSkill("code-review", PAPERCLIP_SKILL_MD);
    expect(result.slug).toBe("code-review");
    expect(result.name).toBe("Code Review");
    expect(result.description).toBe("Automated code review skill for pull requests");
    expect(result.instructions).toContain("Check for bugs");
    expect(result.instructions).toContain("Suggest improvements");
  });

  it("returns correct slug and non-empty instructions (VAL-SKILL-001)", () => {
    const result = parsePaperclipSkill("my-skill", PAPERCLIP_SKILL_MD);
    expect(result.slug).toBe("my-skill");
    expect(result.instructions.length).toBeGreaterThan(0);
  });

  it("handles missing description in frontmatter", () => {
    const result = parsePaperclipSkill("testing", PAPERCLIP_SKILL_NO_DESCRIPTION);
    expect(result.slug).toBe("testing");
    expect(result.name).toBe("Testing Expert");
    expect(result.description).toBe("");
    expect(result.instructions).toContain("unit tests");
  });

  it("handles file with no frontmatter", () => {
    const result = parsePaperclipSkill("plain-skill", PAPERCLIP_SKILL_NO_FRONTMATTER);
    expect(result.slug).toBe("plain-skill");
    expect(result.name).toBe("Plain Skill");
    expect(result.description).toBe("");
    expect(result.instructions).toContain("no YAML frontmatter");
  });

  it("normalizes slug to lowercase with hyphens", () => {
    const result = parsePaperclipSkill("My_Awesome SKILL", PAPERCLIP_SKILL_MD);
    expect(result.slug).toBe("my-awesome-skill");
  });

  it("handles empty content", () => {
    const result = parsePaperclipSkill("empty", "");
    expect(result.slug).toBe("empty");
    expect(result.name).toBe("Empty");
    expect(result.instructions).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Claude .claude/skills/ format (VAL-SKILL-002)
// ---------------------------------------------------------------------------

describe("parseClaudeSkill", () => {
  it("parses skill from .claude/skills/ path format", () => {
    const result = parseClaudeSkill("db-migrations.md", CLAUDE_SKILL_MD);
    expect(result.slug).toBe("db-migrations");
    expect(result.name).toBe("Database Migration Helper");
    expect(result.description).toContain("database schema migrations");
    expect(result.instructions).toContain("reversible migrations");
  });

  it("returns correct slug from .claude/skills/ path (VAL-SKILL-002)", () => {
    const result = parseClaudeSkill("review.md", CLAUDE_SKILL_MD);
    expect(result.slug).toBe("review");
    expect(result.instructions.length).toBeGreaterThan(0);
  });

  it("handles file without heading", () => {
    const result = parseClaudeSkill("simple-skill.md", CLAUDE_SKILL_SIMPLE);
    expect(result.slug).toBe("simple-skill");
    expect(result.name).toBe("Simple Skill");
    expect(result.instructions).toContain("Just some instructions");
  });

  it("strips .md extension from filename for slug", () => {
    const result = parseClaudeSkill("Code_Review.MD", CLAUDE_SKILL_MD);
    expect(result.slug).toBe("code-review");
  });

  it("handles empty content", () => {
    const result = parseClaudeSkill("empty.md", "");
    expect(result.slug).toBe("empty");
    expect(result.name).toBe("Empty");
    expect(result.instructions).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Generic skill descriptor
// ---------------------------------------------------------------------------

describe("parseGenericSkill", () => {
  it("normalizes a generic descriptor object", () => {
    const input: GenericSkillInput = {
      name: "API Testing",
      description: "Test REST APIs",
      instructions: "Use curl or httpie to test endpoints.",
    };
    const result = parseGenericSkill(input);
    expect(result.slug).toBe("api-testing");
    expect(result.name).toBe("API Testing");
    expect(result.description).toBe("Test REST APIs");
    expect(result.instructions).toBe("Use curl or httpie to test endpoints.");
  });

  it("uses provided slug if given", () => {
    const input: GenericSkillInput = {
      name: "My Skill",
      slug: "custom-slug",
      instructions: "Do things.",
    };
    const result = parseGenericSkill(input);
    expect(result.slug).toBe("custom-slug");
  });

  it("generates slug from name when slug not provided", () => {
    const input: GenericSkillInput = {
      name: "Advanced Code Review",
      instructions: "Review code carefully.",
    };
    const result = parseGenericSkill(input);
    expect(result.slug).toBe("advanced-code-review");
  });

  it("defaults description to empty string", () => {
    const input: GenericSkillInput = {
      name: "Minimal",
      instructions: "Just do it.",
    };
    const result = parseGenericSkill(input);
    expect(result.description).toBe("");
  });

  it("trims whitespace from all fields", () => {
    const input: GenericSkillInput = {
      name: "  Spacey Skill  ",
      description: "  Has spaces  ",
      instructions: "  Also spaced  ",
    };
    const result = parseGenericSkill(input);
    expect(result.name).toBe("Spacey Skill");
    expect(result.description).toBe("Has spaces");
    expect(result.instructions).toBe("Also spaced");
  });
});

// ---------------------------------------------------------------------------
// Batch parser — auto-detects format by path
// ---------------------------------------------------------------------------

describe("parseSkillFiles", () => {
  it("detects Paperclip format from skills/<slug>/SKILL.md path", () => {
    const results = parseSkillFiles([
      { path: "skills/code-review/SKILL.md", content: PAPERCLIP_SKILL_MD },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.slug).toBe("code-review");
    expect(results[0]!.name).toBe("Code Review");
  });

  it("detects Claude format from .claude/skills/*.md path", () => {
    const results = parseSkillFiles([
      { path: ".claude/skills/db-migrations.md", content: CLAUDE_SKILL_MD },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.slug).toBe("db-migrations");
    expect(results[0]!.name).toBe("Database Migration Helper");
  });

  it("handles mixed formats in single batch", () => {
    const results = parseSkillFiles([
      { path: "skills/review/SKILL.md", content: PAPERCLIP_SKILL_MD },
      { path: ".claude/skills/helper.md", content: CLAUDE_SKILL_MD },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.slug).toBe("review");
    expect(results[1]!.slug).toBe("helper");
  });

  it("handles empty input array", () => {
    const results = parseSkillFiles([]);
    expect(results).toHaveLength(0);
  });

  it("falls back to Paperclip-style parse for unknown paths", () => {
    const results = parseSkillFiles([
      { path: "custom/location/my-skill.md", content: PAPERCLIP_SKILL_MD },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.slug).toBe("my-skill");
    expect(results[0]!.name).toBe("Code Review"); // from frontmatter
  });

  it("handles backslash paths (Windows)", () => {
    const results = parseSkillFiles([
      { path: "skills\\deploy\\SKILL.md", content: PAPERCLIP_SKILL_NO_DESCRIPTION },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.slug).toBe("deploy");
  });
});

// ---------------------------------------------------------------------------
// Skill prompt injection (VAL-SKILL-004)
// ---------------------------------------------------------------------------

describe("skill prompt injection", () => {
  it("build_task_prompt includes skill instructions when skills are provided", async () => {
    // We import dynamically to avoid heavy agent-runner dependency issues
    const { build_task_prompt } = await import("../../supervisor/src/agent-runner.ts");

    const mockAgent = {
      id: "agent-1",
      company_id: "comp-1",
      blueprint_id: "frontend-dev",
      name: "Frontend Dev",
      role: "developer",
      title: "Frontend Developer",
      model_tier: "sonnet",
      status: "working",
      reports_to: null,
      session_id: null,
      current_task_id: "task-1",
      total_credits: 100,
      total_credits_consumed: 0,
      last_wake_at: null,
      last_sleep_at: null,
      department: "engineering",
      email_address: null,
      metadata: null,
      icon: null,
      webhook_url: null,
      adapter_type: null,
      source: "internal",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };

    const mockTask = {
      id: "task-1",
      company_id: "comp-1",
      milestone_id: "ms-1",
      title: "Build landing page",
      description: "Create a landing page",
      acceptance_criteria: JSON.stringify([{ type: "file_exists", path: "/workspace/site/index.html" }]),
      depends_on: "[]",
      owner_agent_id: "agent-1",
      status: "in_progress",
      blocked_reason: null,
      artifact: null,
      credits_spent: 0,
      turns_spent: 0,
      parent_task_id: null,
      created_by: "ceo-1",
      created_at: "2024-01-01T00:00:00Z",
      started_at: "2024-01-01T00:00:00Z",
      completed_at: null,
    };

    const mockTaskManager = {
      get_task: () => undefined,
      get_agent: () => undefined,
      get_milestones: () => [],
      get_tasks: () => [],
    };

    const skills = [
      {
        skill_slug: "code-review",
        name: "Code Review",
        description: "Review code for quality",
        instructions: "Always check for security vulnerabilities.",
      },
      {
        skill_slug: "testing",
        name: "Testing Expert",
        description: "",
        instructions: "Write comprehensive unit tests.",
      },
    ];

    const prompt = build_task_prompt(
      mockAgent as never,
      mockTask as never,
      mockTaskManager as never,
      "/workspace",
      skills,
    );

    // VAL-SKILL-004: Built prompt contains skill instruction text
    expect(prompt).toContain("# Agent Skills");
    expect(prompt).toContain("Code Review");
    expect(prompt).toContain("Always check for security vulnerabilities.");
    expect(prompt).toContain("Testing Expert");
    expect(prompt).toContain("Write comprehensive unit tests.");
  });

  it("build_task_prompt omits skills section when no skills provided", async () => {
    const { build_task_prompt } = await import("../../supervisor/src/agent-runner.ts");

    const mockAgent = {
      id: "agent-1",
      company_id: "comp-1",
      blueprint_id: "frontend-dev",
      name: "Frontend Dev",
      role: "developer",
      title: "Frontend Developer",
      model_tier: "sonnet",
      status: "working",
      reports_to: null,
      session_id: null,
      current_task_id: "task-1",
      total_credits: 100,
      total_credits_consumed: 0,
      last_wake_at: null,
      last_sleep_at: null,
      department: "engineering",
      email_address: null,
      metadata: null,
      icon: null,
      webhook_url: null,
      adapter_type: null,
      source: "internal",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };

    const mockTask = {
      id: "task-1",
      company_id: "comp-1",
      milestone_id: "ms-1",
      title: "Build landing page",
      description: "Create a landing page",
      acceptance_criteria: JSON.stringify([{ type: "file_exists", path: "/workspace/site/index.html" }]),
      depends_on: "[]",
      owner_agent_id: "agent-1",
      status: "in_progress",
      blocked_reason: null,
      artifact: null,
      credits_spent: 0,
      turns_spent: 0,
      parent_task_id: null,
      created_by: "ceo-1",
      created_at: "2024-01-01T00:00:00Z",
      started_at: "2024-01-01T00:00:00Z",
      completed_at: null,
    };

    const mockTaskManager = {
      get_task: () => undefined,
      get_agent: () => undefined,
      get_milestones: () => [],
      get_tasks: () => [],
    };

    const prompt = build_task_prompt(
      mockAgent as never,
      mockTask as never,
      mockTaskManager as never,
      "/workspace",
      [],
    );

    expect(prompt).not.toContain("# Agent Skills");
  });
});
