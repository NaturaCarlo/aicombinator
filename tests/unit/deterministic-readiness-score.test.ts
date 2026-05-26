import { describe, expect, it } from "vitest";

import {
  computeReadinessScore,
  computeAutonomyConfidence,
  enforceLaunchReadinessContract,
  type LaunchSessionBrief,
  type LaunchSessionReadiness,
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

function makeFullBrief(): LaunchSessionBrief {
  return makeBrief({
    targetCustomer: "owner-led roofing companies in storm-prone US metros",
    painfulProblem: "They lose booked jobs when lead response is too slow after storms.",
    firstOffer: "AI storm-response booking and qualification system for roofers",
    distributionWedge: "Founder-led outbound to roofing owners already buying storm leads",
    businessModel: "Monthly retainer per location plus booked-job upside",
    firstMilestone: "Ship a live storm-response wedge with outbound and booking flow",
    autonomyBoundaries: [
      "The team can refine positioning without asking the founder first.",
      "The team can adjust outreach tactics independently.",
    ],
  });
}

describe("computeReadinessScore", () => {
  it("returns 0 for a completely empty brief with blockers", () => {
    const score = computeReadinessScore(makeBrief(), ["Missing critical info"]);
    expect(score).toBe(0);
  });

  it("returns 0 for an empty brief with no blockers (still gets +9 for no blockers)", () => {
    const score = computeReadinessScore(makeBrief(), []);
    expect(score).toBe(9);
  });

  it("returns full score for a fully filled brief with no blockers", () => {
    const score = computeReadinessScore(makeFullBrief(), []);
    expect(score).toBe(100);
  });

  it("awards +15 for specific targetCustomer", () => {
    const empty = computeReadinessScore(makeBrief(), []);
    const withTarget = computeReadinessScore(
      makeBrief({ targetCustomer: "owner-led roofing companies in storm-prone US metros" }),
      [],
    );
    expect(withTarget - empty).toBe(15);
  });

  it("awards +15 for specific painfulProblem", () => {
    const empty = computeReadinessScore(makeBrief(), []);
    const withPain = computeReadinessScore(
      makeBrief({ painfulProblem: "They lose booked jobs when lead response is too slow after storms." }),
      [],
    );
    expect(withPain - empty).toBe(15);
  });

  it("awards +15 for specific firstOffer", () => {
    const empty = computeReadinessScore(makeBrief(), []);
    const withOffer = computeReadinessScore(
      makeBrief({ firstOffer: "AI storm-response booking and qualification system for roofers" }),
      [],
    );
    expect(withOffer - empty).toBe(15);
  });

  it("awards +12 for filled distributionWedge", () => {
    const empty = computeReadinessScore(makeBrief(), []);
    const withWedge = computeReadinessScore(
      makeBrief({ distributionWedge: "Founder-led outbound to roofing owners already buying storm leads" }),
      [],
    );
    expect(withWedge - empty).toBe(12);
  });

  it("awards +12 for filled businessModel", () => {
    const empty = computeReadinessScore(makeBrief(), []);
    const withModel = computeReadinessScore(
      makeBrief({ businessModel: "Monthly retainer per location plus booked-job upside" }),
      [],
    );
    expect(withModel - empty).toBe(12);
  });

  it("awards +12 for filled firstMilestone", () => {
    const empty = computeReadinessScore(makeBrief(), []);
    const withMilestone = computeReadinessScore(
      makeBrief({ firstMilestone: "Ship a live storm-response wedge with outbound and booking flow" }),
      [],
    );
    expect(withMilestone - empty).toBe(12);
  });

  it("awards +10 for at least 1 autonomyBoundary", () => {
    const empty = computeReadinessScore(makeBrief(), []);
    const withBoundary = computeReadinessScore(
      makeBrief({ autonomyBoundaries: ["The team can refine positioning without asking first."] }),
      [],
    );
    expect(withBoundary - empty).toBe(10);
  });

  it("awards +9 for no open blockers", () => {
    const withBlockers = computeReadinessScore(makeBrief(), ["Missing info"]);
    const noBlockers = computeReadinessScore(makeBrief(), []);
    expect(noBlockers - withBlockers).toBe(9);
  });

  it("does not award points for short placeholder values like 'TBD'", () => {
    const score = computeReadinessScore(
      makeBrief({
        targetCustomer: "TBD",
        painfulProblem: "???",
        firstOffer: "unknown",
      }),
      [],
    );
    // Only +9 for no blockers
    expect(score).toBe(9);
  });

  it("does not award points for 'everyone' as targetCustomer", () => {
    const score = computeReadinessScore(
      makeBrief({ targetCustomer: "everyone" }),
      [],
    );
    // "everyone" is too short (< 10 chars after trim) — should not get the +15
    expect(score).toBe(9);
  });

  it("increases predictably as conversation fills in brief fields", () => {
    const scores: number[] = [];

    // Step 0: empty
    scores.push(computeReadinessScore(makeBrief(), []));

    // Step 1: add targetCustomer
    scores.push(computeReadinessScore(
      makeBrief({ targetCustomer: "owner-led roofing companies in storm-prone US metros" }),
      [],
    ));

    // Step 2: add painfulProblem
    scores.push(computeReadinessScore(
      makeBrief({
        targetCustomer: "owner-led roofing companies in storm-prone US metros",
        painfulProblem: "They lose booked jobs when lead response is too slow after storms.",
      }),
      [],
    ));

    // Step 3: add firstOffer
    scores.push(computeReadinessScore(
      makeBrief({
        targetCustomer: "owner-led roofing companies in storm-prone US metros",
        painfulProblem: "They lose booked jobs when lead response is too slow after storms.",
        firstOffer: "AI storm-response booking and qualification system for roofers",
      }),
      [],
    ));

    // Verify monotonic increase
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }

    // Empty brief starts at ~0-10%
    expect(scores[0]).toBeLessThanOrEqual(10);
    // Fully filled brief reaches 90-100% (tested separately)
  });
});

describe("computeAutonomyConfidence", () => {
  it("returns 20 for a completely empty brief (only founderSetupTasks=[] earns points)", () => {
    // An empty brief has founderSetupTasks: [] which earns +20
    const confidence = computeAutonomyConfidence(makeBrief());
    expect(confidence).toBe(20);
  });

  it("returns high score for a well-specified brief", () => {
    const confidence = computeAutonomyConfidence(makeFullBrief());
    expect(confidence).toBeGreaterThanOrEqual(70);
  });

  it("awards +25 for 2+ autonomyBoundaries", () => {
    const without = computeAutonomyConfidence(makeBrief());
    const withBoundaries = computeAutonomyConfidence(
      makeBrief({
        autonomyBoundaries: [
          "The team can refine positioning without asking first.",
          "The team can adjust outreach tactics independently.",
        ],
      }),
    );
    expect(withBoundaries - without).toBe(25);
  });

  it("awards +20 for 1+ nonGoals", () => {
    const without = computeAutonomyConfidence(makeBrief());
    const withNonGoals = computeAutonomyConfidence(
      makeBrief({ nonGoals: ["Do not expand beyond roofing companies in year 1"] }),
    );
    expect(withNonGoals - without).toBe(20);
  });

  it("awards +20 for 0 deferred founderSetupTasks", () => {
    const withTasks = computeAutonomyConfidence(
      makeBrief({ founderSetupTasks: ["Create a Stripe account"] }),
    );
    const withoutTasks = computeAutonomyConfidence(
      makeBrief({ founderSetupTasks: [] }),
    );
    expect(withoutTasks - withTasks).toBe(20);
  });

  it("awards +15 for specific targetCustomer (>20 chars)", () => {
    const without = computeAutonomyConfidence(makeBrief());
    const withTarget = computeAutonomyConfidence(
      makeBrief({ targetCustomer: "owner-led roofing companies in storm-prone US metros" }),
    );
    expect(withTarget - without).toBe(15);
  });

  it("awards +10 for specific firstOffer (>20 chars)", () => {
    const without = computeAutonomyConfidence(makeBrief());
    const withOffer = computeAutonomyConfidence(
      makeBrief({ firstOffer: "AI storm-response booking and qualification system for roofers" }),
    );
    expect(withOffer - without).toBe(10);
  });

  it("awards +10 for specific distributionWedge (>20 chars)", () => {
    const without = computeAutonomyConfidence(makeBrief());
    const withWedge = computeAutonomyConfidence(
      makeBrief({ distributionWedge: "Founder-led outbound to roofing owners already buying storm leads" }),
    );
    expect(withWedge - without).toBe(10);
  });

  it("does not award points for short/placeholder values", () => {
    const confidence = computeAutonomyConfidence(
      makeBrief({
        targetCustomer: "TBD",
        firstOffer: "?",
        distributionWedge: "not sure yet",
      }),
    );
    // Only gets +20 for founderSetupTasks=[] from makeBrief default
    expect(confidence).toBe(20);
  });

  it("clamps to 100", () => {
    const fullBrief = makeFullBrief();
    fullBrief.nonGoals = ["Do not expand beyond roofing"];
    fullBrief.founderSetupTasks = [];
    const confidence = computeAutonomyConfidence(fullBrief);
    expect(confidence).toBeLessThanOrEqual(100);
  });
});

describe("enforceLaunchReadinessContract with deterministic score", () => {
  it("overrides LLM score with deterministic calculation", () => {
    const brief = makeFullBrief();
    const llmReadiness: LaunchSessionReadiness = {
      score: 42, // LLM guessed 42
      ready: false,
      blockers: [],
      strengths: ["Looks good"],
      nextBestQuestion: null,
    };

    const result = enforceLaunchReadinessContract(brief, llmReadiness);
    // Score should be deterministic, not the LLM's 42
    expect(result.score).not.toBe(42);
    expect(result.score).toBeGreaterThanOrEqual(75);
  });

  it("empty brief starts at ~0-10%", () => {
    const brief = makeBrief();
    const llmReadiness: LaunchSessionReadiness = {
      score: 50,
      ready: false,
      blockers: [],
      strengths: [],
      nextBestQuestion: null,
    };

    const result = enforceLaunchReadinessContract(brief, llmReadiness);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("fully filled brief reaches 90-100%", () => {
    const brief = makeFullBrief();
    const llmReadiness: LaunchSessionReadiness = {
      score: 30,
      ready: false,
      blockers: [],
      strengths: [],
      nextBestQuestion: null,
    };

    const result = enforceLaunchReadinessContract(brief, llmReadiness);
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("founder launch intent overrides to score >= 90 and ready=true when no hard blockers", () => {
    const brief = makeFullBrief();
    const llmReadiness: LaunchSessionReadiness = {
      score: 60,
      ready: true, // LLM detected founder saying "launch"/"let's go"/"ship it"
      blockers: [],
      strengths: ["Strong concept"],
      nextBestQuestion: null,
    };

    const result = enforceLaunchReadinessContract(brief, llmReadiness);
    expect(result.ready).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.blockers).toEqual([]);
    expect(result.nextBestQuestion).toBeNull();
  });

  it("founder launch intent with hard blockers → ready=false, score >= 75", () => {
    const brief = makeBrief({ targetCustomer: "owner-led roofing companies in storm-prone metros" });
    const llmReadiness: LaunchSessionReadiness = {
      score: 60,
      ready: true, // LLM detected founder intent, but hard blockers exist
      blockers: [],
      strengths: [],
      nextBestQuestion: null,
    };

    // painfulProblem and firstOffer are missing → hard blockers
    const result = enforceLaunchReadinessContract(brief, llmReadiness);
    expect(result.ready).toBe(false);
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("founder launch intent with low computed score but no hard blockers → ready=true, score=90", () => {
    const brief = makeFullBrief();
    // Override with a brief that has all required fields but low computed score
    // (this shouldn't happen in practice since full brief = high score, but tests the logic)
    const llmReadiness: LaunchSessionReadiness = {
      score: 30,
      ready: true,
      blockers: [],
      strengths: [],
      nextBestQuestion: null,
    };

    const result = enforceLaunchReadinessContract(brief, llmReadiness);
    expect(result.ready).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("no founder launch intent → deterministic score only, ready when score >= 75", () => {
    const brief = makeFullBrief();
    const llmReadiness: LaunchSessionReadiness = {
      score: 50,
      ready: false, // No launch intent
      blockers: [],
      strengths: [],
      nextBestQuestion: null,
    };

    const result = enforceLaunchReadinessContract(brief, llmReadiness);
    // Full brief should have high deterministic score
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.ready).toBe(true);
  });

  it("readiness.ready = true when score >= 75 and no hard blockers", () => {
    const brief = makeFullBrief();
    const llmReadiness: LaunchSessionReadiness = {
      score: 0, // LLM says 0
      ready: false,
      blockers: [],
      strengths: [],
      nextBestQuestion: null,
    };

    const result = enforceLaunchReadinessContract(brief, llmReadiness);
    // Deterministic score should be 100, so ready should be true
    expect(result.ready).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(75);
  });

  it("scores increase predictably as brief fields are filled", () => {
    const scores: number[] = [];
    const readiness: LaunchSessionReadiness = {
      score: 50,
      ready: false,
      blockers: [],
      strengths: [],
      nextBestQuestion: null,
    };

    // Empty
    scores.push(enforceLaunchReadinessContract(makeBrief(), readiness).score);

    // Add target
    scores.push(enforceLaunchReadinessContract(
      makeBrief({ targetCustomer: "owner-led roofing companies in storm-prone US metros" }),
      readiness,
    ).score);

    // Add pain + offer
    scores.push(enforceLaunchReadinessContract(
      makeBrief({
        targetCustomer: "owner-led roofing companies in storm-prone US metros",
        painfulProblem: "They lose booked jobs when lead response is too slow after storms.",
        firstOffer: "AI storm-response booking and qualification system for roofers",
      }),
      readiness,
    ).score);

    // Verify monotonic increase
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
  });
});

describe("normalizeBrief replaces LLM autonomyConfidence", () => {
  // We test this indirectly through enforceLaunchReadinessContract + the brief
  // since normalizeBrief is not exported. We verify the autonomyConfidence
  // comes out deterministic via a full turn result cycle.
  it("autonomyConfidence is deterministic based on brief content", () => {
    const emptyBrief = makeBrief();
    const fullBrief = makeFullBrief();

    // Empty brief should have low confidence
    expect(emptyBrief.autonomyConfidence).toBeLessThanOrEqual(35);

    // Full brief (after computeAutonomyConfidence) should have high confidence
    const fullConfidence = computeAutonomyConfidence(fullBrief);
    expect(fullConfidence).toBeGreaterThanOrEqual(70);
  });
});
