import { describe, expect, it } from "vitest";

import {
  buildFallbackLaunchSessionTurn,
  enforceLaunchReadinessContract,
  projectLaunchBriefFromConversation,
  salvageLaunchTurnResult,
  type LaunchSessionBrief,
  type LaunchSessionMessageInput,
} from "../../worker/src/provisioning/launch-session.ts";

function makeBrief(overrides: Partial<LaunchSessionBrief> = {}): LaunchSessionBrief {
  return {
    concept: "AI roofing concierge for storm-damaged homes.",
    targetCustomer: "",
    painfulProblem: "",
    firstOffer: "",
    whyNow: "",
    businessModel: "",
    distributionWedge: "",
    founderConstraints: [],
    autonomyBoundaries: [],
    founderSetupTasks: [],
    nonGoals: [],
    firstMilestone: "",
    openQuestions: [],
    autonomyConfidence: 35,
    ...overrides,
  };
}

function founderMessages(contents: string[]): LaunchSessionMessageInput[] {
  return contents.map((content) => ({ role: "founder", content }));
}

describe("launch-session fallback shaping", () => {
  it("locks in founder steering instead of repeating the same generic question", () => {
    const result = buildFallbackLaunchSessionTurn({
      companyName: "The American Roofing Company",
      idea: "Storm-damage roofing company that builds the whole software, financing, and field ops stack.",
      brief: makeBrief({
        targetCustomer: "owner-led roofing companies in the US",
        painfulProblem: "They lose deals when lead intake and booking is too slow after storms.",
      }),
      messages: founderMessages([
        "Start with inbound lead capture for roofing companies: missed-call recovery, lead qualification, and booking.",
        "Use a self-service booking link with SMS follow-up.",
      ]),
    });

    expect(result.brief.firstOffer.toLowerCase()).toContain("booking");
    expect(result.brief.firstOffer.toLowerCase()).toContain("sms");
    expect(result.readiness.nextBestQuestion?.toLowerCase()).not.toContain("first buyer");
    expect(result.assistantMessage).toContain("## Updated operating read");
  });

  it("asks for the first buyer only when that field is still unresolved", () => {
    const unresolved = buildFallbackLaunchSessionTurn({
      companyName: "PatchPilot",
      idea: "Security operations software for vulnerability triage.",
      brief: makeBrief(),
      messages: founderMessages(["Help me figure out the sharpest first wedge."]),
    });

    const resolved = buildFallbackLaunchSessionTurn({
      companyName: "PatchPilot",
      idea: "Security operations software for vulnerability triage.",
      brief: makeBrief({
        targetCustomer: "security teams at cloud-native B2B SaaS companies",
        painfulProblem: "They waste time triaging low-signal CVE alerts manually.",
      }),
      messages: founderMessages(["Start with one workflow the security team can trust end to end."]),
    });

    expect(unresolved.readiness.nextBestQuestion).toBe("Which first wedge should we commit to before launch?");
    expect(resolved.readiness.nextBestQuestion).not.toBe("Who is the exact first buyer we are going after?");
  });

  it("produces markdown-first assistant content and bounded option cards", () => {
    const result = buildFallbackLaunchSessionTurn({
      companyName: "OrbitOps",
      idea: "Back-office AI operator for SMB finance teams.",
      brief: makeBrief({
        targetCustomer: "finance teams at 20-200 person B2B software companies",
        painfulProblem: "Month-end close still leaks time across inboxes and spreadsheets.",
        firstOffer: "AI close assistant that owns reconciliations and exception follow-up",
        distributionWedge: "Founder-led outbound to controllers already paying for modern finance tooling.",
      }),
      messages: founderMessages(["Give me the next highest leverage commercial decision."]),
    });

    expect(result.assistantMessage).toContain("##");
    expect(result.options.length).toBeGreaterThan(0);
    expect(result.options.length).toBeLessThanOrEqual(4);
    expect(result.options.every((option) => option.title && option.description && option.founderReply)).toBe(true);
  });

  it("refuses to mark the brief ready when core commercial fields are still missing", () => {
    const readiness = enforceLaunchReadinessContract(
      makeBrief({
        targetCustomer: "owner-led roofing companies in Texas",
        painfulProblem: "They lose booked jobs when lead response is too slow after storms.",
        firstOffer: "",
        distributionWedge: "",
        businessModel: "",
        firstMilestone: "",
        autonomyBoundaries: [],
      }),
      {
        score: 92,
        ready: true,
        blockers: [],
        strengths: ["Looks sharp."],
        nextBestQuestion: null,
      },
    );

    expect(readiness.ready).toBe(false);
    // LLM said ready=true (founder launch intent) but hard blockers exist (missing firstOffer).
    // Score is boosted to max(computed, 75) to acknowledge the intent.
    // targetCustomer (+15) + painfulProblem (+15) = 30 computed, boosted to 75
    expect(readiness.score).toBe(75);
    expect(readiness.blockers.some((blocker) => blocker.includes("first offer"))).toBe(true);
    expect(readiness.nextBestQuestion).toBe("What is the smallest sellable first offer?");
  });

  it("projects founder steering into the working brief before the next model turn", () => {
    const projected = projectLaunchBriefFromConversation(
      makeBrief({
        targetCustomer: "owner-led roofing companies in storm-prone US metros",
        openQuestions: [
          "What is the smallest sellable first offer?",
          "What is the strongest first acquisition wedge?",
        ],
      }),
      founderMessages([
        "Start with missed-call recovery, lead qualification, and SMS booking for roofing companies.",
        "Sell it founder-led outbound to roofing owners already buying storm leads.",
      ]),
    );

    expect(projected.firstOffer.toLowerCase()).toContain("booking");
    expect(projected.firstOffer.toLowerCase()).toContain("sms");
    expect(projected.distributionWedge.toLowerCase()).toContain("outbound");
    expect(projected.openQuestions.some((question) => question.includes("smallest sellable first offer"))).toBe(false);
  });

  it("salvages a fenced OpenRouter payload when the JSON wrapper is slightly malformed", () => {
    const raw = `\`\`\`json
{
  "assistantMessage": "## Current Thesis\\n\\n- **First buyer:** owner-led roofing companies in hail-prone metros\\n- **Pain point:** storm leads and follow-up leak deals\\n- **Best initial offer:** AI storm-response booking and qualification",
  "suggestedCompanyName": "StormPilot",
  "brief": {
    "concept": "Autonomous roofing storm-response company",
    "targetCustomer": "owner-led roofing companies in hail-prone metros",
    "painfulProblem": "Storm leads and follow-up leak deals",
    "firstOffer": "AI storm-response booking and qualification",
    "whyNow": "Satellite imagery and AI vision make same-day routing viable",
    "businessModel": "Monthly retainer plus booked-job upside",
    "distributionWedge": "Founder-led outbound to roofers already buying storm leads",
    "founderConstraints": [],
    "autonomyBoundaries": ["The team can refine positioning without asking first"],
    "founderSetupTasks": ["Create the required mail and payments accounts later"],
    "nonGoals": [],
    "firstMilestone": "Ship a live storm-response wedge with outbound and booking",
    "openQuestions": [],
    "autonomyConfidence": 81,
  },
  "readiness": {
    "score": 82,
    "ready": true,
    "blockers": [],
    "strengths": ["The first wedge is commercially concrete"],
    "nextBestQuestion": null
  },
  "options": [
    {
      "title": "Own inbound storms",
      "description": "Capture and qualify storm leads instantly",
      "founderReply": "Start with inbound storm lead capture and qualification."
    }
  ]
}
\`\`\``;

    const result = salvageLaunchTurnResult(raw, {
      companyName: "The American Roofing Company",
      idea: "Storm-damage roofing workflow company.",
      brief: makeBrief(),
      messages: founderMessages(["Help me shape this into something the team can run."]),
    });

    expect(result).not.toBeNull();
    expect(result?.assistantMessage).toContain("## Current Thesis");
    expect(result?.brief.targetCustomer).toContain("roofing");
    expect(result?.options[0]?.founderReply).toContain("inbound storm");
    expect(result?.readiness.ready).toBe(true);
  });

  it("accepts common alias fields from provider output instead of rejecting the turn", () => {
    const raw = `{
      "message": "## Current Thesis\\n\\n- **Buyer:** controllers at SaaS companies\\n- **Offer:** a close-ops AI operator",
      "companyName": "CloseLoop",
      "blueprint": {
        "concept": "AI close ops",
        "targetCustomer": "controllers at 20-200 person SaaS companies",
        "painfulProblem": "Month-end close still leaks time across inboxes and spreadsheets",
        "firstOffer": "an AI close-ops operator",
        "whyNow": "AI can now execute the follow-up loop",
        "businessModel": "subscription plus usage",
        "distributionWedge": "founder-led outbound",
        "founderConstraints": [],
        "autonomyBoundaries": ["The team can refine product scope"],
        "founderSetupTasks": [],
        "nonGoals": [],
        "firstMilestone": "ship one end-to-end close workflow",
        "openQuestions": [],
        "autonomyConfidence": 80
      },
      "status": {
        "score": 84,
        "ready": true,
        "blockers": [],
        "strengths": ["Commercial wedge is clear"],
        "nextBestQuestion": null
      },
      "cards": [
        {
          "title": "Go after controllers",
          "description": "Sell directly to the team that feels the close pain",
          "founderReply": "Start with controllers at SaaS companies."
        }
      ]
    }`;

    const result = salvageLaunchTurnResult(raw, {
      companyName: "OrbitOps",
      idea: "Back-office AI operator for SMB finance teams.",
      brief: makeBrief(),
      messages: founderMessages(["Sharpen the strongest first commercial wedge."]),
    });

    expect(result).not.toBeNull();
    expect(result?.suggestedCompanyName).toBe("CloseLoop");
    expect(result?.brief.firstOffer).toContain("close-ops");
    expect(result?.readiness.ready).toBe(true);
    expect(result?.options).toHaveLength(1);
  });
});
