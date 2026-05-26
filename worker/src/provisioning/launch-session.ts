import type { Env } from "../types.js";
import { fallbackCompanyName } from "./config-builder.js";

const MODEL_TIMEOUT_MS = 90_000;
const OPENROUTER_MODEL = "anthropic/claude-sonnet-4.6";
const ANTHROPIC_DIRECT_MODEL = "claude-sonnet-4-20250514";

// Faster model for template-heavy artifact generation (company spec, mission, milestone, autonomy contract)
const ARTIFACT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4";
const ARTIFACT_ANTHROPIC_DIRECT_MODEL = "claude-sonnet-4-20250514";

export type LaunchSessionMode = "quick" | "standard" | "deep";

export interface LaunchSessionBrief {
  concept: string;
  targetCustomer: string;
  painfulProblem: string;
  firstOffer: string;
  whyNow: string;
  businessModel: string;
  distributionWedge: string;
  founderConstraints: string[];
  autonomyBoundaries: string[];
  founderSetupTasks: string[];
  nonGoals: string[];
  firstMilestone: string;
  openQuestions: string[];
  autonomyConfidence: number;
}

export interface LaunchSessionReadiness {
  score: number;
  ready: boolean;
  blockers: string[];
  strengths: string[];
  nextBestQuestion: string | null;
}

export interface LaunchSessionOption {
  title: string;
  description: string;
  founderReply: string;
}

export interface LaunchSessionTurnResult {
  assistantMessage: string;
  suggestedCompanyName: string | null;
  brief: LaunchSessionBrief;
  readiness: LaunchSessionReadiness;
  options: LaunchSessionOption[];
}

export interface LaunchSessionTurnGeneration {
  ok: boolean;
  result?: LaunchSessionTurnResult;
  error?: string;
  attempts: LaunchSessionTurnAttemptLog[];
}

export interface LaunchSessionArtifacts {
  companySpecMd: string;
  missionMd: string;
  firstMilestoneMd: string;
  autonomyContractMd: string;
}

export interface LaunchSessionMessageInput {
  role: "founder" | "assistant";
  content: string;
}

export interface LaunchSessionTurnAttemptLog {
  provider: "anthropic" | "openrouter";
  model: string | null;
  outcome: "success" | "non_ok" | "invalid_payload" | "error";
  durationMs: number;
  statusCode: number | null;
  error: string | null;
  promptChars: number;
  transcriptMessages: number;
}

function sanitizeLine(value: string | null | undefined, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

type LaunchCategory =
  | "local_service"
  | "b2b_workflow"
  | "productized_service"
  | "ecommerce"
  | "consumer"
  | "general";

interface KickoffInference {
  category: LaunchCategory;
  targetCustomer: string;
  painfulProblem: string;
  firstOffer: string;
  whyNow: string;
  businessModel: string;
  distributionWedge: string;
  firstMilestone: string;
  options: LaunchSessionOption[];
}

function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return true;
  return [
    "pick a narrow first buyer",
    "define the high-friction job",
    "start with a sellable narrow wedge",
    "the advantage should come from",
    "charge for a concrete business outcome",
    "choose one channel",
    "ship a founder-visible v1 offer",
    "one buyer segment with a painful",
    "the smallest sellable first wedge",
  ].some((snippet) => trimmed.includes(snippet));
}

function inferFounderTargetCustomer(message: string): string | null {
  return extractPhrase(message, [
    /\bsell\s+(?:it|this|them)\s+to\s+([^.,;]+)/i,
    /\bfor\s+([^.,;]+)/i,
    /\btarget\s+([^.,;]+)/i,
  ]);
}

function summarizeDirective(message: string): string {
  return sanitizeLine(message.replace(/\s+/g, " ").trim(), "");
}

function applyFounderSteeringToBrief(
  brief: LaunchSessionBrief,
  message: string,
): LaunchSessionBrief {
  const lower = message.toLowerCase();
  const updated = { ...brief };
  const explicitDirection = /^(start with|use|go with|do|make it)\b/i.test(message.trim());

  const targetCustomer = inferFounderTargetCustomer(message);
  if (targetCustomer && isPlaceholderValue(updated.targetCustomer)) {
    updated.targetCustomer = targetCustomer;
  }

  if (lower.startsWith("start with ")) {
    updated.firstOffer = message.replace(/^start with\s+/i, "").replace(/\.$/, "").trim();
  }

  if (
    explicitDirection
    && containsAny(lower, [
      "sms",
      "follow-up",
      "follow up",
      "booking link",
      "self-service booking",
      "self service booking",
      "booking",
      "qualified lead",
      "quote reminder",
    ])
  ) {
    updated.firstOffer = summarizeDirective(message);
  }

  if (containsAny(lower, ["pricing", "price", "retainer", "subscription", "pay-per", "pay per", "commission", "revenue share"])) {
    updated.businessModel = summarizeDirective(message);
  }

  if (containsAny(lower, ["outbound", "seo", "ads", "mail", "cold email", "cold call", "digital outreach", "partner", "partnership", "landing page", "distribution", "acquisition", "sms"])) {
    updated.distributionWedge = summarizeDirective(message);
  }

  if (containsAny(lower, ["milestone", "ship", "launch", "first version", "first market", "first metro", "first city", "pre-sign", "pre sign"])) {
    updated.firstMilestone = summarizeDirective(message);
  }

  if (containsAny(lower, ["pain", "problem", "because", "slow", "expensive", "manual", "delay", "miss", "leak"])) {
    updated.painfulProblem = isPlaceholderValue(updated.painfulProblem)
      ? summarizeDirective(message)
      : updated.painfulProblem;
  }

  // autonomyConfidence is computed deterministically in normalizeBrief — no manual increment needed
  updated.openQuestions = pruneResolvedOpenQuestions(updated.openQuestions, updated);
  return updated;
}

export function projectLaunchBriefFromConversation(
  brief: LaunchSessionBrief,
  messages: LaunchSessionMessageInput[],
): LaunchSessionBrief {
  const founderMessages = messages
    .filter((message) => message.role === "founder")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .slice(-4);

  if (founderMessages.length === 0) {
    return brief;
  }

  let projected = { ...brief };
  for (const founderMessage of founderMessages) {
    const next = applyFounderSteeringToBrief(projected, founderMessage);
    projected = {
      ...next,
      autonomyConfidence: brief.autonomyConfidence,
    };
  }
  projected.openQuestions = pruneResolvedOpenQuestions(projected.openQuestions, projected);
  return projected;
}

function questionTouchesCustomer(question: string): boolean {
  return containsAny(question, ["buyer", "customer", "icp", "segment", "audience"]);
}

function questionTouchesProblem(question: string): boolean {
  return containsAny(question, ["problem", "pain", "painful", "workflow", "job"]);
}

function questionTouchesOffer(question: string): boolean {
  return containsAny(question, ["offer", "wedge", "product", "promise", "deliverable"]);
}

function questionTouchesDistribution(question: string): boolean {
  return containsAny(question, ["distribution", "channel", "acquisition", "outbound", "go-to-market", "gtm"]);
}

function questionTouchesBusinessModel(question: string): boolean {
  return containsAny(question, ["business model", "pricing", "monet", "revenue", "retainer"]);
}

function questionTouchesMilestone(question: string): boolean {
  return containsAny(question, ["milestone", "proof", "prove", "launch", "first version"]);
}

function pruneResolvedOpenQuestions(
  questions: string[],
  brief: Pick<
    LaunchSessionBrief,
    "targetCustomer" | "painfulProblem" | "firstOffer" | "distributionWedge" | "businessModel" | "firstMilestone"
  >,
): string[] {
  return uniqueTrimmed(questions, 6).filter((question) => {
    const lower = question.toLowerCase();
    if (meaningfulBriefValue(brief.targetCustomer) && questionTouchesCustomer(lower)) return false;
    if (meaningfulBriefValue(brief.painfulProblem) && questionTouchesProblem(lower)) return false;
    if (meaningfulBriefValue(brief.firstOffer) && questionTouchesOffer(lower)) return false;
    if (meaningfulBriefValue(brief.distributionWedge) && questionTouchesDistribution(lower)) return false;
    if (meaningfulBriefValue(brief.businessModel) && questionTouchesBusinessModel(lower)) return false;
    if (meaningfulBriefValue(brief.firstMilestone) && questionTouchesMilestone(lower)) return false;
    return true;
  });
}

function determineFallbackNextQuestion(brief: LaunchSessionBrief): string {
  if (isPlaceholderValue(brief.targetCustomer)) {
    return "Who is the exact first buyer we are going after?";
  }
  if (isPlaceholderValue(brief.painfulProblem)) {
    return "What painful recurring problem are we solving first?";
  }
  if (isPlaceholderValue(brief.firstOffer)) {
    return "What is the smallest sellable first offer?";
  }
  if (isPlaceholderValue(brief.distributionWedge)) {
    return "What is the strongest first acquisition wedge?";
  }
  if (isPlaceholderValue(brief.businessModel)) {
    return "How does the company make money on the first version?";
  }
  if (isPlaceholderValue(brief.firstMilestone)) {
    return "What founder-visible first milestone proves the company is working?";
  }
  if (brief.openQuestions.length > 0) {
    return brief.openQuestions[0];
  }
  return "What is the single most important remaining assumption before launch?";
}

function buildFallbackContinuationOptions(
  kickoff: KickoffInference,
  brief: LaunchSessionBrief,
): LaunchSessionOption[] {
  if (isPlaceholderValue(brief.targetCustomer)) {
    return [
      {
        title: "Narrow the buyer",
        description: "Pick one painfully specific first buyer instead of a whole market.",
        founderReply: "Give me three sharply different first buyer options and choose one.",
      },
      {
        title: "Narrow the market",
        description: "Choose one geography, segment, or operating context that makes the wedge easiest to prove.",
        founderReply: "Give me three candidate first markets or segments and rank them.",
      },
      {
        title: "Narrow the urgency",
        description: "Find the buyer with the most painful version of this problem.",
        founderReply: "Which buyer has the most urgent version of this problem, and why?",
      },
    ];
  }

  if (isPlaceholderValue(brief.firstOffer)) {
    return [
      {
        title: "Sharpen the offer",
        description: "Turn the idea into the smallest sellable first wedge.",
        founderReply: "Give me three candidate first offers and choose one.",
      },
      {
        title: "Sharpen the promise",
        description: "Reframe the offer around a concrete business outcome a buyer will pay for.",
        founderReply: "Give me three tighter first-offer promises and rank them.",
      },
      {
        title: "Sharpen the deliverable",
        description: "Choose the first thing the team will produce or operate end to end.",
        founderReply: "What exact deliverable should the team own first?",
      },
    ];
  }

  if (isPlaceholderValue(brief.distributionWedge)) {
    return [
      {
        title: "Sharpen distribution",
        description: "Choose one acquisition motion instead of broad go-to-market talk.",
        founderReply: "Give me three realistic first distribution wedges and rank them.",
      },
      {
        title: "Sharpen outreach",
        description: "Decide the first outbound or inbound motion the company should run.",
        founderReply: "Give me three concrete first outreach motions and choose one.",
      },
      {
        title: "Sharpen channel fit",
        description: "Find the channel that best matches this buyer and offer.",
        founderReply: "Which first channel best matches this buyer and offer, and why?",
      },
    ];
  }

  if (isPlaceholderValue(brief.businessModel)) {
    return [
      {
        title: "Sharpen pricing",
        description: "Pick the simplest commercial model that gets to revenue fast.",
        founderReply: "Give me three pricing models for this company and rank them for speed to cash.",
      },
      {
        title: "Sharpen unit economics",
        description: "Choose the model that aligns price with value delivered.",
        founderReply: "Which commercial model best aligns price with value here?",
      },
      {
        title: "Sharpen cash flow",
        description: "Pick a model that gets paid early and cleanly.",
        founderReply: "Which pricing model gets cash in fastest without weakening the wedge?",
      },
    ];
  }

  return kickoff.options;
}

/**
 * Ensure a turn result always has options. When Opus returns an empty options
 * array (common with "I'm feeling lucky" auto-generated ideas), generate
 * deterministic fallback options from the brief state so the dashboard always
 * shows 2-3 clickable option buttons.
 */
export function ensureFallbackOptions(
  result: LaunchSessionTurnResult,
  input: { idea: string; companyName?: string | null },
): LaunchSessionTurnResult {
  if (result.options.length > 0) {
    return result;
  }
  const kickoff = inferLaunchKickoff({
    idea: input.idea,
    companyName: input.companyName,
    brief: result.brief,
  });
  const fallbackOptions = buildFallbackContinuationOptions(kickoff, result.brief);
  // If buildFallbackContinuationOptions also returned empty (all fields populated),
  // generate generic readiness-based options.
  if (fallbackOptions.length === 0) {
    const score = result.readiness.score;
    if (score >= 50) {
      return {
        ...result,
        options: [
          { title: "Launch now", description: "The brief is strong enough — start the company.", founderReply: "Launch now." },
          { title: "Customize team", description: "Adjust the founding team composition before launch.", founderReply: "Let me customize the founding team before we launch." },
          { title: "Add more details", description: "Tighten one more area of the brief.", founderReply: "I want to add more details before launching." },
        ],
      };
    }
    return {
      ...result,
      options: [
        { title: "Refine the idea", description: "Sharpen the concept before moving forward.", founderReply: "Help me refine this idea further." },
        { title: "Add more details", description: "Fill in missing gaps in the brief.", founderReply: "I want to add more details to the brief." },
        { title: "Launch anyway", description: "Start with what we have and iterate.", founderReply: "Launch anyway — we can iterate." },
      ],
    };
  }
  return { ...result, options: fallbackOptions };
}

function extractPhrase(idea: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = idea.match(pattern);
    if (!match?.[1]) continue;
    const candidate = match[1]
      .replace(/\b(and|or)\b.*$/i, "")
      .replace(/[.,;:]+$/g, "")
      .trim();
    if (candidate.length >= 3) {
      return candidate;
    }
  }
  return null;
}

function inferLaunchCategory(idea: string, companyName?: string | null): LaunchCategory {
  const combined = `${companyName ?? ""} ${idea}`.toLowerCase();
  if (containsAny(combined, [
    "roof", "roofer", "roofing", "plumb", "hvac", "electrician", "contractor",
    "landscap", "dentist", "dental", "clinic", "med spa", "law firm", "lawyer",
    "attorney", "chiro", "garage door", "cleaning", "painting", "home service",
  ])) {
    return "local_service";
  }
  if (containsAny(combined, [
    "agency", "ghostwriting", "consulting", "consultancy", "studio", "service", "done-for-you",
  ])) {
    return "productized_service";
  }
  if (containsAny(combined, [
    "shopify", "ecommerce", "e-commerce", "store", "retention", "cart", "merchant", "marketplace",
  ])) {
    return "ecommerce";
  }
  if (containsAny(combined, [
    "crm", "erp", "payroll", "compliance", "procurement", "support", "ticket", "workflow", "sales",
    "recruit", "finance", "accounting", "legal ops", "back office", "operations", "inbox",
  ])) {
    return "b2b_workflow";
  }
  if (containsAny(combined, [
    "creator", "consumer", "social", "dating", "fitness", "travel", "market", "community",
  ])) {
    return "consumer";
  }
  return "general";
}

function inferLocalServiceNiche(idea: string, companyName?: string | null): string {
  const combined = `${companyName ?? ""} ${idea}`.toLowerCase();
  if (containsAny(combined, ["roof", "roofer", "roofing"])) return "roofing companies";
  if (containsAny(combined, ["plumb"])) return "plumbing companies";
  if (containsAny(combined, ["hvac"])) return "HVAC companies";
  if (containsAny(combined, ["electrician", "electrical"])) return "electrical contractors";
  if (containsAny(combined, ["dentist", "dental"])) return "dental practices";
  if (containsAny(combined, ["law firm", "lawyer", "attorney"])) return "law firms";
  if (containsAny(combined, ["cleaning"])) return "cleaning companies";
  return "owner-led local service companies";
}

function inferLaunchKickoff(input: {
  idea: string;
  companyName?: string | null;
  brief: LaunchSessionBrief;
}): KickoffInference {
  const category = inferLaunchCategory(input.idea, input.companyName);
  const idea = input.idea.trim();
  const explicitCustomer = extractPhrase(idea, [
    /\bfor\s+([^.,;]+)/i,
    /\bhelps?\s+([^.,;]+?)\s+(?:to|with|by)\b/i,
    /\bused by\s+([^.,;]+)/i,
  ]);
  const explicitOutcome = extractPhrase(idea, [
    /\bto\s+([^.;]+)/i,
    /\bthat\s+(?:helps?|lets?)\s+[^.]*?\s+(?:to\s+)?([^.;]+)/i,
    /\bwith\s+([^.;]+)/i,
  ]);

  if (category === "local_service") {
    const niche = inferLocalServiceNiche(input.idea, input.companyName);
    const targetCustomer = input.brief.targetCustomer || explicitCustomer || `owner-led ${niche} in the US`;
    const painfulProblem = input.brief.painfulProblem || (
      explicitOutcome
        ? `They still lose money whenever ${explicitOutcome}.`
        : `They drop revenue when inbound leads, estimate follow-up, and booking flow through voicemail, inboxes, or a busy office manager.`
    );
    const firstOffer = input.brief.firstOffer || `AI lead intake, qualification, and booking for ${niche}`;
    return {
      category,
      targetCustomer,
      painfulProblem,
      firstOffer,
      whyNow: input.brief.whyNow || `These operators already buy lead generation and call handling, but staffing gaps and speed-to-lead still kill conversion.`,
      businessModel: input.brief.businessModel || `Monthly retainer per location plus usage or booked-job upside.`,
      distributionWedge: input.brief.distributionWedge || `Founder-led outbound to owners plus a live landing page that converts existing website traffic.`,
      firstMilestone: input.brief.firstMilestone || `Ship a live site, a working lead-capture flow, and one sharp outbound angle for ${niche}.`,
      options: [
        {
          title: "Own inbound leads",
          description: `Start with missed calls, web forms, and instant qualification for ${niche}.`,
          founderReply: `Start with inbound lead capture for ${niche}: missed-call recovery, lead qualification, and booking.`,
        },
        {
          title: "Own estimate follow-up",
          description: `Focus on the money leak between quote and signed job.`,
          founderReply: `Start with estimate follow-up for ${niche}: quote reminders, objections, and booking nudges.`,
        },
        {
          title: "Own customer communication",
          description: `Handle status updates, reminders, and reactivation so the operator feels less overloaded.`,
          founderReply: `Start with customer communication for ${niche}: reminders, status updates, and reactivation.`,
        },
      ],
    };
  }

  if (category === "b2b_workflow") {
    const targetCustomer = input.brief.targetCustomer || explicitCustomer || "one narrow operations team with a painful recurring workflow";
    const painfulProblem = input.brief.painfulProblem || (
      explicitOutcome
        ? `The team still burns time and loses quality whenever ${explicitOutcome}.`
        : "The workflow is still bouncing between inboxes, spreadsheets, and human follow-up."
    );
    const firstOffer = input.brief.firstOffer || "A narrow AI operator that completes one workflow end-to-end";
    return {
      category,
      targetCustomer,
      painfulProblem,
      firstOffer,
      whyNow: input.brief.whyNow || "The wedge only works now if the product can execute, not just assist.",
      businessModel: input.brief.businessModel || "Per-seat, per-workflow, or usage pricing tied to the workflow volume.",
      distributionWedge: input.brief.distributionWedge || "Founder-led outbound to teams already buying painful workflow software, but still doing the hard part manually.",
      firstMilestone: input.brief.firstMilestone || "Ship one complete workflow with a visible operator loop, not a generic AI assistant shell.",
      options: [
        {
          title: "Narrow the buyer",
          description: "Pick the team with the most painful recurring workflow instead of aiming at a whole market.",
          founderReply: "Give me three sharply different first buyer teams for this workflow and choose one.",
        },
        {
          title: "Narrow the workflow",
          description: "Choose the single workflow we can automate end-to-end first.",
          founderReply: "Give me three candidate first workflows for this company and tell me which one is best.",
        },
        {
          title: "Narrow the promise",
          description: "Choose the smallest measurable promise we can make in week one.",
          founderReply: "Give me three tighter first-offer promises and rank them by autonomy potential.",
        },
      ],
    };
  }

  if (category === "productized_service") {
    const targetCustomer = input.brief.targetCustomer || explicitCustomer || "a buyer who already pays for this outcome today";
    const painfulProblem = input.brief.painfulProblem || "The buyer wants the outcome, but agencies and freelancers are slow, expensive, and inconsistent.";
    const firstOffer = input.brief.firstOffer || "A narrow, productized service with repeatable AI-heavy delivery";
    return {
      category,
      targetCustomer,
      painfulProblem,
      firstOffer,
      whyNow: input.brief.whyNow || "AI can compress delivery time enough to make a tighter, more productized offer viable.",
      businessModel: input.brief.businessModel || "Fixed-fee or retainer pricing around one repeated deliverable.",
      distributionWedge: input.brief.distributionWedge || "Founder-led outbound paired with proof-heavy landing pages and compact case-study style assets.",
      firstMilestone: input.brief.firstMilestone || "Ship one sharp offer page, one delivery flow, and one outbound message set.",
      options: [
        {
          title: "Make it narrower",
          description: "Choose one outcome, one buyer, one delivery loop.",
          founderReply: "Make this a narrower productized service with one buyer and one outcome.",
        },
        {
          title: "Make it more premium",
          description: "Anchor on a painful, valuable deliverable instead of a generic service bundle.",
          founderReply: "Give me three higher-value premium wedges for this service company.",
        },
        {
          title: "Make it easier to sell",
          description: "Reframe the offer around a promise a buyer can say yes to quickly.",
          founderReply: "Give me three easier-to-sell first offers and rank them.",
        },
      ],
    };
  }

  if (category === "ecommerce") {
    const targetCustomer = input.brief.targetCustomer || explicitCustomer || "merchants with repeatable revenue and measurable conversion leakage";
    const painfulProblem = input.brief.painfulProblem || "Revenue is leaking through conversion, follow-up, or retention gaps that nobody owns tightly enough.";
    const firstOffer = input.brief.firstOffer || "A narrow revenue-operating layer for merchants";
    return {
      category,
      targetCustomer,
      painfulProblem,
      firstOffer,
      whyNow: input.brief.whyNow || "Merchants already spend on tools, but still want something that directly moves conversion or retention.",
      businessModel: input.brief.businessModel || "Subscription plus usage or revenue-linked upsell.",
      distributionWedge: input.brief.distributionWedge || "Outbound to merchants with a sharp revenue promise and an immediately inspectable live demo or teardown.",
      firstMilestone: input.brief.firstMilestone || "Ship one conversion or retention wedge that feels measurable right away.",
      options: [
        {
          title: "Attack conversion",
          description: "Focus the whole company on converting more existing traffic.",
          founderReply: "Start with conversion as the wedge: product discovery, offers, and checkout recovery.",
        },
        {
          title: "Attack retention",
          description: "Focus on repeat purchase and lifecycle revenue.",
          founderReply: "Start with retention as the wedge: reactivation, repeat purchase, and customer lifecycle flows.",
        },
        {
          title: "Attack merchant ops",
          description: "Help merchants run one painful operating loop faster.",
          founderReply: "Start with a merchant-ops wedge instead of pure marketing.",
        },
      ],
    };
  }

  const targetCustomer = input.brief.targetCustomer || explicitCustomer || "one buyer segment with a painful, expensive, repeated problem";
  const painfulProblem = input.brief.painfulProblem || (
    explicitOutcome
      ? `The company should exist to make it dramatically easier for that buyer to ${explicitOutcome}.`
      : "The idea still needs to lock onto one repeated painful workflow or business outcome."
  );
  const firstOffer = input.brief.firstOffer || "The smallest sellable first wedge for that buyer";
  return {
    category,
    targetCustomer,
    painfulProblem,
    firstOffer,
    whyNow: input.brief.whyNow || "The wedge should win because we can ship and iterate faster than a normal startup would.",
    businessModel: input.brief.businessModel || "Charge for a repeated workflow or a measurable business outcome.",
    distributionWedge: input.brief.distributionWedge || "Start with one buyer acquisition path we can push in week one.",
    firstMilestone: input.brief.firstMilestone || "Ship a founder-visible offer, a landing page, and one concrete go-to-market loop.",
    options: [
      {
        title: "Sharpen the buyer",
        description: "Narrow the company to one first customer with the most pain.",
        founderReply: "Give me three sharply different first buyer options and tell me which one you would choose.",
      },
      {
        title: "Sharpen the offer",
        description: "Turn the concept into the smallest sellable first product.",
        founderReply: "Give me three candidate first offers and tell me which one would let the team operate autonomously fastest.",
      },
      {
        title: "Sharpen the wedge",
        description: "Find the strongest initial distribution path instead of broad go-to-market talk.",
        founderReply: "Give me three realistic distribution wedges for week one and rank them.",
      },
    ],
  };
}

function uniqueTrimmed(values: unknown[], maxItems: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
    if (output.length >= maxItems) break;
  }
  return output;
}

function defaultBrief(input: {
  idea: string;
  companyName?: string | null;
}): LaunchSessionBrief {
  return {
    concept: input.idea.trim(),
    targetCustomer: "",
    painfulProblem: "",
    firstOffer: "",
    whyNow: "",
    businessModel: "",
    distributionWedge: "",
    founderConstraints: [],
    autonomyBoundaries: [
      "The team may refine positioning, product scope, and outreach tactics without asking the founder first.",
      "The founder must still create external accounts and approve irreversible external commitments.",
    ],
    founderSetupTasks: [
      "Create required third-party accounts such as Stripe, email providers, or domain registrar accounts when requested.",
    ],
    nonGoals: [],
    firstMilestone: "",
    openQuestions: [],
    autonomyConfidence: 35,
  };
}

function briefString(record: Record<string, unknown>, key: string, fallback: string): string {
  const raw = record[key];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // Preserve previously-populated fallback when Opus returns empty or placeholder
    return trimmed && !isPlaceholderValue(trimmed) ? trimmed : fallback;
  }
  return fallback;
}

function briefArray(record: Record<string, unknown>, key: string, fallback: string[], limit: number): string[] {
  const raw = record[key];
  if (Array.isArray(raw) && raw.length > 0) {
    return uniqueTrimmed(raw, limit);
  }
  // Preserve previously-populated fallback when Opus returns empty array
  return fallback.length > 0 ? uniqueTrimmed(fallback, limit) : [];
}

function normalizeBrief(raw: unknown, fallback: LaunchSessionBrief): LaunchSessionBrief {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const normalized: LaunchSessionBrief = {
    concept: briefString(record, "concept", fallback.concept),
    targetCustomer: briefString(record, "targetCustomer", fallback.targetCustomer),
    painfulProblem: briefString(record, "painfulProblem", fallback.painfulProblem),
    firstOffer: briefString(record, "firstOffer", fallback.firstOffer),
    whyNow: briefString(record, "whyNow", fallback.whyNow),
    businessModel: briefString(record, "businessModel", fallback.businessModel),
    distributionWedge: briefString(record, "distributionWedge", fallback.distributionWedge),
    founderConstraints: briefArray(record, "founderConstraints", fallback.founderConstraints, 6),
    autonomyBoundaries: briefArray(record, "autonomyBoundaries", fallback.autonomyBoundaries, 6),
    founderSetupTasks: briefArray(record, "founderSetupTasks", fallback.founderSetupTasks, 6),
    nonGoals: briefArray(record, "nonGoals", fallback.nonGoals, 6),
    firstMilestone: briefString(record, "firstMilestone", fallback.firstMilestone),
    openQuestions: briefArray(record, "openQuestions", fallback.openQuestions, 6),
    // Placeholder — will be overwritten by deterministic calculation below
    autonomyConfidence: 0,
  };
  normalized.openQuestions = pruneResolvedOpenQuestions(normalized.openQuestions, normalized);
  // Replace LLM-provided autonomyConfidence with deterministic calculation
  normalized.autonomyConfidence = computeAutonomyConfidence(normalized);
  return normalized;
}

function normalizeReadiness(raw: unknown): LaunchSessionReadiness {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const blockers = uniqueTrimmed(Array.isArray(record.blockers) ? record.blockers : [], 6);
  const strengths = uniqueTrimmed(Array.isArray(record.strengths) ? record.strengths : [], 6);
  const score = clampInt(typeof record.score === "number" ? record.score : 35, 0, 100);
  return {
    score,
    ready: Boolean(record.ready) && blockers.length === 0 && score >= 78,
    blockers,
    strengths,
    nextBestQuestion: sanitizeLine(record.nextBestQuestion as string | undefined, "") || null,
  };
}

function normalizeOptions(raw: unknown): LaunchSessionOption[] {
  const options = Array.isArray(raw) ? raw : [];
  const normalized: LaunchSessionOption[] = [];
  for (const option of options) {
    if (!option || typeof option !== "object" || Array.isArray(option)) continue;
    const record = option as Record<string, unknown>;
    const title = sanitizeLine(record.title as string | undefined);
    const description = sanitizeLine(record.description as string | undefined);
    const founderReply = sanitizeLine(record.founderReply as string | undefined);
    if (!title || !description || !founderReply) continue;
    normalized.push({ title, description, founderReply });
    if (normalized.length >= 4) break;
  }
  return normalized;
}

function modeGuidance(mode: LaunchSessionMode): string {
  switch (mode) {
    case "quick":
      return "Use 2-3 turns if possible. Prioritize clarity and decisiveness over exhaustive exploration.";
    case "deep":
      return "Use 8-12 turns if useful. Be ambitious, strategic, and willing to sharpen the wedge aggressively.";
    default:
      return "Use 5-7 turns if useful. Balance speed with enough rigor to support autonomous execution.";
  }
}

function compactText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function summarizeIdeaForPrompt(idea: string): string {
  return compactText(idea, 900);
}

function meaningfulBriefValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || isPlaceholderValue(trimmed)) {
    return null;
  }
  return trimmed;
}

function buildLockedDecisionSummary(brief: LaunchSessionBrief): string[] {
  const lines: string[] = [];
  const fields: Array<[string, string | null]> = [
    ["Concept", meaningfulBriefValue(brief.concept)],
    ["First buyer", meaningfulBriefValue(brief.targetCustomer)],
    ["Pain point", meaningfulBriefValue(brief.painfulProblem)],
    ["First offer", meaningfulBriefValue(brief.firstOffer)],
    ["Why now", meaningfulBriefValue(brief.whyNow)],
    ["Business model", meaningfulBriefValue(brief.businessModel)],
    ["Distribution wedge", meaningfulBriefValue(brief.distributionWedge)],
    ["First milestone", meaningfulBriefValue(brief.firstMilestone)],
  ];
  for (const [label, value] of fields) {
    if (value) {
      lines.push(`- ${label}: ${compactText(value, 220)}`);
    }
  }
  return lines.slice(0, 8);
}

function buildResolvedDecisionLabels(brief: LaunchSessionBrief): string[] {
  const labels: string[] = [];
  if (meaningfulBriefValue(brief.targetCustomer)) labels.push("First buyer");
  if (meaningfulBriefValue(brief.painfulProblem)) labels.push("Pain point");
  if (meaningfulBriefValue(brief.firstOffer)) labels.push("First offer");
  if (meaningfulBriefValue(brief.distributionWedge)) labels.push("Distribution wedge");
  if (meaningfulBriefValue(brief.businessModel)) labels.push("Business model");
  if (meaningfulBriefValue(brief.firstMilestone)) labels.push("First milestone");
  if (brief.autonomyBoundaries.length > 0) labels.push("Autonomy boundaries");
  return labels;
}

function determineNextDecisionFocus(brief: LaunchSessionBrief): string | null {
  if (!meaningfulBriefValue(brief.targetCustomer)) return "Lock the exact first buyer.";
  if (!meaningfulBriefValue(brief.painfulProblem)) return "Lock the painful recurring problem.";
  if (!meaningfulBriefValue(brief.firstOffer)) return "Lock the smallest sellable first offer.";
  if (!meaningfulBriefValue(brief.distributionWedge)) return "Lock the strongest first acquisition wedge.";
  if (!meaningfulBriefValue(brief.businessModel)) return "Lock the first commercial model.";
  if (!meaningfulBriefValue(brief.firstMilestone)) return "Lock the first founder-visible milestone.";
  if (brief.autonomyBoundaries.length === 0) return "Lock the autonomy boundaries for the team.";
  return null;
}

function buildFounderSteeringSummary(messages: LaunchSessionMessageInput[]): string {
  const founderMessages = messages
    .filter((message) => message.role === "founder")
    .slice(-3)
    .map((message, index) => `${index + 1}. ${compactText(message.content, 180)}`);
  return founderMessages.join("\n");
}

function buildRecentTurnSummary(messages: LaunchSessionMessageInput[]): string {
  return messages
    .slice(-4)
    .map((message) => `${message.role === "founder" ? "Founder" : "Opus"}: ${compactText(message.content, message.role === "founder" ? 180 : 140)}`)
    .join("\n");
}

function buildBriefSnapshotForPrompt(brief: LaunchSessionBrief): string {
  const snapshot = {
    concept: meaningfulBriefValue(brief.concept) ?? "",
    targetCustomer: meaningfulBriefValue(brief.targetCustomer) ?? "",
    painfulProblem: meaningfulBriefValue(brief.painfulProblem) ?? "",
    firstOffer: meaningfulBriefValue(brief.firstOffer) ?? "",
    whyNow: meaningfulBriefValue(brief.whyNow) ?? "",
    businessModel: meaningfulBriefValue(brief.businessModel) ?? "",
    distributionWedge: meaningfulBriefValue(brief.distributionWedge) ?? "",
    founderConstraints: brief.founderConstraints.slice(0, 4),
    autonomyBoundaries: brief.autonomyBoundaries.slice(0, 4),
    founderSetupTasks: brief.founderSetupTasks.slice(0, 4),
    nonGoals: brief.nonGoals.slice(0, 4),
    firstMilestone: meaningfulBriefValue(brief.firstMilestone) ?? "",
    openQuestions: brief.openQuestions.slice(0, 4),
    autonomyConfidence: brief.autonomyConfidence,
  };
  return JSON.stringify(snapshot);
}

function buildUnresolvedDecisionSummary(brief: LaunchSessionBrief): string[] {
  const unresolved: string[] = [];
  if (!meaningfulBriefValue(brief.targetCustomer)) unresolved.push("The exact first buyer is not locked yet.");
  if (!meaningfulBriefValue(brief.painfulProblem)) unresolved.push("The painful recurring problem is still vague.");
  if (!meaningfulBriefValue(brief.firstOffer)) unresolved.push("The smallest sellable first offer is still not pinned down.");
  if (!meaningfulBriefValue(brief.distributionWedge)) unresolved.push("The first acquisition wedge is still not pinned down.");
  if (!meaningfulBriefValue(brief.businessModel)) unresolved.push("The first commercial model is still unclear.");
  if (!meaningfulBriefValue(brief.firstMilestone)) unresolved.push("The first founder-visible milestone is still too fuzzy.");
  if (brief.openQuestions.length > 0) {
    unresolved.push(...brief.openQuestions.slice(0, 2));
  }
  return unresolved.slice(0, 4);
}

function deterministicReadinessBlockers(brief: LaunchSessionBrief): string[] {
  // Only block on truly critical missing fields — customer, problem, and offer
  const blockers: string[] = [];
  if (!meaningfulBriefValue(brief.targetCustomer)) blockers.push("The exact first buyer is still too vague.");
  if (!meaningfulBriefValue(brief.painfulProblem)) blockers.push("The painful recurring problem is still too vague.");
  if (!meaningfulBriefValue(brief.firstOffer)) blockers.push("The smallest sellable first offer is still not pinned down.");
  return blockers;
}

function deterministicNextBestQuestion(brief: LaunchSessionBrief): string | null {
  if (!meaningfulBriefValue(brief.targetCustomer)) return "Who is the exact first buyer we are going after?";
  if (!meaningfulBriefValue(brief.painfulProblem)) return "What painful recurring problem are we solving first?";
  if (!meaningfulBriefValue(brief.firstOffer)) return "What is the smallest sellable first offer?";
  if (!meaningfulBriefValue(brief.distributionWedge)) return "What is the strongest first acquisition wedge?";
  if (!meaningfulBriefValue(brief.businessModel)) return "How does the company make money on the first version?";
  if (!meaningfulBriefValue(brief.firstMilestone)) return "What founder-visible first milestone proves the company is working?";
  if (brief.autonomyBoundaries.length === 0) return "What decisions should the team be allowed to make without asking the founder?";
  return null;
}

/**
 * Returns true if a brief field value is meaningfully filled:
 * not null, not empty, not whitespace-only, not a placeholder, and longer than ~10 characters.
 */
function isFilledBriefField(value: string, minLength = 10): boolean {
  const meaningful = meaningfulBriefValue(value);
  if (!meaningful) return false;
  return meaningful.length > minLength;
}

/**
 * Deterministic readiness score based on brief field completeness.
 * Replaces LLM-generated readiness scores with a predictable, rubric-based calculation.
 *
 * Weights:
 * - targetCustomer filled and specific → +15
 * - painfulProblem filled and specific → +15
 * - firstOffer filled and specific → +15
 * - distributionWedge filled → +12
 * - businessModel filled → +12
 * - firstMilestone filled → +12
 * - autonomyBoundaries has at least 1 item → +10
 * - No open blockers → +9
 *
 * Total possible: 100
 */
export function computeReadinessScore(brief: LaunchSessionBrief, blockers: string[]): number {
  let score = 0;
  if (isFilledBriefField(brief.targetCustomer)) score += 15;
  if (isFilledBriefField(brief.painfulProblem)) score += 15;
  if (isFilledBriefField(brief.firstOffer)) score += 15;
  if (isFilledBriefField(brief.distributionWedge)) score += 12;
  if (isFilledBriefField(brief.businessModel)) score += 12;
  if (isFilledBriefField(brief.firstMilestone)) score += 12;
  if (brief.autonomyBoundaries.length >= 1) score += 10;
  if (blockers.length === 0) score += 9;
  return clampInt(score, 0, 100);
}

/**
 * Deterministic autonomy confidence based on brief specificity and boundary definition.
 * Replaces LLM-generated autonomyConfidence with a predictable calculation.
 *
 * Weights:
 * - autonomyBoundaries has 2+ items → +25
 * - nonGoals has 1+ items → +20
 * - founderSetupTasks has 0 deferred items → +20
 * - targetCustomer is specific (>20 chars) → +15
 * - firstOffer is specific (>20 chars) → +10
 * - distributionWedge is specific (>20 chars) → +10
 *
 * Total possible: 100
 */
export function computeAutonomyConfidence(brief: LaunchSessionBrief): number {
  let confidence = 0;
  if (brief.autonomyBoundaries.length >= 2) confidence += 25;
  if (brief.nonGoals.length >= 1) confidence += 20;
  if (brief.founderSetupTasks.length === 0) confidence += 20;
  if (isFilledBriefField(brief.targetCustomer, 20)) confidence += 15;
  if (isFilledBriefField(brief.firstOffer, 20)) confidence += 10;
  if (isFilledBriefField(brief.distributionWedge, 20)) confidence += 10;
  return clampInt(confidence, 0, 100);
}

export function enforceLaunchReadinessContract(
  brief: LaunchSessionBrief,
  readiness: LaunchSessionReadiness,
): LaunchSessionReadiness {
  const hardBlockers = deterministicReadinessBlockers(brief);
  const score = computeReadinessScore(brief, hardBlockers);

  // Founder launch-intent override: LLM sets ready=true when founder says
  // "launch"/"let's go"/"ship it" etc. Honor this intent.
  if (readiness.ready) {
    if (hardBlockers.length === 0) {
      // No hard blockers → respect founder intent: ready=true, score boosted to at least 90
      return {
        score: Math.max(score, 90),
        ready: true,
        blockers: [],
        strengths: uniqueTrimmed(readiness.strengths, 6),
        nextBestQuestion: null,
      };
    }
    // Hard blockers present → acknowledge intent with score boost, but keep ready=false
    const blockers = uniqueTrimmed([
      ...readiness.blockers,
      ...hardBlockers,
    ], 6);
    return {
      score: Math.max(score, 75),
      ready: false,
      blockers,
      strengths: uniqueTrimmed(readiness.strengths, 6),
      nextBestQuestion: readiness.nextBestQuestion || deterministicNextBestQuestion(brief),
    };
  }

  // Normal flow (no launch intent) → deterministic score only
  const blockers = uniqueTrimmed([
    ...readiness.blockers,
    ...hardBlockers,
  ], 6);
  const ready = hardBlockers.length === 0 && score >= 75;
  return {
    score,
    ready,
    blockers: ready ? [] : blockers,
    strengths: uniqueTrimmed(readiness.strengths, 6),
    nextBestQuestion: ready ? null : (readiness.nextBestQuestion || deterministicNextBestQuestion(brief)),
  };
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<Response>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetch(input, {
        ...init,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function extractErrorPreview(response: Response): Promise<string | null> {
  try {
    const body = (await response.text()).trim();
    if (!body) {
      return null;
    }
    return compactText(body, 240);
  } catch {
    return null;
  }
}

function parseJsonPayload(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const tryParse = (candidate: string): Record<string, unknown> | null => {
    const variants = [
      candidate,
      candidate.replace(/,\s*([}\]])/g, "$1"),
    ];
    for (const variant of variants) {
      try {
        return JSON.parse(variant) as Record<string, unknown>;
      } catch {
        // Try the next repair variant.
      }
    }
    return null;
  };

  const direct = tryParse(trimmed);
  if (direct) {
    return direct;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) {
    const parsed = tryParse(fenced);
    if (parsed) {
      return parsed;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    const parsed = tryParse(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function extractBalancedSegment(raw: string, key: string, open: string, close: string): string | null {
  const keyIndex = raw.search(new RegExp(`"${key}"\\s*:`));
  if (keyIndex < 0) {
    return null;
  }
  const start = raw.indexOf(open, keyIndex);
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }

  return null;
}

function extractJsonStringField(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s"));
  if (!match?.[1]) {
    return null;
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

function extractJsonObjectField(raw: string, key: string): Record<string, unknown> | null {
  const segment = extractBalancedSegment(raw, key, "{", "}");
  return segment ? parseJsonPayload(segment) : null;
}

function extractJsonArrayField(raw: string, key: string): unknown[] | null {
  const segment = extractBalancedSegment(raw, key, "[", "]");
  if (!segment) {
    return null;
  }
  try {
    return JSON.parse(segment) as unknown[];
  } catch {
    try {
      return JSON.parse(segment.replace(/,\s*([}\]])/g, "$1")) as unknown[];
    } catch {
      return null;
    }
  }
}

function readStringValue(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function normalizeLaunchTurnResult(
  parsed: Record<string, unknown>,
  input: {
    idea: string;
    companyName?: string | null;
    brief: LaunchSessionBrief;
    messages?: LaunchSessionMessageInput[];
  },
): LaunchSessionTurnResult | null {
  // Use the current session brief as fallback so previously-populated fields
  // are preserved when Opus returns empty strings for them.
  const briefFallback = input.brief;
  const brief = normalizeBrief(
    parsed.brief
      ?? parsed.blueprint
      ?? parsed.companyBrief
      ?? parsed.launchBrief
      ?? parsed.spec,
    briefFallback,
  );
  const readiness = enforceLaunchReadinessContract(
    brief,
    normalizeReadiness(parsed.readiness ?? parsed.launchReadiness ?? parsed.status),
  );
  const options = normalizeOptions(parsed.options ?? parsed.optionCards ?? parsed.cards ?? parsed.choices);
  const assistantMessage = sanitizeLine(readStringValue(parsed, [
    "assistantMessage",
    "assistant_message",
    "message",
    "reply",
    "analysis",
  ]));
  if (!assistantMessage) {
    return null;
  }

  return {
    assistantMessage,
    suggestedCompanyName: sanitizeLine(readStringValue(parsed, [
      "suggestedCompanyName",
      "suggested_company_name",
      "companyName",
      "company_name",
      "name",
    ]), "") || null,
    brief,
    readiness,
    options,
  };
}

export function salvageLaunchTurnResult(
  raw: string,
  input: {
    idea: string;
    companyName?: string | null;
    brief: LaunchSessionBrief;
    messages?: LaunchSessionMessageInput[];
  },
): LaunchSessionTurnResult | null {
  const assistantMessage = sanitizeLine(
    extractJsonStringField(raw, "assistantMessage")
    || extractJsonStringField(raw, "assistant_message")
    || extractJsonStringField(raw, "message")
    || extractJsonStringField(raw, "reply")
    || extractJsonStringField(raw, "analysis"),
  );
  if (!assistantMessage) {
    return null;
  }

  const parsed: Record<string, unknown> = {
    assistantMessage,
  };

  const suggestedCompanyName = extractJsonStringField(raw, "suggestedCompanyName")
    || extractJsonStringField(raw, "suggested_company_name")
    || extractJsonStringField(raw, "companyName")
    || extractJsonStringField(raw, "company_name")
    || extractJsonStringField(raw, "name");
  if (suggestedCompanyName) {
    parsed.suggestedCompanyName = suggestedCompanyName;
  }

  const brief = extractJsonObjectField(raw, "brief")
    || extractJsonObjectField(raw, "blueprint")
    || extractJsonObjectField(raw, "companyBrief")
    || extractJsonObjectField(raw, "launchBrief")
    || extractJsonObjectField(raw, "spec");
  if (brief) {
    parsed.brief = brief;
  }

  const readiness = extractJsonObjectField(raw, "readiness")
    || extractJsonObjectField(raw, "launchReadiness")
    || extractJsonObjectField(raw, "status");
  if (readiness) {
    parsed.readiness = readiness;
  }

  const options = extractJsonArrayField(raw, "options")
    || extractJsonArrayField(raw, "optionCards")
    || extractJsonArrayField(raw, "cards")
    || extractJsonArrayField(raw, "choices");
  if (options) {
    parsed.options = options;
  }

  return normalizeLaunchTurnResult(parsed, input);
}

export function buildFallbackLaunchSessionTurn(input: {
  idea: string;
  companyName?: string | null;
  brief: LaunchSessionBrief;
  messages?: LaunchSessionMessageInput[];
}): LaunchSessionTurnResult {
  const companyName = sanitizeLine(input.companyName, "") || fallbackCompanyName(input.idea);
  const kickoff = inferLaunchKickoff(input);
  const lastFounderMessage = [...(input.messages ?? [])]
    .reverse()
    .find((message) => message.role === "founder")
    ?.content
    ?.trim()
    ?.toLowerCase() ?? "";
  const brief = normalizeBrief(
    {
      ...input.brief,
      concept: input.brief.concept || input.idea,
      targetCustomer: input.brief.targetCustomer || kickoff.targetCustomer,
      painfulProblem: input.brief.painfulProblem || kickoff.painfulProblem,
      firstOffer: input.brief.firstOffer || kickoff.firstOffer,
      whyNow: input.brief.whyNow || kickoff.whyNow,
      businessModel: input.brief.businessModel || kickoff.businessModel,
      distributionWedge: input.brief.distributionWedge || kickoff.distributionWedge,
      firstMilestone: input.brief.firstMilestone || kickoff.firstMilestone,
      // autonomyConfidence is computed deterministically in normalizeBrief
      openQuestions: input.brief.openQuestions.length > 0
        ? input.brief.openQuestions
        : ["Which wedge should the company attack first?"],
    },
    defaultBrief(input),
  );

  if (lastFounderMessage) {
    Object.assign(brief, applyFounderSteeringToBrief(brief, lastFounderMessage));
  }

  const continuing = (input.messages?.length ?? 0) > 1 && lastFounderMessage.length > 0;
  const nextBestQuestion = continuing
    ? determineFallbackNextQuestion(brief)
    : "Which first wedge should we commit to before launch?";
  const options = continuing
    ? buildFallbackContinuationOptions(kickoff, brief)
    : kickoff.options;

  return {
    assistantMessage: [
      ...(
        continuing
          ? [
              "## Updated operating read",
              "",
              `If we commit to **${brief.firstOffer.toLowerCase()}**, this is the operating thesis I would run with:`,
            ]
          : [
              `## First operating read`,
              "",
              `Here’s the sharpest version of **${companyName}** I can justify from what you’ve already told me.`,
            ]
      ),
      "",
      `- **First buyer:** ${brief.targetCustomer}`,
      `- **Pain point:** ${brief.painfulProblem}`,
      `- **Best initial offer:** ${brief.firstOffer}`,
      `- **First milestone:** ${brief.firstMilestone}`,
      "",
      ...(
        continuing
          ? [
              "## What still needs tightening",
              "",
              "This is strong enough to keep shaping, but the company will get materially better if we lock the next unresolved commercial decision instead of circling the same wedge again.",
              "",
              `**Next best decision:** ${nextBestQuestion}`,
            ]
          : [
              "## What I’d do next",
              "",
              `My default move right now would be **${brief.firstOffer}**.`,
              "",
              "Pick one of the paths below and I’ll harden the blueprint around it.",
            ]
      ),
    ].join("\n"),
    suggestedCompanyName: companyName,
    brief,
    readiness: {
      score: continuing ? 68 : 55,
      ready: false,
      blockers: [
        continuing
          ? "The wedge is clearer now, but the exact promise and go-to-market angle still need to be tightened before launch."
          : "The first customer and the first sellable offer are still too vague.",
      ],
      strengths: [
        continuing
          ? "The founder has already committed to a more specific first wedge."
          : "The existing input is already specific enough to make a first concrete operating read.",
      ],
      nextBestQuestion,
    },
    options,
  };
}

function buildLaunchSystemPrompt(mode: LaunchSessionMode): string {
  return [
    "You are a sharp startup cofounder and mentor.",
    "Shape a vague company idea into an operating brief an autonomous AI team can execute long-term with minimal founder intervention.",
    modeGuidance(mode),
    "Reduce founder effort. Provide 2-3 strong options instead of asking the founder to invent from scratch.",
    "Tone: calm, incisive cofounder — warm, opinionated, clear, practical. Never flatter or say 'great idea'. Improve the idea.",
    "Focus on the smallest plausible wedge that could become an autonomous company. Prefer B2B or workflow-heavy ideas over vague consumer novelty unless the founder clearly wants otherwise.",
    "Synthesize first, don't interrogate. If buyer, pain, offer, or milestone are inferable from existing input, state your best thesis instead of asking a broad question.",
    "When the founder gives a direction or picks an option, incorporate it into the brief immediately and advance to the next unresolved decision. Every turn must materially advance at least one brief field.",
    "Treat locked decisions as settled — never re-ask resolved questions or request information already in the idea, brief, or recent turns. Only reopen if the founder explicitly does.",
    "IMPORTANT: Never return empty brief fields. Always provide your best inference, even if speculative. A populated brief needing refinement beats empty fields.",
    "The readiness score and autonomy confidence are calculated automatically from brief completeness. You do NOT need to estimate them. Focus on extracting clear, specific answers for each brief field. The scores will update automatically.",
    "This conversation is ONLY for shaping the company spec. Never ask for credentials, API keys, or account details. Include setup tasks (Stripe, etc.) in founderSetupTasks but defer them to post-launch. Option cards must offer strategic direction choices only, and founderReply must be a natural sentence (e.g. 'Focus on Texas first'), never placeholder text.",
    "Mark readiness true when key fields (customer, problem, offer, model, wedge, milestone) have real answers — the brief does NOT need to be perfect.",
    "CRITICAL: If the founder says 'launch', 'let's go', 'ready', 'ship it', 'good enough', 'start', or 'looks good' — immediately set readiness.ready = true. Founder launch intent overrides open questions.",
    "If something is weak, name it and push the founder toward concrete choices. Offer concrete options derived from the idea rather than generic startup questions.",
    "Use markdown in assistantMessage: 1 heading + 4-7 bullets/short paragraphs, under 220 words. Pattern: current thesis → strongest options → single highest-leverage unresolved question if needed.",
    "Use the provided tool exactly once.",
  ].join("\n");
}

function buildLaunchUserPrompt(input: {
  companyName?: string | null;
  idea: string;
  recentTurnSummary: string;
  lockedDecisions: string[];
  unresolvedDecisions: string[];
  resolvedDecisionLabels: string[];
  nextDecisionFocus: string | null;
  founderSteering: string;
  workingBrief: LaunchSessionBrief;
}): string {
  return [
    `Preferred company name: ${sanitizeLine(input.companyName, "(none yet)")}`,
    `Founder's starting idea (excerpt): ${summarizeIdeaForPrompt(input.idea)}`,
    "",
    "Recent turn context:",
    input.recentTurnSummary || "Founder: No conversation yet beyond the initial idea.",
    "",
    "Locked decisions already made:",
    input.lockedDecisions.length > 0 ? input.lockedDecisions.join("\n") : "- None yet. You need to infer the first viable thesis from the idea.",
    "",
    "Unresolved decisions:",
    input.unresolvedDecisions.length > 0 ? input.unresolvedDecisions.map((line) => `- ${line}`).join("\n") : "- No obvious blockers remain. Tighten the spec and finish.",
    "",
    "Already resolved decision areas. Do not reopen these unless the founder explicitly changes direction:",
    input.resolvedDecisionLabels.length > 0 ? input.resolvedDecisionLabels.map((label) => `- ${label}`).join("\n") : "- None yet.",
    "",
    "Primary focus for this turn:",
    input.nextDecisionFocus ? `- ${input.nextDecisionFocus}` : "- Tighten the brief, improve the wording, and finish cleanly.",
    "",
    "Recent founder steering:",
    input.founderSteering || "No founder steering yet beyond the initial idea.",
    "",
    "Current brief snapshot JSON:",
    buildBriefSnapshotForPrompt(input.workingBrief),
    "",
    "Advance the company spec from this working truth. Do not reopen already-settled decisions unless the founder explicitly reopens them.",
    "Return a stricter, sharper updated brief plus a helpful reply and concrete option cards.",
    "The JSON must contain: assistantMessage, suggestedCompanyName, brief, readiness, options.",
  ].join("\n");
}

export async function generateLaunchSessionTurn(input: {
  env: Env;
  mode: LaunchSessionMode;
  companyName?: string | null;
  idea: string;
  brief: LaunchSessionBrief;
  messages: LaunchSessionMessageInput[];
}): Promise<LaunchSessionTurnGeneration> {
  const maxTokens = input.mode === "deep" ? 3000 : input.mode === "quick" ? 1800 : 2200;
  const promptChars = input.idea.length + JSON.stringify(input.brief).length + input.messages.reduce((total, message) => total + message.content.length, 0);
  const transcriptMessages = input.messages.length;
  const attempts: LaunchSessionTurnAttemptLog[] = [];
  const workingBrief = projectLaunchBriefFromConversation(input.brief, input.messages);
  const normalizedInput = {
    ...input,
    brief: workingBrief,
  };
  const launchTurnSchema = {
    type: "object",
    properties: {
      assistantMessage: { type: "string" },
      suggestedCompanyName: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      brief: {
        type: "object",
        properties: {
          concept: { type: "string" },
          targetCustomer: { type: "string" },
          painfulProblem: { type: "string" },
          firstOffer: { type: "string" },
          whyNow: { type: "string" },
          businessModel: { type: "string" },
          distributionWedge: { type: "string" },
          founderConstraints: { type: "array", items: { type: "string" } },
          autonomyBoundaries: { type: "array", items: { type: "string" } },
          founderSetupTasks: { type: "array", items: { type: "string" } },
          nonGoals: { type: "array", items: { type: "string" } },
          firstMilestone: { type: "string" },
          openQuestions: { type: "array", items: { type: "string" } },
          autonomyConfidence: { type: "number" },
        },
        required: [
          "concept",
          "targetCustomer",
          "painfulProblem",
          "firstOffer",
          "whyNow",
          "businessModel",
          "distributionWedge",
          "founderConstraints",
          "autonomyBoundaries",
          "founderSetupTasks",
          "nonGoals",
          "firstMilestone",
          "openQuestions",
          "autonomyConfidence",
        ],
        additionalProperties: false,
      },
      readiness: {
        type: "object",
        properties: {
          score: { type: "number" },
          ready: { type: "boolean" },
          blockers: { type: "array", items: { type: "string" } },
          strengths: { type: "array", items: { type: "string" } },
          nextBestQuestion: {
            anyOf: [{ type: "string" }, { type: "null" }],
          },
        },
        required: ["score", "ready", "blockers", "strengths", "nextBestQuestion"],
        additionalProperties: false,
      },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            founderReply: { type: "string" },
          },
          required: ["title", "description", "founderReply"],
          additionalProperties: false,
        },
      },
    },
    required: ["assistantMessage", "suggestedCompanyName", "brief", "readiness", "options"],
    additionalProperties: false,
  } as const;

  const systemPrompt = buildLaunchSystemPrompt(input.mode);

  const lockedDecisions = buildLockedDecisionSummary(workingBrief);
  const resolvedDecisionLabels = buildResolvedDecisionLabels(workingBrief);
  const unresolvedDecisions = buildUnresolvedDecisionSummary(workingBrief);
  const nextDecisionFocus = determineNextDecisionFocus(workingBrief);
  const founderSteering = buildFounderSteeringSummary(input.messages);
  const recentTurnSummary = buildRecentTurnSummary(input.messages);
  const userPrompt = buildLaunchUserPrompt({
    companyName: input.companyName,
    idea: input.idea,
    recentTurnSummary,
    lockedDecisions,
    unresolvedDecisions,
    resolvedDecisionLabels,
    nextDecisionFocus,
    founderSteering,
    workingBrief,
  });

  // Use OpenRouter (Sonnet via OpenRouter) with tool_use
  if (input.env.OPENROUTER_API_KEY) {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${input.env.OPENROUTER_API_KEY}`,
            "HTTP-Referer": input.env.FRONTEND_URL,
            "X-Title": "AI Combinator Launch Studio",
          },
          body: JSON.stringify({
            model: OPENROUTER_MODEL,
            max_tokens: maxTokens,
            temperature: 0.35,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            tools: [
              {
                type: "function",
                function: {
                  name: "submit_launch_turn",
                  description: "Return the next cofounder turn and the updated structured launch brief.",
                  parameters: launchTurnSchema,
                },
              },
            ],
            tool_choice: { type: "function", function: { name: "submit_launch_turn" } },
          }),
        },
        MODEL_TIMEOUT_MS,
      );

      if (response.ok) {
        const data = await response.json() as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
            };
          }>;
          model?: string;
          provider?: string;
        };
        const durationMs = Date.now() - startedAt;
        const choice = data.choices?.[0]?.message;
        const toolCall = choice?.tool_calls?.find((tc) => tc.function?.name === "submit_launch_turn");
        const toolArgs = toolCall?.function?.arguments;

        // Try tool_call first, then fall back to content, then salvage from truncated tool args
        let normalized: LaunchSessionTurnResult | null = null;
        let debugRaw = "";
        if (toolArgs) {
          debugRaw = toolArgs;
          const parsed = parseJsonPayload(toolArgs);
          if (parsed) {
            normalized = normalizeLaunchTurnResult(parsed, normalizedInput);
          }
          // Tool args may be truncated JSON — try salvage extraction
          if (!normalized) {
            normalized = salvageLaunchTurnResult(toolArgs, normalizedInput);
          }
        }
        if (!normalized) {
          const raw = choice?.content?.trim() ?? "";
          debugRaw = debugRaw || raw;
          const parsed = parseJsonPayload(raw);
          normalized = parsed
            ? normalizeLaunchTurnResult(parsed, normalizedInput) ?? salvageLaunchTurnResult(raw, normalizedInput)
            : salvageLaunchTurnResult(raw, normalizedInput);
        }

        console.log("[launch-session] openrouter response", JSON.stringify({
          durationMs,
          model: data.model,
          provider: data.provider,
          hasToolCall: Boolean(toolArgs),
          rawLength: debugRaw.length,
          rawPreview: debugRaw.slice(0, 400),
          normalized: Boolean(normalized),
        }));

        if (normalized) {
          attempts.push({
            provider: "openrouter",
            model: data.model ?? OPENROUTER_MODEL,
            outcome: "success",
            durationMs,
            statusCode: 200,
            error: null,
            promptChars,
            transcriptMessages,
          });
          return { ok: true, result: normalized, attempts };
        }
        attempts.push({
          provider: "openrouter",
          model: data.model ?? OPENROUTER_MODEL,
          outcome: "invalid_payload",
          durationMs,
          statusCode: 200,
          error: debugRaw
            ? `OpenRouter returned an invalid launch payload: ${compactText(debugRaw, 220)}`
            : "OpenRouter returned empty content.",
          promptChars,
          transcriptMessages,
        });
        console.warn("[launch-session] openrouter invalid-payload", JSON.stringify({ durationMs }));
      } else {
        const errorPreview = await extractErrorPreview(response);
        const durationMs = Date.now() - startedAt;
        attempts.push({
          provider: "openrouter",
          model: OPENROUTER_MODEL,
          outcome: "non_ok",
          durationMs,
          statusCode: response.status,
          error: errorPreview
            ? `OpenRouter returned HTTP ${response.status}: ${errorPreview}`
            : `OpenRouter returned HTTP ${response.status}.`,
          promptChars,
          transcriptMessages,
        });
        console.warn("[launch-session] openrouter non-ok", JSON.stringify({
          durationMs,
          status: response.status,
          error: errorPreview,
        }));
      }
    } catch (error) {
      attempts.push({
        provider: "openrouter",
        model: OPENROUTER_MODEL,
        outcome: "error",
        durationMs: Date.now() - startedAt,
        statusCode: null,
        error: error instanceof Error ? error.message : "unknown",
        promptChars,
        transcriptMessages,
      });
      console.warn("[launch-session] openrouter error", JSON.stringify({
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "unknown",
      }));
    }
  }

  return {
    ok: false,
    error: "Opus 4.6 did not return a usable launch-studio turn.",
    attempts,
  };
}

/**
 * Extract a partial `assistantMessage` value from an accumulating JSON string.
 * The tool_call arguments arrive as incremental JSON fragments; `assistantMessage`
 * is the first key, so we can progressively extract its growing value.
 *
 * Returns the decoded string content extracted so far, or null if the key hasn't
 * appeared yet.
 */
export function extractPartialAssistantMessage(accumulated: string): string | null {
  // Look for "assistantMessage":" (with or without spaces around the colon)
  const keyPattern = /"assistantMessage"\s*:\s*"/;
  const match = keyPattern.exec(accumulated);
  if (!match) return null;

  const start = match.index + match[0].length;
  // Walk forward from start, handling JSON escape sequences
  let result = "";
  let i = start;
  while (i < accumulated.length) {
    const char = accumulated[i];
    if (char === "\\") {
      // Escape sequence
      if (i + 1 >= accumulated.length) break; // incomplete escape at end
      const next = accumulated[i + 1];
      if (next === "n") { result += "\n"; i += 2; continue; }
      if (next === "t") { result += "\t"; i += 2; continue; }
      if (next === "r") { result += "\r"; i += 2; continue; }
      if (next === '"') { result += '"'; i += 2; continue; }
      if (next === "\\") { result += "\\"; i += 2; continue; }
      if (next === "/") { result += "/"; i += 2; continue; }
      if (next === "u") {
        // Unicode escape \uXXXX
        if (i + 5 < accumulated.length) {
          const hex = accumulated.slice(i + 2, i + 6);
          const code = parseInt(hex, 16);
          if (!Number.isNaN(code)) {
            result += String.fromCharCode(code);
            i += 6;
            continue;
          }
        }
        break; // incomplete unicode escape
      }
      // Unknown escape, just include it
      result += next;
      i += 2;
      continue;
    }
    if (char === '"') {
      // End of the string value
      break;
    }
    result += char;
    i += 1;
  }
  return result || null;
}

export type StreamingLaunchTurnEvent =
  | { type: "token"; content: string }
  | { type: "result"; generation: LaunchSessionTurnGeneration };

/**
 * Streaming variant of generateLaunchSessionTurn.
 * Makes the OpenRouter API call with stream: true and yields token events
 * as the assistantMessage is being generated. When the stream completes,
 * yields a result event with the full parsed generation.
 *
 * This is an async generator that the caller can iterate with `for await`.
 */
export async function* generateLaunchSessionTurnStreaming(input: {
  env: Env;
  mode: LaunchSessionMode;
  companyName?: string | null;
  idea: string;
  brief: LaunchSessionBrief;
  messages: LaunchSessionMessageInput[];
}): AsyncGenerator<StreamingLaunchTurnEvent> {
  const maxTokens = input.mode === "deep" ? 3000 : input.mode === "quick" ? 1800 : 2200;
  const promptChars = input.idea.length + JSON.stringify(input.brief).length + input.messages.reduce((total, message) => total + message.content.length, 0);
  const transcriptMessages = input.messages.length;
  const attempts: LaunchSessionTurnAttemptLog[] = [];
  const workingBrief = projectLaunchBriefFromConversation(input.brief, input.messages);
  const normalizedInput = {
    ...input,
    brief: workingBrief,
  };
  const launchTurnSchema = {
    type: "object",
    properties: {
      assistantMessage: { type: "string" },
      suggestedCompanyName: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      brief: {
        type: "object",
        properties: {
          concept: { type: "string" },
          targetCustomer: { type: "string" },
          painfulProblem: { type: "string" },
          firstOffer: { type: "string" },
          whyNow: { type: "string" },
          businessModel: { type: "string" },
          distributionWedge: { type: "string" },
          founderConstraints: { type: "array", items: { type: "string" } },
          autonomyBoundaries: { type: "array", items: { type: "string" } },
          founderSetupTasks: { type: "array", items: { type: "string" } },
          nonGoals: { type: "array", items: { type: "string" } },
          firstMilestone: { type: "string" },
          openQuestions: { type: "array", items: { type: "string" } },
          autonomyConfidence: { type: "number" },
        },
        required: [
          "concept",
          "targetCustomer",
          "painfulProblem",
          "firstOffer",
          "whyNow",
          "businessModel",
          "distributionWedge",
          "founderConstraints",
          "autonomyBoundaries",
          "founderSetupTasks",
          "nonGoals",
          "firstMilestone",
          "openQuestions",
          "autonomyConfidence",
        ],
        additionalProperties: false,
      },
      readiness: {
        type: "object",
        properties: {
          score: { type: "number" },
          ready: { type: "boolean" },
          blockers: { type: "array", items: { type: "string" } },
          strengths: { type: "array", items: { type: "string" } },
          nextBestQuestion: {
            anyOf: [{ type: "string" }, { type: "null" }],
          },
        },
        required: ["score", "ready", "blockers", "strengths", "nextBestQuestion"],
        additionalProperties: false,
      },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            founderReply: { type: "string" },
          },
          required: ["title", "description", "founderReply"],
          additionalProperties: false,
        },
      },
    },
    required: ["assistantMessage", "suggestedCompanyName", "brief", "readiness", "options"],
    additionalProperties: false,
  } as const;

  const systemPrompt = buildLaunchSystemPrompt(input.mode);

  const lockedDecisions = buildLockedDecisionSummary(workingBrief);
  const resolvedDecisionLabels = buildResolvedDecisionLabels(workingBrief);
  const unresolvedDecisions = buildUnresolvedDecisionSummary(workingBrief);
  const nextDecisionFocus = determineNextDecisionFocus(workingBrief);
  const founderSteering = buildFounderSteeringSummary(input.messages);
  const recentTurnSummary = buildRecentTurnSummary(input.messages);
  const userPrompt = buildLaunchUserPrompt({
    companyName: input.companyName,
    idea: input.idea,
    recentTurnSummary,
    lockedDecisions,
    unresolvedDecisions,
    resolvedDecisionLabels,
    nextDecisionFocus,
    founderSteering,
    workingBrief,
  });

  if (!input.env.OPENROUTER_API_KEY && !input.env.ANTHROPIC_API_KEY) {
    // No API keys — fall back to non-streaming generation
    const fallback = await generateLaunchSessionTurn(input);
    if (fallback.ok && fallback.result?.assistantMessage) {
      yield { type: "token", content: fallback.result.assistantMessage };
    }
    yield { type: "result", generation: fallback };
    return;
  }

  // Try Anthropic direct streaming first (lower latency)
  if (input.env.ANTHROPIC_API_KEY) {
    const anthropicStartedAt = Date.now();
    let anthropicSucceeded = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

      let anthropicResponse: Response;
      try {
        anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": input.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: ANTHROPIC_DIRECT_MODEL,
            max_tokens: maxTokens,
            stream: true,
            system: systemPrompt,
            messages: [
              { role: "user", content: userPrompt },
            ],
            tools: [
              {
                name: "submit_launch_turn",
                description: "Return the next cofounder turn and the updated structured launch brief.",
                input_schema: launchTurnSchema,
              },
            ],
            tool_choice: { type: "tool", name: "submit_launch_turn" },
          }),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        throw error;
      }

      if (!anthropicResponse.ok || !anthropicResponse.body) {
        clearTimeout(timer);
        const errorPreview = anthropicResponse.ok ? null : await extractErrorPreview(anthropicResponse);
        const durationMs = Date.now() - anthropicStartedAt;
        attempts.push({
          provider: "anthropic",
          model: ANTHROPIC_DIRECT_MODEL,
          outcome: "non_ok",
          durationMs,
          statusCode: anthropicResponse.status,
          error: errorPreview
            ? `Anthropic returned HTTP ${anthropicResponse.status}: ${errorPreview}`
            : `Anthropic returned HTTP ${anthropicResponse.status}.`,
          promptChars,
          transcriptMessages,
        });
        // Fall through to OpenRouter
      } else {
        // Read Anthropic SSE stream
        const reader = anthropicResponse.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = "";
        let accumulatedArgs = "";
        let lastEmittedLength = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            sseBuffer += decoder.decode(value, { stream: true });

            const lines = sseBuffer.split("\n");
            sseBuffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data:")) continue;
              const data = trimmed.slice(5).trim();
              if (data === "[DONE]") continue;

              let event: {
                type?: string;
                delta?: { type?: string; partial_json?: string };
                error?: { message?: string };
              };
              try {
                event = JSON.parse(data);
              } catch {
                continue;
              }

              if (event.error) {
                console.warn("[launch-session-stream] anthropic mid-stream error", event.error.message);
                continue;
              }

              // Anthropic streams tool use via content_block_delta with input_json_delta
              if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta" && event.delta.partial_json) {
                accumulatedArgs += event.delta.partial_json;

                const partial = extractPartialAssistantMessage(accumulatedArgs);
                if (partial && partial.length > lastEmittedLength) {
                  const newContent = partial.slice(lastEmittedLength);
                  lastEmittedLength = partial.length;
                  yield { type: "token", content: newContent };
                }
              }
            }
          }
        } finally {
          clearTimeout(timer);
          reader.releaseLock();
        }

        // Parse the accumulated Anthropic stream
        const durationMs = Date.now() - anthropicStartedAt;
        let normalized: LaunchSessionTurnResult | null = null;
        if (accumulatedArgs) {
          const parsed = parseJsonPayload(accumulatedArgs);
          if (parsed) {
            normalized = normalizeLaunchTurnResult(parsed, normalizedInput);
          }
          if (!normalized) {
            normalized = salvageLaunchTurnResult(accumulatedArgs, normalizedInput);
          }
        }

        console.log("[launch-session-stream] anthropic stream complete", JSON.stringify({
          durationMs,
          argsLength: accumulatedArgs.length,
          normalized: Boolean(normalized),
        }));

        if (normalized) {
          attempts.push({
            provider: "anthropic",
            model: ANTHROPIC_DIRECT_MODEL,
            outcome: "success",
            durationMs,
            statusCode: 200,
            error: null,
            promptChars,
            transcriptMessages,
          });
          yield { type: "result", generation: { ok: true, result: normalized, attempts } };
          anthropicSucceeded = true;
        } else {
          attempts.push({
            provider: "anthropic",
            model: ANTHROPIC_DIRECT_MODEL,
            outcome: "invalid_payload",
            durationMs,
            statusCode: 200,
            error: accumulatedArgs
              ? `Anthropic stream returned invalid launch payload: ${compactText(accumulatedArgs, 220)}`
              : "Anthropic stream returned empty arguments.",
            promptChars,
            transcriptMessages,
          });
          // Fall through to OpenRouter
        }
      }
    } catch (error) {
      attempts.push({
        provider: "anthropic",
        model: ANTHROPIC_DIRECT_MODEL,
        outcome: "error",
        durationMs: Date.now() - anthropicStartedAt,
        statusCode: null,
        error: error instanceof Error ? error.message : "unknown",
        promptChars,
        transcriptMessages,
      });
      console.warn("[launch-session-stream] anthropic error", JSON.stringify({
        durationMs: Date.now() - anthropicStartedAt,
        error: error instanceof Error ? error.message : "unknown",
      }));
      // Fall through to OpenRouter
    }

    if (anthropicSucceeded) {
      return;
    }
  }

  if (!input.env.OPENROUTER_API_KEY) {
    // No OpenRouter key and Anthropic failed — fall back to non-streaming
    const fallback = await generateLaunchSessionTurn(input);
    if (fallback.ok && fallback.result?.assistantMessage) {
      yield { type: "token", content: fallback.result.assistantMessage };
    }
    yield { type: "result", generation: { ...fallback, attempts: [...attempts, ...fallback.attempts] } };
    return;
  }

  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": input.env.FRONTEND_URL,
          "X-Title": "AI Combinator Launch Studio",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          max_tokens: maxTokens,
          temperature: 0.35,
          stream: true,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "submit_launch_turn",
                description: "Return the next cofounder turn and the updated structured launch brief.",
                parameters: launchTurnSchema,
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "submit_launch_turn" } },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }

    if (!response.ok) {
      clearTimeout(timer);
      const errorPreview = await extractErrorPreview(response);
      const durationMs = Date.now() - startedAt;
      attempts.push({
        provider: "openrouter",
        model: OPENROUTER_MODEL,
        outcome: "non_ok",
        durationMs,
        statusCode: response.status,
        error: errorPreview
          ? `OpenRouter returned HTTP ${response.status}: ${errorPreview}`
          : `OpenRouter returned HTTP ${response.status}.`,
        promptChars,
        transcriptMessages,
      });
      // Fall back to non-streaming generation for the retry
      const fallback = await generateLaunchSessionTurn(input);
      if (fallback.ok && fallback.result?.assistantMessage) {
        yield { type: "token", content: fallback.result.assistantMessage };
      }
      yield { type: "result", generation: { ...fallback, attempts: [...attempts, ...fallback.attempts] } };
      return;
    }

    if (!response.body) {
      clearTimeout(timer);
      attempts.push({
        provider: "openrouter",
        model: OPENROUTER_MODEL,
        outcome: "error",
        durationMs: Date.now() - startedAt,
        statusCode: 200,
        error: "OpenRouter returned an empty response body.",
        promptChars,
        transcriptMessages,
      });
      const fallback = await generateLaunchSessionTurn(input);
      if (fallback.ok && fallback.result?.assistantMessage) {
        yield { type: "token", content: fallback.result.assistantMessage };
      }
      yield { type: "result", generation: { ...fallback, attempts: [...attempts, ...fallback.attempts] } };
      return;
    }

    // Read the SSE stream from OpenRouter
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let accumulatedArgs = "";
    let lastEmittedLength = 0;
    let modelName: string | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = sseBuffer.split("\n");
        // Keep the last potentially incomplete line in the buffer
        sseBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;

          let chunk: {
            model?: string;
            choices?: Array<{
              delta?: {
                tool_calls?: Array<{
                  function?: { arguments?: string };
                }>;
                content?: string;
              };
              finish_reason?: string | null;
            }>;
            error?: { message?: string };
          };
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          if (chunk.error) {
            console.warn("[launch-session-stream] mid-stream error", chunk.error.message);
            continue;
          }

          if (chunk.model) {
            modelName = chunk.model;
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          // Accumulate tool_call arguments
          const argFragment = delta.tool_calls?.[0]?.function?.arguments;
          if (argFragment) {
            accumulatedArgs += argFragment;

            // Try to extract the assistantMessage progressively
            const partial = extractPartialAssistantMessage(accumulatedArgs);
            if (partial && partial.length > lastEmittedLength) {
              // Emit only the new content since last emission
              const newContent = partial.slice(lastEmittedLength);
              lastEmittedLength = partial.length;
              yield { type: "token", content: newContent };
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }

    // Stream complete — parse the accumulated arguments
    const durationMs = Date.now() - startedAt;
    let normalized: LaunchSessionTurnResult | null = null;
    if (accumulatedArgs) {
      const parsed = parseJsonPayload(accumulatedArgs);
      if (parsed) {
        normalized = normalizeLaunchTurnResult(parsed, normalizedInput);
      }
      if (!normalized) {
        normalized = salvageLaunchTurnResult(accumulatedArgs, normalizedInput);
      }
    }

    console.log("[launch-session-stream] stream complete", JSON.stringify({
      durationMs,
      model: modelName,
      argsLength: accumulatedArgs.length,
      normalized: Boolean(normalized),
    }));

    if (normalized) {
      attempts.push({
        provider: "openrouter",
        model: modelName ?? OPENROUTER_MODEL,
        outcome: "success",
        durationMs,
        statusCode: 200,
        error: null,
        promptChars,
        transcriptMessages,
      });
      yield { type: "result", generation: { ok: true, result: normalized, attempts } };
      return;
    }

    attempts.push({
      provider: "openrouter",
      model: modelName ?? OPENROUTER_MODEL,
      outcome: "invalid_payload",
      durationMs,
      statusCode: 200,
      error: accumulatedArgs
        ? `OpenRouter stream returned invalid launch payload: ${compactText(accumulatedArgs, 220)}`
        : "OpenRouter stream returned empty arguments.",
      promptChars,
      transcriptMessages,
    });
  } catch (error) {
    attempts.push({
      provider: "openrouter",
      model: OPENROUTER_MODEL,
      outcome: "error",
      durationMs: Date.now() - startedAt,
      statusCode: null,
      error: error instanceof Error ? error.message : "unknown",
      promptChars,
      transcriptMessages,
    });
    console.warn("[launch-session-stream] error", JSON.stringify({
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "unknown",
    }));
  }

  // Streaming failed — fall back to non-streaming
  const fallback = await generateLaunchSessionTurn(input);
  if (fallback.ok && fallback.result?.assistantMessage) {
    yield { type: "token", content: fallback.result.assistantMessage };
  }
  yield { type: "result", generation: { ...fallback, attempts: [...attempts, ...fallback.attempts] } };
}

function fallbackArtifacts(input: {
  companyName: string;
  idea: string;
  brief: LaunchSessionBrief;
}): LaunchSessionArtifacts {
  const name = input.companyName || fallbackCompanyName(input.idea);
  const companySpecMd = [
    `# ${name} Company Spec`,
    "",
    "## Concept",
    input.brief.concept || input.idea,
    "",
    "## Target Customer",
    input.brief.targetCustomer || "The first buyer still needs to be tightened.",
    "",
    "## Painful Problem",
    input.brief.painfulProblem || "The company must replace a painful recurring workflow, not just add an AI layer.",
    "",
    "## First Offer",
    input.brief.firstOffer || "The first offer should be a narrow, sellable wedge.",
    "",
    "## Why Now",
    input.brief.whyNow || "The wedge should exist because the team can move materially faster or exploit a new channel shift.",
    "",
    "## Business Model",
    input.brief.businessModel || "Charge for a recurring workflow or a measurable business outcome.",
    "",
    "## Distribution Wedge",
    input.brief.distributionWedge || "Start with one realistic channel the team can attack immediately.",
    "",
    "## Founder Constraints",
    ...input.brief.founderConstraints.map((item) => `- ${item}`),
    "",
    "## Founder Setup Tasks",
    ...input.brief.founderSetupTasks.map((item) => `- ${item}`),
    "",
    "## Non-Goals",
    ...input.brief.nonGoals.map((item) => `- ${item}`),
    "",
    "## First Milestone",
    input.brief.firstMilestone || "Ship a founder-visible first milestone with live user-facing output.",
    "",
    "## Autonomy Boundaries",
    ...input.brief.autonomyBoundaries.map((item) => `- ${item}`),
    "",
    "## Open Questions",
    ...input.brief.openQuestions.map((item) => `- ${item}`),
  ].join("\n");

  return {
    companySpecMd,
    missionMd: [
      "# Mission",
      "",
      `${name} exists to ${input.brief.concept || input.idea}.`,
      "",
      "## Founder Direction",
      input.brief.targetCustomer || "Win one specific customer type first and build from a narrow wedge.",
      "",
      "## What We Are Building First",
      input.brief.firstOffer || "A narrow first offer that can be sold, shipped, and improved quickly.",
      "",
      "## Operating Principles",
      "- Prefer concrete deliverables over analysis theatre.",
      "- Stay close to the first buyer and their painful workflow.",
      "- Escalate only when the founder is genuinely required.",
    ].join("\n"),
    firstMilestoneMd: [
      "# First Milestone",
      "",
      input.brief.firstMilestone || "Launch the first founder-visible wedge and prove the workflow end-to-end.",
    ].join("\n"),
    autonomyContractMd: [
      "# Autonomy Contract",
      "",
      "## The Team May Decide Without Asking",
      ...input.brief.autonomyBoundaries.map((item) => `- ${item}`),
      "",
      "## Founder-Required Actions",
      ...input.brief.founderSetupTasks.map((item) => `- ${item}`),
    ].join("\n"),
  };
}

export async function generateLaunchArtifacts(input: {
  env: Env;
  companyName: string;
  idea: string;
  brief: LaunchSessionBrief;
}): Promise<LaunchSessionArtifacts> {
  // Fallback chain: Anthropic direct → OpenRouter Sonnet → static artifacts
  if (input.env.ANTHROPIC_API_KEY) {
    const result = await tryGenerateArtifactsViaAnthropic(input);
    if (result) return result;
  }
  if (input.env.OPENROUTER_API_KEY) {
    const result = await tryGenerateArtifactsViaOpenRouter(input);
    if (result) return result;
  }
  return fallbackArtifacts(input);
}

const ARTIFACT_SYSTEM_PROMPT = [
  "You are writing the final company bootstrap package for an autonomous AI startup team.",
  "Turn the structured brief into founder-worthy documents that are operational, specific, and immediately useful.",
  "The team should be able to run for a long time from this package with minimal founder input.",
  "Write in markdown. Be concrete. Avoid fluff.",
  "missionMd must read like a strong manifesto, not a slogan.",
  "companySpecMd should be detailed, practical, and readable by both founder and CEO.",
  "firstMilestoneMd should define the first milestone in a founder-visible way.",
  "autonomyContractMd should clearly separate what the team may do alone from what still needs the founder.",
].join("\n");

const ARTIFACT_SCHEMA = {
  type: "object",
  properties: {
    companySpecMd: { type: "string", description: "Full company spec in markdown" },
    missionMd: { type: "string", description: "Mission manifesto in markdown" },
    firstMilestoneMd: { type: "string", description: "First milestone definition in markdown" },
    autonomyContractMd: { type: "string", description: "Autonomy contract in markdown" },
  },
  required: ["companySpecMd", "missionMd", "firstMilestoneMd", "autonomyContractMd"],
} as const;

function buildArtifactUserContent(input: { companyName: string; idea: string; brief: LaunchSessionBrief }): string {
  return [
    `Company name: ${input.companyName}`,
    `Original idea: ${input.idea}`,
    "",
    "Structured brief:",
    JSON.stringify(input.brief, null, 2),
  ].join("\n");
}

function parseArtifactResponse(parsed: Record<string, unknown>, input: { companyName: string; idea: string; brief: LaunchSessionBrief }): LaunchSessionArtifacts {
  const fallback = fallbackArtifacts(input);
  return {
    companySpecMd: sanitizeLine(parsed.companySpecMd as string | undefined, fallback.companySpecMd),
    missionMd: sanitizeLine(parsed.missionMd as string | undefined, fallback.missionMd),
    firstMilestoneMd: sanitizeLine(parsed.firstMilestoneMd as string | undefined, fallback.firstMilestoneMd),
    autonomyContractMd: sanitizeLine(parsed.autonomyContractMd as string | undefined, fallback.autonomyContractMd),
  };
}

type ArtifactInput = {
  env: Env;
  companyName: string;
  idea: string;
  brief: LaunchSessionBrief;
};

/** Try Anthropic direct; returns null on any failure so the caller can fall through. */
async function tryGenerateArtifactsViaAnthropic(input: ArtifactInput): Promise<LaunchSessionArtifacts | null> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": input.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ARTIFACT_ANTHROPIC_DIRECT_MODEL,
          max_tokens: 5000,
          system: ARTIFACT_SYSTEM_PROMPT,
          messages: [
            { role: "user", content: buildArtifactUserContent(input) },
          ],
          tools: [
            {
              name: "submit_artifacts",
              description: "Return the final company bootstrap artifacts.",
              input_schema: ARTIFACT_SCHEMA,
            },
          ],
          tool_choice: { type: "tool", name: "submit_artifacts" },
        }),
      },
      MODEL_TIMEOUT_MS,
    );
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as {
    content?: Array<{ type: string; text?: string; input?: Record<string, unknown> }>;
  };

  // Anthropic Messages API returns tool_use blocks in content array
  const toolUse = data.content?.find((block) => block.type === "tool_use");
  let parsed: Record<string, unknown> | null = null;
  if (toolUse && toolUse.input) {
    parsed = toolUse.input as Record<string, unknown>;
  }
  if (!parsed) {
    const textBlock = data.content?.find((block) => block.type === "text");
    parsed = parseJsonPayload(textBlock?.text?.trim() ?? "");
  }
  if (!parsed) {
    return null;
  }

  return parseArtifactResponse(parsed, input);
}

/** Try OpenRouter Sonnet; returns null on any failure so the caller can fall through. */
async function tryGenerateArtifactsViaOpenRouter(input: ArtifactInput): Promise<LaunchSessionArtifacts | null> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": input.env.FRONTEND_URL,
          "X-Title": "AI Combinator Launch Studio",
        },
        body: JSON.stringify({
          model: ARTIFACT_OPENROUTER_MODEL,
          max_tokens: 5000,
          messages: [
            { role: "system", content: ARTIFACT_SYSTEM_PROMPT },
            { role: "user", content: buildArtifactUserContent(input) },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "submit_artifacts",
                description: "Return the final company bootstrap artifacts.",
                parameters: ARTIFACT_SCHEMA,
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "submit_artifacts" } },
        }),
      },
      MODEL_TIMEOUT_MS,
    );
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
        content?: string;
      };
    }>;
  };
  const toolCall = data.choices?.[0]?.message?.tool_calls?.find(
    (tc) => tc.function?.name === "submit_artifacts",
  );
  const toolArgs = toolCall?.function?.arguments;

  let parsed: Record<string, unknown> | null = null;
  if (toolArgs) {
    parsed = parseJsonPayload(toolArgs);
  }
  if (!parsed) {
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    parsed = parseJsonPayload(raw);
  }
  if (!parsed) {
    return null;
  }

  return parseArtifactResponse(parsed, input);
}
