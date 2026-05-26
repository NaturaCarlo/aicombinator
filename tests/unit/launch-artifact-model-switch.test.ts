import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../worker/src/types.ts";
import type { LaunchSessionBrief } from "../../worker/src/provisioning/launch-session.ts";

// We test generateLaunchArtifacts by intercepting global.fetch to verify
// which provider/model it calls. No mocking of the module itself.
const fetchSpy = vi.spyOn(globalThis, "fetch");

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ANTHROPIC_API_KEY: "",
    OPENROUTER_API_KEY: "",
    FRONTEND_URL: "https://aicombinator.live",
    // Remaining fields are not used by generateLaunchArtifacts
    AUTOMATON_KV: {} as unknown as KVNamespace,
    DB: {} as unknown as D1Database,
    ENVIRONMENT: "test",
    BASE_RPC_URL: "",
    WORKER_API_URL: "",
    CLERK_SECRET_KEY: "",
    CLERK_WEBHOOK_SECRET: "",
    AGENTMAIL_API_KEY: "",
    BROWSERBASE_API_KEY: "",
    BROWSERBASE_PROJECT_ID: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    SUPERVISOR_API_KEY: "",
    SUPERVISOR_URL: "",
    SHARED_SUPERVISOR_URL: "",
    BROWSERBASE_FUNCTION_ID: "",
    ADMIN_USER_IDS: "",
    GEMINI_API_KEY: "",
    PORKBUN_API_KEY: "",
    PORKBUN_SECRET_API_KEY: "",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
    CLOUDFLARE_DASHBOARD_SCRIPT_NAME: "",
    HETZNER_API_TOKEN: "",
    ...overrides,
  } as Env;
}

const sampleBrief: LaunchSessionBrief = {
  concept: "AI roofing lead gen",
  targetCustomer: "roofing companies in Texas",
  painfulProblem: "They lose leads from missed calls",
  firstOffer: "AI lead intake and booking for roofers",
  whyNow: "AI can now handle phone calls reliably",
  businessModel: "Monthly retainer per location",
  distributionWedge: "Cold email to roofing company owners",
  founderConstraints: [],
  autonomyBoundaries: ["Team may refine messaging without asking founder"],
  founderSetupTasks: ["Create Stripe account"],
  nonGoals: [],
  firstMilestone: "Ship a live site with lead capture",
  openQuestions: [],
  autonomyConfidence: 85,
};

afterEach(() => {
  fetchSpy.mockReset();
});

describe("generateLaunchArtifacts model selection", () => {
  it("uses Anthropic direct API with Sonnet model when ANTHROPIC_API_KEY is set", async () => {
    const { generateLaunchArtifacts } = await import(
      "../../worker/src/provisioning/launch-session.ts"
    );

    // Mock a successful Anthropic Messages API response
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "submit_artifacts",
              input: {
                companySpecMd: "# Company Spec\nTest spec",
                missionMd: "# Mission\nTest mission",
                firstMilestoneMd: "# First Milestone\nTest milestone",
                autonomyContractMd: "# Autonomy Contract\nTest contract",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await generateLaunchArtifacts({
      env: fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-test-key", OPENROUTER_API_KEY: "or-test-key" }),
      companyName: "RoofLeads AI",
      idea: "AI lead gen for roofers",
      brief: sampleBrief,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    // Should call Anthropic directly, not OpenRouter
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(init?.body as string);
    // Should use Sonnet model, not Opus
    expect(body.model).toContain("sonnet");
    expect(body.model).not.toContain("opus");
    expect(body.max_tokens).toBe(5000);
    // Verify the result was parsed correctly
    expect(result.companySpecMd).toContain("Company Spec");
    expect(result.missionMd).toContain("Mission");
  });

  it("falls back to OpenRouter with Sonnet model when only OPENROUTER_API_KEY is set", async () => {
    const { generateLaunchArtifacts } = await import(
      "../../worker/src/provisioning/launch-session.ts"
    );

    // Mock a successful OpenRouter response
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "submit_artifacts",
                      arguments: JSON.stringify({
                        companySpecMd: "# Company Spec\nOR spec",
                        missionMd: "# Mission\nOR mission",
                        firstMilestoneMd: "# First Milestone\nOR milestone",
                        autonomyContractMd: "# Autonomy Contract\nOR contract",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await generateLaunchArtifacts({
      env: fakeEnv({ OPENROUTER_API_KEY: "or-test-key" }),
      companyName: "RoofLeads AI",
      idea: "AI lead gen for roofers",
      brief: sampleBrief,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    // Should call OpenRouter
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(init?.body as string);
    // Should use Sonnet model via OpenRouter, not Opus
    expect(body.model).toContain("sonnet");
    expect(body.model).not.toContain("opus");
    expect(body.max_tokens).toBe(5000);
    expect(result.companySpecMd).toContain("OR spec");
  });

  it("returns fallback artifacts when no API key is configured", async () => {
    const { generateLaunchArtifacts } = await import(
      "../../worker/src/provisioning/launch-session.ts"
    );

    const result = await generateLaunchArtifacts({
      env: fakeEnv(),
      companyName: "RoofLeads AI",
      idea: "AI lead gen for roofers",
      brief: sampleBrief,
    });

    // No fetch calls should be made
    expect(fetchSpy).not.toHaveBeenCalled();
    // Fallback artifacts should contain company name
    expect(result.companySpecMd).toContain("RoofLeads AI");
    expect(result.missionMd).toBeTruthy();
  });

  it("prefers Anthropic direct over OpenRouter when both keys are set", async () => {
    const { generateLaunchArtifacts } = await import(
      "../../worker/src/provisioning/launch-session.ts"
    );

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "submit_artifacts",
              input: {
                companySpecMd: "# Anthropic Spec",
                missionMd: "# Anthropic Mission",
                firstMilestoneMd: "# Anthropic Milestone",
                autonomyContractMd: "# Anthropic Contract",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await generateLaunchArtifacts({
      env: fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-key", OPENROUTER_API_KEY: "or-key" }),
      companyName: "Test Co",
      idea: "Test idea",
      brief: sampleBrief,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    // Must prefer Anthropic direct
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("uses correct Anthropic API headers and tool format", async () => {
    const { generateLaunchArtifacts } = await import(
      "../../worker/src/provisioning/launch-session.ts"
    );

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "submit_artifacts",
              input: {
                companySpecMd: "spec",
                missionMd: "mission",
                firstMilestoneMd: "milestone",
                autonomyContractMd: "contract",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await generateLaunchArtifacts({
      env: fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }),
      companyName: "Test",
      idea: "Test idea",
      brief: sampleBrief,
    });

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    // Anthropic API uses x-api-key header
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // Anthropic tools use input_schema, not parameters
    const body = JSON.parse(init?.body as string);
    expect(body.tools[0].input_schema).toBeDefined();
    expect(body.tools[0].type).toBeUndefined(); // Anthropic format doesn't wrap in type: "function"
    // tool_choice uses type: "tool" for Anthropic, not type: "function"
    expect(body.tool_choice.type).toBe("tool");
  });

  it("falls back to generated artifacts when Anthropic API returns error", async () => {
    const { generateLaunchArtifacts } = await import(
      "../../worker/src/provisioning/launch-session.ts"
    );

    fetchSpy.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await generateLaunchArtifacts({
      env: fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }),
      companyName: "FallbackCo",
      idea: "Test idea",
      brief: sampleBrief,
    });

    // Should get fallback artifacts, not throw
    expect(result.companySpecMd).toContain("FallbackCo");
    expect(result.missionMd).toBeTruthy();
  });
});
