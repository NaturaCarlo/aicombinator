import { describe, expect, it } from "vitest";

import {
  buildAutonomousCronPlans,
  buildAutonomousCronSpec,
  buildAutonomousWakePrompt,
} from "../../worker/src/routes/companies.ts";

describe("company autonomy scheduling", () => {
  it("assigns the expected cadence by founding role", () => {
    expect(buildAutonomousCronSpec({ blueprint_id: "ceo" } as any)).toEqual({
      schedule: "*/12 * * * *",
      firstDelayMinutes: 2,
    });
    expect(buildAutonomousCronSpec({ blueprint_id: "cto" } as any)).toEqual({
      schedule: "1-59/12 * * * *",
      firstDelayMinutes: 3,
    });
    expect(buildAutonomousCronSpec({ blueprint_id: "cmo" } as any)).toEqual({
      schedule: "2-59/12 * * * *",
      firstDelayMinutes: 4,
    });
    expect(buildAutonomousCronSpec({ blueprint_id: "frontend-dev" } as any)).toEqual({
      schedule: "*/15 * * * *",
      firstDelayMinutes: 3,
    });
  });

  it("builds recurring prompts that continue execution instead of restarting kickoff", () => {
    const prompt = buildAutonomousWakePrompt(
      "TestCo",
      "Build an autonomous logistics company.",
      {
        id: "agent-1",
        name: "Avery Morales",
        title: "Chief Executive Officer",
        role: "ceo",
        blueprint_id: "ceo",
        icon: null,
        last_wake_at: null,
      },
    );

    expect(prompt).toContain("continuing day-zero execution for TestCo");
    expect(prompt).toContain("/workspace/docs/plan.md");
    expect(prompt).toContain("/workspace/docs/execution-contract.json");
    expect(prompt).toContain("Advance one concrete deliverable for your role and leave a real artifact in /workspace.");
    expect(prompt).toContain("Do not assume the landing page is the first priority unless the CEO chose it.");
  });

  it("creates one recurring cron plan per founding agent", () => {
    const now = new Date("2026-03-07T23:30:00.000Z");
    const plans = buildAutonomousCronPlans(
      "TestCo",
      "Build an autonomous logistics company.",
      [
        {
          id: "ceo-1",
          name: "Avery Morales",
          title: "Chief Executive Officer",
          role: "ceo",
          blueprint_id: "ceo",
          icon: null,
          last_wake_at: null,
        },
        {
          id: "cto-1",
          name: "Nina Park",
          title: "Chief Technology Officer",
          role: "cto",
          blueprint_id: "cto",
          icon: null,
          last_wake_at: null,
        },
      ] as any,
      now,
    );

    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({
      agentId: "ceo-1",
      schedule: "*/12 * * * *",
    });
    expect(plans[0].nextRunAt).toBe("2026-03-07T23:32:00.000Z");
    expect(plans[1]).toMatchObject({
      agentId: "cto-1",
      schedule: "1-59/12 * * * *",
    });
    expect(plans[1].nextRunAt).toBe("2026-03-07T23:33:00.000Z");
  });
});
