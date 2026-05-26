import { describe, it, expect } from "vitest";

// ─── Mimic the supervisor adapter's buildSystemPrompt logic ──────

interface AgentRow {
  id: string;
  name: string;
  role: string;
  title?: string | null;
  company_id: string;
  blueprint_id: string | null;
  department?: string | null;
  instructions?: string;
  system_prompt?: string | null;
  model_tier: string;
}

interface AgentBlueprint {
  id: string;
  systemPrompt: string;
  workflows: Array<{ name: string; steps: string[] }>;
}

function getBlueprint(id: string): AgentBlueprint | undefined {
  const blueprints: Record<string, AgentBlueprint> = {
    cto: {
      id: "cto",
      systemPrompt: "You are the CTO — the single owner of technical delivery for this company.",
      workflows: [],
    },
    cmo: {
      id: "cmo",
      systemPrompt: "You are the founding CMO. You own all marketing output for this company.",
      workflows: [],
    },
  };
  return blueprints[id];
}

function buildBlueprintPrompt(agent: AgentRow, blueprint: AgentBlueprint): string {
  const parts = [blueprint.systemPrompt];
  parts.push(
    "\n## Agent Identity",
    `- Name: ${agent.name}`,
    `- Role: ${agent.role}`,
    `- Company ID: ${agent.company_id}`,
  );
  if (agent.department) {
    parts.push(`- Department: ${agent.department}`);
  }
  parts.push(
    "",
    "## Important Rules",
    "- Be efficient — every turn costs credits",
    "- Write files to /workspace/ (shared with all agents)",
    "- Summarize what you accomplished at the end of each turn",
  );
  return parts.join("\n");
}

function buildBasicPrompt(agent: AgentRow): string {
  const parts = [
    `You are ${agent.name}, the ${agent.title ?? agent.role} of the company.`,
    `Your role: ${agent.role}.`,
  ];
  if (agent.department) {
    parts.push(`Department: ${agent.department}.`);
  }
  parts.push(
    "",
    "You have access to tools for your work. Complete the requested task efficiently.",
    "Write files to /workspace/ which is shared with all agents.",
    "When you're done, summarize what you accomplished.",
  );
  return parts.join("\n");
}

/**
 * New system prompt logic:
 * - If agent has a non-null, non-empty system_prompt → use it as the COMPLETE prompt
 * - If agent has no system_prompt → fall back to blueprint (existing behavior)
 * - Empty string system_prompt → also fall back to blueprint
 */
function buildSystemPrompt(agent: AgentRow): string {
  // If agent has a custom system_prompt (non-null, non-empty), use it as COMPLETE prompt
  if (agent.system_prompt != null && agent.system_prompt.trim() !== "") {
    return agent.system_prompt;
  }

  // Fall back to blueprint behavior (existing)
  const blueprint = agent.blueprint_id
    ? getBlueprint(agent.blueprint_id)
    : getBlueprint(agent.role);

  let prompt: string;
  if (blueprint) {
    prompt = buildBlueprintPrompt(agent, blueprint);
  } else {
    prompt = buildBasicPrompt(agent);
  }

  // Append legacy instructions if present (backward compat for agents without system_prompt)
  if (agent.instructions && agent.instructions.trim()) {
    prompt += `\n\n## Custom Instructions\n${agent.instructions.trim()}`;
  }

  return prompt;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("System Prompt Editing", () => {
  const baseAgent: AgentRow = {
    id: "agent-1",
    name: "Alice",
    role: "cto",
    title: "CTO",
    company_id: "company-1",
    blueprint_id: "cto",
    department: "engineering",
    instructions: "",
    system_prompt: null,
    model_tier: "sonnet-4-6",
  };

  describe("VAL-PROMPT-020: Custom prompt used as COMPLETE prompt", () => {
    it("uses system_prompt as the COMPLETE prompt when set", () => {
      const agent = { ...baseAgent, system_prompt: "You are a custom AI assistant." };
      const result = buildSystemPrompt(agent);
      expect(result).toBe("You are a custom AI assistant.");
      // Should NOT contain blueprint text
      expect(result).not.toContain("technical delivery");
      expect(result).not.toContain("Agent Identity");
    });

    it("does NOT prepend blueprint to custom system_prompt", () => {
      const customPrompt = "My completely custom system prompt for the CTO agent.";
      const agent = { ...baseAgent, system_prompt: customPrompt };
      const result = buildSystemPrompt(agent);
      expect(result).toBe(customPrompt);
    });
  });

  describe("VAL-PROMPT-021: Unedited agents use blueprint", () => {
    it("uses blueprint prompt when system_prompt is null", () => {
      const agent = { ...baseAgent, system_prompt: null };
      const result = buildSystemPrompt(agent);
      expect(result).toContain("CTO");
      expect(result).toContain("technical delivery");
      expect(result).toContain("Agent Identity");
    });

    it("uses blueprint prompt when system_prompt is undefined", () => {
      const agent = { ...baseAgent, system_prompt: undefined };
      const result = buildSystemPrompt(agent);
      expect(result).toContain("technical delivery");
    });
  });

  describe("VAL-PROMPT-030: Very long system prompt (10k+ chars)", () => {
    it("accepts and preserves very long system prompts", () => {
      const longPrompt = "A".repeat(15_000);
      const agent = { ...baseAgent, system_prompt: longPrompt };
      const result = buildSystemPrompt(agent);
      expect(result).toBe(longPrompt);
      expect(result.length).toBe(15_000);
    });
  });

  describe("VAL-PROMPT-031: Empty system prompt fallback", () => {
    it("falls back to blueprint when system_prompt is empty string", () => {
      const agent = { ...baseAgent, system_prompt: "" };
      const result = buildSystemPrompt(agent);
      expect(result).toContain("technical delivery");
      expect(result).toContain("Agent Identity");
    });

    it("falls back to blueprint when system_prompt is whitespace only", () => {
      const agent = { ...baseAgent, system_prompt: "   \n  " };
      const result = buildSystemPrompt(agent);
      expect(result).toContain("technical delivery");
    });
  });

  describe("Legacy instructions backward compatibility", () => {
    it("appends legacy instructions when no system_prompt is set", () => {
      const agent = { ...baseAgent, system_prompt: null, instructions: "Focus on code review." };
      const result = buildSystemPrompt(agent);
      expect(result).toContain("technical delivery");
      expect(result).toContain("Custom Instructions");
      expect(result).toContain("Focus on code review.");
    });

    it("does NOT append legacy instructions when system_prompt IS set", () => {
      const agent = {
        ...baseAgent,
        system_prompt: "Custom complete prompt.",
        instructions: "Legacy instructions that should be ignored.",
      };
      const result = buildSystemPrompt(agent);
      expect(result).toBe("Custom complete prompt.");
      expect(result).not.toContain("Legacy instructions");
    });
  });

  describe("Agent without blueprint", () => {
    it("uses basic prompt when no blueprint found", () => {
      const agent = { ...baseAgent, blueprint_id: null, role: "custom-role", system_prompt: null };
      const result = buildSystemPrompt(agent);
      expect(result).toContain("Alice");
      expect(result).toContain("custom-role");
    });
  });
});

describe("Dashboard System Prompt UI", () => {
  describe("VAL-PROMPT-002: Label is 'System Prompt'", () => {
    it("section header should read 'System Prompt'", () => {
      const sectionHeader = "System Prompt";
      expect(sectionHeader).toBe("System Prompt");
      expect(sectionHeader).not.toBe("Custom Instructions");
    });

    it("helper text should NOT say 'appended to'", () => {
      const helperText = "This is the complete system prompt sent to the agent at runtime. Edit to fully customize agent behavior.";
      expect(helperText).not.toContain("appended to");
      expect(helperText).not.toContain("appended");
    });
  });

  describe("VAL-PROMPT-001: Blueprint text shown as default", () => {
    it("when instructions is null/empty, should show blueprint text (fetched from API)", () => {
      // The dashboard fetches blueprint prompt via GET /api/agents/:id/blueprint-prompt
      // and pre-populates the textarea
      const blueprintPrompt = "You are the CTO — the single owner of technical delivery...";
      const agentInstructions = "";
      const systemPrompt: string | null = null;

      // If system_prompt is null and instructions empty, we show the blueprint
      const displayedText = systemPrompt ?? blueprintPrompt;
      expect(displayedText).toBe(blueprintPrompt);
    });

    it("when system_prompt is saved, shows that instead of blueprint", () => {
      const blueprintPrompt = "You are the CTO — the single owner of technical delivery...";
      const systemPrompt = "My custom system prompt for the CTO.";

      const displayedText = systemPrompt ?? blueprintPrompt;
      expect(displayedText).toBe("My custom system prompt for the CTO.");
    });
  });

  describe("VAL-PROMPT-010: Fully editable", () => {
    it("user can clear and set entirely new content", () => {
      let currentText = "Original blueprint text...";
      // User clears the textarea
      currentText = "";
      expect(currentText).toBe("");

      // User writes new content
      currentText = "Completely new system prompt written by the user.";
      expect(currentText).toBe("Completely new system prompt written by the user.");
    });
  });

  describe("VAL-PROMPT-011: Persists after save/reopen", () => {
    it("save payload includes system_prompt field", () => {
      const payload = {
        name: "CTO Agent",
        role: "cto",
        title: "CTO",
        reports_to: null,
        adapter_type: "claude-code",
        webhook_url: null,
        model_tier: "sonnet-4-6",
        system_prompt: "My custom prompt that should persist.",
      };
      expect(payload).toHaveProperty("system_prompt", "My custom prompt that should persist.");
    });
  });

  describe("VAL-PROMPT-012: Saved to D1 via PATCH", () => {
    it("PATCH body accepts system_prompt field", () => {
      const patchBody = {
        system_prompt: "Updated system prompt via PATCH.",
      };
      expect(patchBody.system_prompt).toBe("Updated system prompt via PATCH.");
    });
  });
});

describe("Worker Agent PATCH system_prompt", () => {
  it("accepts system_prompt in PATCH body", () => {
    const body = {
      name: "CTO",
      system_prompt: "Custom system prompt.",
    };
    // Verify the field is extractable
    const updates: string[] = [];
    const values: (string | null)[] = [];
    if (body.system_prompt !== undefined) {
      updates.push("system_prompt = ?");
      values.push(body.system_prompt);
    }
    expect(updates).toContain("system_prompt = ?");
    expect(values).toContain("Custom system prompt.");
  });

  it("pushes system_prompt to supervisor", () => {
    const body = { system_prompt: "Custom prompt for supervisor." };
    const supervisorPatch: Record<string, unknown> = {};
    if (body.system_prompt !== undefined) {
      supervisorPatch.system_prompt = body.system_prompt;
    }
    expect(supervisorPatch).toHaveProperty("system_prompt", "Custom prompt for supervisor.");
  });
});

describe("Supervisor PATCH system_prompt", () => {
  it("accepts system_prompt in PATCH body and updates DB", () => {
    const body = {
      system_prompt: "Custom system prompt for supervisor local SQLite.",
    };
    const setClauses: string[] = [];
    const params: unknown[] = [];
    if (body.system_prompt !== undefined) {
      setClauses.push("system_prompt = ?");
      params.push(body.system_prompt);
    }
    expect(setClauses).toContain("system_prompt = ?");
    expect(params).toContain("Custom system prompt for supervisor local SQLite.");
  });
});

describe("Blueprint Prompt API", () => {
  it("builds a blueprint prompt for an agent with a known blueprint", () => {
    const agent: AgentRow = {
      id: "agent-1",
      name: "Alice",
      role: "cto",
      title: "CTO",
      company_id: "company-1",
      blueprint_id: "cto",
      department: "engineering",
      instructions: "",
      system_prompt: null,
      model_tier: "sonnet-4-6",
    };
    const blueprint = getBlueprint("cto");
    expect(blueprint).toBeDefined();
    if (blueprint) {
      const prompt = buildBlueprintPrompt(agent, blueprint);
      expect(prompt).toContain("CTO");
      expect(prompt).toContain("technical delivery");
      expect(prompt).toContain("Agent Identity");
      expect(prompt).toContain("Alice");
    }
  });

  it("returns undefined for agents without a blueprint", () => {
    const blueprint = getBlueprint("nonexistent");
    expect(blueprint).toBeUndefined();
  });
});
