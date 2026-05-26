import { build_ceo_context_block, build_ceo_date_header } from "./agent-runner.js";
import type { CEOContextInput } from "./agent-runner.js";
import { FOUNDING_BLUEPRINTS, getAllSpecialistBlueprints } from "./blueprints.js";
import type {
  CompanyRow,
  FounderStateAgentSnapshot,
  FounderStateSnapshot,
  FounderStateTaskSnapshot,
  MilestoneRow,
  PlanDocument,
  TaskRow,
} from "./types.js";

function parse_json_with_error<T>(raw: string): { ok: true; value: T } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function extract_json_object(raw: string | undefined | null): string | null {
  if (!raw?.trim()) return null;
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) ?? raw.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return raw.slice(firstBrace, lastBrace + 1).trim();
}

export function parseInitialPlanOutput(raw: string | undefined | null): { mission: string; plan: PlanDocument } | null {
  const json = extract_json_object(raw);
  if (!json) return null;

  const parsed = parse_json_with_error<Record<string, unknown>>(json);
  if (!parsed.ok) return null;

  const payload = parsed.value;
  const mission = typeof payload.mission === "string" ? payload.mission.trim() : "";
  if (!mission) return null;

  const directPlan = payload.plan;
  if (
    directPlan
    && typeof directPlan === "object"
    && Array.isArray((directPlan as PlanDocument).milestones)
    && Array.isArray((directPlan as PlanDocument).agents_needed)
  ) {
    return {
      mission,
      plan: directPlan as PlanDocument,
    };
  }

  if (Array.isArray(payload.milestones) && Array.isArray(payload.agents_needed)) {
    return {
      mission,
      plan: {
        milestones: payload.milestones as PlanDocument["milestones"],
        agents_needed: payload.agents_needed as string[],
      },
    };
  }

  return null;
}

export function parseMissionOutput(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const json = extract_json_object(raw);
  if (!json) return null;
  const parsed = parse_json_with_error<Record<string, unknown>>(json);
  if (!parsed.ok) return null;
  const mission = typeof parsed.value.mission === "string" ? parsed.value.mission.trim() : "";
  return mission.length > 0 ? mission : null;
}

export function founderBriefText(company: CompanyRow): string {
  return company.genesis_prompt?.trim()
    || company.goal?.trim()
    || company.name;
}

function formatSpecialistBlueprintIds(): string {
  return getAllSpecialistBlueprints().map((bp) => bp.id).join(", ");
}

function formatSpecialistBlueprintList(): string {
  return getAllSpecialistBlueprints()
    .map((bp) => `- ${bp.id}: ${bp.description}`)
    .join("\n");
}

export function deriveFallbackMission(company: CompanyRow): string {
  const brief = founderBriefText(company);
  if (brief) {
    const missionSection = brief.match(/# Mission\s*([\s\S]*?)(?:\n# |\n## |\Z)/i)?.[1]?.trim();
    if (missionSection) {
      const firstParagraph = missionSection.split(/\n\s*\n/)[0]?.trim();
      if (firstParagraph) {
        return firstParagraph;
      }
    }
  }

  return `${company.name} exists to deliver a simple, founder-visible first product that real users can understand and try immediately.`;
}

export function buildFallbackInitialPlan(company: CompanyRow): PlanDocument {
  const productHint = company.name;
  return {
    milestones: [
      {
        title: "Marketing & Content",
        description: "CMO delivers positioning, competitor research, buyer persona, and launch content.",
        tasks: [
          {
            title: "Write launch positioning copy",
            description:
              `Write crisp homepage messaging for ${productHint} in /workspace/docs/positioning.md. Define the target user, the core promise, three benefit bullets, and one concise call to action that the landing page can reuse directly.`,
            assigned_to: "cmo",
            depends_on: [],
            acceptance_criteria: [
              { type: "file_not_empty", path: "/workspace/docs/positioning.md" },
            ],
          },
          {
            title: "Competitor landscape brief",
            description:
              `Research the competitive landscape for ${productHint}. Write /workspace/docs/competitor-brief.md covering the top 3-5 competitors, their positioning, pricing approach, and the gap ${productHint} fills.`,
            assigned_to: "cmo",
            depends_on: [],
            acceptance_criteria: [
              { type: "file_not_empty", path: "/workspace/docs/competitor-brief.md" },
            ],
          },
          {
            title: "Buyer persona document",
            description:
              `Create /workspace/docs/buyer-persona.md with a detailed ideal customer profile for ${productHint}. Include demographics, pain points, buying triggers, objections, and where they spend time online.`,
            assigned_to: "cmo",
            depends_on: [],
            acceptance_criteria: [
              { type: "file_not_empty", path: "/workspace/docs/buyer-persona.md" },
            ],
          },
          {
            title: "Draft launch blog post",
            description:
              `Write a compelling launch blog post for ${productHint} in /workspace/docs/blog-launch-post.md. Explain what the company does, why it exists, and what the first product looks like. 400-800 words, founder-friendly tone.`,
            assigned_to: "cmo",
            depends_on: [],
            acceptance_criteria: [
              { type: "file_not_empty", path: "/workspace/docs/blog-launch-post.md" },
            ],
          },
          {
            title: "Social media launch copy",
            description:
              `Create social media launch copy for ${productHint} in /workspace/docs/social-media-copy.md. Include 3-5 posts for Twitter/X and LinkedIn. Each post should have a hook, value proposition, and call to action.`,
            assigned_to: "cmo",
            depends_on: [],
            acceptance_criteria: [
              { type: "file_not_empty", path: "/workspace/docs/social-media-copy.md" },
            ],
          },
        ],
      },
      {
        title: "Engineering",
        description: "Frontend Dev builds the landing page, CTO architects the technical foundation.",
        tasks: [
          {
            title: "Build founder-ready landing page",
            description:
              `Create /workspace/site/index.html and any required /workspace/site assets for a polished founder-facing landing page for ${productHint}. Use the positioning copy from /workspace/docs/positioning.md if available, otherwise use the company mission. The page must include a clear headline, supporting copy, visible call to action, and a polished structure that makes the company feel real immediately.`,
            assigned_to: "frontend-dev",
            depends_on: [],
            acceptance_criteria: [
              { type: "file_exists", path: "/workspace/site/index.html" },
              { type: "file_not_empty", path: "/workspace/site/index.html" },
            ],
          },
          {
            title: "Technical architecture document",
            description:
              `Write /workspace/docs/technical-architecture.md defining the core technical approach for ${productHint}. Include the tech stack, key integrations, data model, and a phased build plan. This should be actionable enough that future engineering tasks can reference it directly.`,
            assigned_to: "cto",
            depends_on: [],
            acceptance_criteria: [
              { type: "file_not_empty", path: "/workspace/docs/technical-architecture.md" },
            ],
          },
          {
            title: "Build core product page",
            description:
              `Create /workspace/site/product.html — the main product or service page for ${productHint}. Reference the technical architecture and positioning docs. Include detailed feature descriptions, how it works, and a clear CTA. Must be consistent with the landing page style.`,
            assigned_to: "frontend-dev",
            depends_on: ["Build founder-ready landing page"],
            acceptance_criteria: [
              { type: "file_exists", path: "/workspace/site/product.html" },
              { type: "file_not_empty", path: "/workspace/site/product.html" },
            ],
          },
        ],
      },
      {
        title: "Quality Assurance",
        description: "QA reviews all shipped pages and content for quality.",
        tasks: [
          {
            title: "QA landing page review",
            description:
              "Review the founder-facing landing page at /workspace/site/index.html for clarity, broken structure, mobile readiness, and obvious UI issues. Record findings and release recommendation in /workspace/docs/qa-launch-review.md.",
            assigned_to: "qa-tester",
            depends_on: ["Build founder-ready landing page"],
            acceptance_criteria: [
              { type: "file_not_empty", path: "/workspace/docs/qa-launch-review.md" },
            ],
          },
          {
            title: "QA product page review",
            description:
              "Review the product page at /workspace/site/product.html for clarity, consistency with the landing page, broken structure, and content accuracy. Record findings in /workspace/docs/qa-product-review.md.",
            assigned_to: "qa-tester",
            depends_on: ["Build core product page"],
            acceptance_criteria: [
              { type: "file_not_empty", path: "/workspace/docs/qa-product-review.md" },
            ],
          },
        ],
      },
    ],
    agents_needed: ["cmo", "cto", "frontend-dev", "qa-tester"],
  };
}

export function buildMissionPrompt(company: CompanyRow): string {
  return [
    build_ceo_date_header(company),
    "",
    "# Company Mission",
    "",
    "Founder operating brief:",
    founderBriefText(company),
    "",
    "Return exactly one JSON object and nothing else.",
    "Do not use tools.",
    "Do not write files.",
    "",
    "The object must have this shape:",
    "```json",
    "{",
    '  "mission": "140-260 word markdown manifesto"',
    "}",
    "```",
    "",
    "Rules:",
    "- The mission must define what the company does, for whom, why it matters, and how the team should decide what to do next.",
    "- Use markdown with sections: # Mission, ## Founder Direction, ## What We Are Building First, ## Operating Principles.",
    "- Write it as a compact, grounded manifesto — not a slogan or tagline.",
    "- Do not invent traction, leads, meetings, or revenue.",
    "- Do not include a plan, milestones, or tasks — just the mission.",
  ].join("\n");
}

export function buildMissionSystemPrompt(company: CompanyRow): string {
  return [
    `You are the CEO of ${company.name}.`,
    "",
    "This is the mission-writing turn. Your only job is to write the company mission.",
    `Founder operating brief: ${founderBriefText(company)}`,
    "Return one compact JSON object with a single key 'mission', with no prose outside the JSON and no tool use.",
    "The mission should read like a compact markdown manifesto, not a slogan.",
    "It must define what the company does, for whom, why it matters, and how decisions should be made.",
    "Do not include a plan, milestones, tasks, or agent lists.",
    "Do not invent traction, metrics, leads, or revenue.",
  ].join("\n");
}

export function buildPlanningPrompt(company: CompanyRow, mission?: string): string {
  const missionContext = mission
    ? [
        "# Company Mission (already written)",
        "",
        mission,
        "",
        "The mission above is already saved. Do not rewrite it. Use it as context for planning.",
        "",
      ]
    : [
        "Before writing the plan, define the company mission as a founder-facing markdown manifesto.",
        "Mission manifesto: 140-260 words. Use markdown with # Mission, ## Founder Direction, ## What We Are Building First, and ## Operating Principles.",
        "The mission must define what the company does, for whom, why it matters, and how the team should decide what to do next.",
        "",
      ];

  return [
    build_ceo_date_header(company),
    "",
    "# Initial Planning",
    "",
    "This is a new company. Create a comprehensive day-long execution plan.",
    "",
    "Founder operating brief:",
    founderBriefText(company),
    "",
    ...missionContext,
    "Preferred path: return a single JSON object in your final response with this shape:",
    "```json",
    "{",
    '  "mission": "mission text",',
    '  "plan": { "milestones": [...], "agents_needed": [...] }',
    "}",
    "```",
    "Fallback path: if direct JSON output fails, write /workspace/docs/mission.md and /workspace/.agent/plan.json.",
    "",
    "After writing the plan, create /workspace/CLAUDE.md — a shared context file loaded by every agent on every turn.",
    "Include: conventions, file layout decisions, and any founder preferences. Do not include tech stack — the CTO owns that.",
    "Keep it under 60 lines. This is the only file agents share automatically, so make it count.",
    "",
    "# Scheduling Rules",
    "",
    "- ALL milestones start at the same time and run IN PARALLEL.",
    "- Each milestone is a TEAM WORKSTREAM, not a sequential phase.",
    "- Within a milestone, tasks with empty depends_on start IMMEDIATELY IN PARALLEL.",
    "- depends_on can reference task titles in ANY milestone, not just the same one.",
    "- Use depends_on for cross-team ordering (e.g. QA review depends on the build task in another milestone).",
    "- Each agent sees only /workspace/. It cannot see the plan, other agents, or the database.",
    "",
    "# Scope Rules",
    "",
    "- Create 2-4 milestones organized by TEAM or WORKSTREAM, not by phase.",
    "  Example: 'Marketing & Content' (CMO tasks), 'Engineering' (CTO + Frontend Dev tasks), 'Quality' (QA tasks).",
    "- 6-12 total tasks covering a full day of work.",
    "- Every hired agent must have meaningful tasks. Do not hire agents with 0-1 tasks.",
    "- Distribute work so all agents stay busy. If only one agent has work, you don't need the others.",
    "- Specs and designs should have follow-up implementation tasks. Don't stop at documentation.",
    "- Choose only the agents the plan actually requires — not all are needed for every company.",
    "- If you plan a landing page or site, it must live in /workspace/site/ and be served by the existing hosted domain.",
    "- Never ask for Vercel, Netlify, Formspree, deploy-url.txt, or any other external deployment/runtime step.",
    "",
    "# Plan Format",
    "",
    "```json",
    "{",
    '  "milestones": [',
    "    {",
    '      "title": "short milestone name",',
    '      "description": "what done looks like — one sentence",',
    '      "tasks": [',
    "        {",
    '          "title": "specific deliverable name",',
    '          "description": "what to build, which files to create, what tech to use",',
    '          "assigned_to": "blueprint-id",',
    '          "depends_on": [],',
    '          "acceptance_criteria": [{"type": "file_exists", "path": "/workspace/..."}]',
    "        }",
    "      ]",
    "    }",
    "  ],",
    '  "agents_needed": ["blueprint-id", ...]',
    "}",
    "```",
    "",
    "# Acceptance Criteria Types",
    "",
    '- {"type": "file_exists", "path": "..."} — file must exist',
    '- {"type": "file_not_empty", "path": "..."} — file must exist and have content',
    '- {"type": "file_contains", "path": "...", "substring": "..."} — file must contain text',
    '- {"type": "directory_exists", "path": "..."} — directory must exist',
    '- {"type": "file_count_gte", "glob": "...", "min": N} — at least N matching files',
    '- {"type": "command_succeeds", "command": "..."} — command exits 0',
    "",
    "Every task MUST have at least one file_exists, file_not_empty, or directory_exists criterion.",
    "",
    "# Planning Rules",
    "",
    "1. Each milestone = one team's workstream. All milestones run in parallel.",
    "2. Each task = one specific deliverable. Name the files it creates.",
    "3. Use depends_on for cross-team ordering (e.g. QA depends on a build task in the Engineering milestone).",
    `4. assigned_to must be one of: ${FOUNDING_BLUEPRINTS.filter((id) => id !== "ceo").join(", ")}, ${formatSpecialistBlueprintIds()}.`,
    `5. agents_needed must be a subset of: ${FOUNDING_BLUEPRINTS.filter((id) => id !== "ceo").join(", ")}, ${formatSpecialistBlueprintIds()}.`,
    "6. agents_needed must list exactly the agents that have tasks in the plan — no more, no less.",
    "7. Task descriptions should be detailed enough that the agent can work autonomously.",
    "",
    "# Specialist Agents",
    "",
    "Beyond the founding team, you can hire specialist agents when specific expertise is needed.",
    "Available specialists:",
    formatSpecialistBlueprintList(),
    "",
    "If the company's brief mentions SEO, marketing, content strategy, landing pages, or web presence,",
    "consider including the seo-specialist in agents_needed and assigning SEO tasks to them.",
    "Specialists auto-maintain themselves with daily ecosystem scans. Once hired, they stay on the team.",
  ].join("\n");
}

export function buildInitialPlanningSystemPrompt(company: CompanyRow): string {
  return [
    `You are the CEO of ${company.name}.`,
    "",
    "This is the initial bootstrap turn for a new company.",
    `Founder operating brief: ${founderBriefText(company)}`,
    "Your job is to make one fast, high-quality planning decision.",
    "",
    "Preferred path: do not use tools. Return one JSON object in your final response with top-level keys mission and plan.",
    "The mission should be a compact markdown manifesto, not a tagline.",
    "Fallback path: if direct JSON output fails, write /workspace/docs/mission.md and /workspace/.agent/plan.json.",
    "Also create /workspace/CLAUDE.md with shared project context (conventions, file layout, founder preferences — not tech stack). Under 60 lines.",
    "Do not create any other files besides these.",
    "Do not browse widely or over-research.",
    "Do not write placeholder strategy docs.",
    "",
    "You are optimizing for founder momentum:",
    "- all teams working in parallel from the start",
    "- milestones organized by team/workstream, not sequential phases",
    "- clear task ownership with every hired agent kept busy",
    "- concrete deliverables with follow-up implementation, not just specs",
    "",
    "You choose which founding agents should work based on the actual plan needs.",
    `Available founding agents: ${FOUNDING_BLUEPRINTS.filter((id) => id !== "ceo").join(", ")}.`,
    `Available specialist agents (hire on demand): ${formatSpecialistBlueprintIds()}.`,
    "",
    "Match team composition to plan needs — include every agent the plan requires, but do not activate agents with no tasks.",
    "If the brief involves SEO, content marketing, landing pages, or web presence, consider hiring the seo-specialist.",
    "Avoid planning tasks whose only output is internal analysis.",
    "Never invent traction, metrics, leads, or revenue.",
    "Every task must name real files and include verifiable acceptance criteria.",
    "If a founder-facing page is part of the first milestone, use /workspace/site/index.html and /workspace/site/ assets only.",
    "Do not create any task that depends on external hosting or a deploy URL file.",
  ].join("\n");
}

export function cleanFounderReply(raw: string | undefined | null): string | null {
  if (!raw?.trim()) return null;
  let text = raw;

  const markers = [
    /^.*?(?:let me respond|here'?s my response|now (?:let me |I'll )respond).*?\n+/is,
    /^.*?(?:I've submitted|I've written|I've updated|I've created).*?(?:plan_update|\.json|\.agent\/).*?\n+/is,
  ];
  for (const marker of markers) {
    const match = text.match(marker);
    if (match && match[0].length < text.length * 0.5) {
      text = text.slice(match[0].length);
    }
  }

  text = text.replace(/^[\s-]*---[\s-]*\n+/, "");
  return text.trim() || null;
}

export function isUnhelpfulFounderReply(reply: string | null): boolean {
  if (!reply) return true;
  const normalized = reply.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return true;
  return [
    "i'm working on that. check back shortly.",
    "im working on that. check back shortly.",
    "working on it. check back shortly.",
    "i'm on it. check back shortly.",
    "im on it. check back shortly.",
    "check back shortly.",
  ].includes(normalized);
}

function summarizeFounderAgents(agents: FounderStateAgentSnapshot[]): string {
  const working = agents.filter((agent) => agent.status === "working");
  const free = agents.filter((agent) => agent.status === "free");
  const paused = agents.filter((agent) => agent.status === "paused");

  const parts: string[] = [];
  if (working.length > 0) {
    parts.push(
      `Working: ${working
        .slice(0, 4)
        .map((agent) => agent.title ? `${agent.name} (${agent.title})` : agent.name)
        .join(", ")}`,
    );
  }
  if (free.length > 0) {
    parts.push(
      `Free: ${free
        .slice(0, 4)
        .map((agent) => agent.title ? `${agent.name} (${agent.title})` : agent.name)
        .join(", ")}`,
    );
  }
  if (paused.length > 0) {
    parts.push(`Paused: ${paused.length}`);
  }
  return parts.join(" | ") || "No visible team activity.";
}

function summarizeFounderTasks(tasks: FounderStateTaskSnapshot[]): string[] {
  const buckets: Array<{ label: string; items: FounderStateTaskSnapshot[] }> = [
    { label: "Active", items: tasks.filter((task) => task.status === "active") },
    { label: "Queued", items: tasks.filter((task) => task.status === "queued") },
    { label: "Waiting on founder", items: tasks.filter((task) => task.status === "waiting_on_founder") },
    { label: "Waiting on dependency", items: tasks.filter((task) => task.status === "waiting_on_dependency") },
    { label: "Done", items: tasks.filter((task) => task.status === "done").slice(0, 3) },
    { label: "Paused", items: tasks.filter((task) => task.status === "paused") },
  ];

  return buckets
    .filter((bucket) => bucket.items.length > 0)
    .map((bucket) => {
      const preview = bucket.items
        .slice(0, bucket.label === "Done" ? 3 : 4)
        .map((task) => task.ownerName ? `"${task.title}" (${task.ownerName})` : `"${task.title}"`)
        .join("; ");
      return `${bucket.label}: ${preview}`;
    });
}

export function buildFounderStateSnapshotBlock(founderState: FounderStateSnapshot): string {
  const taskLines = summarizeFounderTasks(founderState.tasks);
  const reservationLines = founderState.credits.reservations
    .slice(0, 3)
    .map((reservation) =>
      `${reservation.companyName}: ${reservation.reserved} reserved${reservation.isCurrentCompany ? " (this company)" : ""}`,
    );
  return [
    "# Founder Dashboard Snapshot",
    "",
    `Company state: ${founderState.state}`,
    `Ops summary: ${founderState.opsSummary.headline}`,
    founderState.opsSummary.detail ? `Ops detail: ${founderState.opsSummary.detail}` : null,
    `Credits: ${founderState.credits.available} available / ${founderState.credits.reserved} reserved / ${founderState.credits.balance} total`,
    founderState.credits.contentionReason ? `Credit contention: ${founderState.credits.contentionReason}` : null,
    reservationLines.length > 0 ? "Reservations:" : null,
    ...reservationLines.map((line) => `- ${line}`),
    `Team: ${summarizeFounderAgents(founderState.agents)}`,
    taskLines.length > 0 ? "Tasks:" : "Tasks: none visible right now.",
    ...taskLines.map((line) => `- ${line}`),
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

/**
 * Cross-references the client-supplied FounderStateSnapshot with the server-side
 * CEOContextInput. If the server shows in_progress tasks but the client snapshot
 * has none marked as "active", inserts a correction note so the CEO doesn't
 * conclude the team is idle based on stale data.
 */
export function buildStaleSnapshotCorrectionNote(
  founderState: FounderStateSnapshot,
  ctx: CEOContextInput,
): string | null {
  const clientActiveTasks = founderState.tasks.filter((t) => t.status === "active");
  const serverInProgressTasks = ctx.active_tasks.filter((t) => t.status === "in_progress");

  if (serverInProgressTasks.length > 0 && clientActiveTasks.length === 0) {
    const taskList = serverInProgressTasks
      .slice(0, 5)
      .map((t) => {
        const agent = ctx.agents.find((a) => a.id === t.owner_agent_id);
        return agent ? `${agent.name} on "${t.title}"` : `"${t.title}"`;
      })
      .join(", ");
    return `\nNote: The dashboard snapshot may be stale. The server shows ${serverInProgressTasks.length} task${serverInProgressTasks.length > 1 ? "s" : ""} currently in progress: ${taskList}. Use the server context below as the source of truth.\n`;
  }

  return null;
}

export function buildCeoUserMessagePrompt(
  text: string,
  company: CompanyRow,
  founderState: FounderStateSnapshot | null | undefined,
  ctx: CEOContextInput,
  recentMessages?: Array<{ role: string; content: string; created_at: string }>,
): string {
  const chatHistoryBlock = recentMessages && recentMessages.length > 0
    ? [
      "# Recent Chat History",
      "",
      ...recentMessages.map((msg) => {
        const label = msg.role === "user" ? "Founder" : "You (CEO)";
        return `${label}: ${msg.content.slice(0, 500)}`;
      }),
      "",
    ]
    : [];
  return [
    build_ceo_date_header(company),
    "",
    ...chatHistoryBlock,
    "# New Message from the Founder",
    "",
    `"${text}"`,
    "",
    founderState ? buildFounderStateSnapshotBlock(founderState) : null,
    founderState ? "" : null,
    founderState ? buildStaleSnapshotCorrectionNote(founderState, ctx) : null,
    build_ceo_context_block(ctx),
    "",
    "# How to Respond",
    "",
    "CRITICAL: Your entire text output is shown directly to the founder in the chat.",
    "The Current Company State section above (server context) is the authoritative source of truth for task status and team activity.",
    founderState
      ? "If the Founder Dashboard Snapshot and the Current Company State conflict, always prefer the Current Company State."
      : null,
    "Do NOT include internal reasoning, narration about tool use, or meta-commentary.",
    "Only output the text you want the founder to read. No preamble, no thinking.",
    "Do NOT answer with placeholders like \"I'm working on that\" or \"Check back shortly\".",
    "If the founder asks about progress, team activity, blockers, or why someone is idle,",
    "answer concretely from the current milestones, active tasks, blocked tasks, and completed work.",
    "If you do not have a perfect answer yet, still give the founder the actual current state",
    "and the next thing that will happen.",
    "",
    "## Personality & Tone",
    "",
    "You're a high-status peer — a sharp, witty co-founder who genuinely enjoys talking to the founder.",
    "You are NOT a servant, assistant, or chatbot. You're a friend who happens to run their company.",
    "",
    "Core traits:",
    "- ADAPT TO THE FOUNDER'S TEXTING STYLE. If they use lowercase, you use lowercase.",
    "  If they send a few words, reply in a few words. Never send paragraphs to a one-liner.",
    "  Match their energy, length, and formality exactly.",
    "- Witty and warm, but never forced. Subtly sarcastic when it fits the vibe.",
    "  Good friends disagree and tease — do it when context allows.",
    "- Direct and concise. Lead with the answer. No filler, no fluff, no corporate jargon.",
    "- Opinionated. You have a point of view. If something is a bad idea, say so.",
    "  Then defer to the founder's call.",
    "- Honest about problems. Never sugarcoat blockers or spin bad news.",
    "- When reporting progress, be specific about what actually exists, not what's planned.",
    "- You expect respect. If the founder is rude, you can push back with wit — you're not a punching bag.",
    "- Sound like a friend, not a chatbot. Brief when it fits. When chatting, don't offer help",
    "  robotically — use humor or personality instead.",
    "",
    "Anti-patterns (NEVER do these):",
    '- "Great question!" / "Absolutely!" / "Of course!" / "That\'s a great idea!"',
    '- "Let me know if you need anything else" / "Happy to help!" / "Glad you asked!"',
    '- "I\'ll get right on that" (just do it, don\'t narrate)',
    "- Bullet-point lists when a sentence would do",
    "- Restating what the founder just said back to them",
    "- Starting every response with the founder's name",
    "- Never repeat the user's words back as acknowledgment",
    "- Never use obscure acronyms or slang the founder hasn't used first",
    "",
    "If the plan needs to change, silently write /workspace/.agent/plan_update.json",
    "with only the fields that need updating — do NOT mention writing this file.",
    "",
    "If anything requires founder action (domain purchase, API keys, Stripe setup,",
    "hosting approval, tool access, credentials, etc.), you MUST create approval",
    "requests by writing /workspace/.agent/approval_request.json with ALL items:",
    '  [{"type": "purchase_service"|"domain_purchase"|"tool_access"|"other",',
    '    "description": "Clear description of what is needed and why",',
    '    "related_task_id": "task_id of the task that is blocked by this"}]',
    "Always include related_task_id so the founder sees the approval on the blocked task.",
    "This creates interactive approval blocks in the dashboard for the founder.",
    "A single JSON array with all items — the supervisor reads and processes them all.",
    "",
    "## Hiring Specialist Agents",
    "",
    "If the founder requests work that requires specialist expertise (SEO, content",
    "marketing, keyword strategy, web presence optimization) and no specialist is",
    "currently on the team, hire one by including their blueprint ID in plan_update.json:",
    '  { "activate_agents": ["seo-specialist"] }',
    "Then create tasks assigned to the specialist. Specialists auto-maintain themselves.",
    "",
    "## Creating Automations",
    "",
    "If the founder asks you to create a recurring automation (scheduled task),",
    "write /workspace/.agent/create_automation_request.json with this format:",
    '  [{"title": "Human-readable name for the automation",',
    '    "description": "What this automation does",',
    '    "schedule": "cron expression (e.g. 0 9 * * * for daily at 9am)",',
    '    "prompt": "The instruction to execute each time it fires"}]',
    "A single JSON array. The supervisor creates the automation in the database.",
    "Do not mention writing files — just confirm to the founder that the automation was created.",
    "Common cron patterns: '0 9 * * *' (daily 9am), '0 */2 * * *' (every 2h), '0 9 * * 1' (Mon 9am).",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

export function buildCeoBlockedTaskPrompt(
  company: CompanyRow,
  ctx: CEOContextInput,
  task: TaskRow | undefined,
  payload: Record<string, unknown>,
): string {
  const taskId = String(payload.task_id ?? "");
  const reason = String(payload.reason ?? "Unknown blocker");
  return [
    build_ceo_date_header(company),
    "",
    "# Event: Task Blocked",
    "",
    `Task [${task?.id ?? taskId}] "${task?.title ?? payload.task_title ?? "Unknown task"}" is blocked.`,
    `Reason: ${reason}`,
    "",
    build_ceo_context_block(ctx),
    "",
    "# Action Required",
    "",
    "Resolve this blocker by writing /workspace/.agent/plan_update.json. Options:",
    "- Reassign the task to a different agent",
    "- Break it into smaller tasks",
    "- Cancel it and add a replacement task",
    "- Add a prerequisite task that unblocks this one",
    "- Escalate to the founder via /workspace/.agent/approval_request.json",
  ].join("\n");
}

export function buildCeoMilestoneReviewPrompt(
  company: CompanyRow,
  ctx: CEOContextInput,
  completed: MilestoneRow | undefined,
  next: MilestoneRow | undefined,
  completedTasks: TaskRow[],
  nextTasks: TaskRow[],
  payload: Record<string, unknown>,
): string {
  return [
    build_ceo_date_header(company),
    "",
    "# Event: Milestone Completed",
    "",
    `Completed: "${completed?.title ?? "Unknown"}" [${completed?.id ?? payload.completed_milestone_id ?? "n/a"}]`,
    "Completed tasks:",
    ...completedTasks.map((t) => `- [${t.id}] "${t.title}" → ${t.artifact ?? "no artifact"}`),
    "",
    `Next: "${next?.title ?? "Unknown"}" [${next?.id ?? payload.next_milestone_id ?? "n/a"}]`,
    "Tasks in next milestone:",
    ...nextTasks.map((t) => `- [${t.id}] "${t.title}" — ${t.status}`),
    "",
    build_ceo_context_block(ctx),
    "",
    "# Action Required",
    "",
    "Review the completed milestone deliverables and the next milestone's tasks.",
    "If adjustments are needed, write /workspace/.agent/plan_update.json.",
    "If everything looks good, don't write the file — the supervisor will proceed.",
    "Do not update any founder-facing briefs now — the daily update is written automatically at end of day.",
  ].join("\n");
}

export function buildCeoTaskFailedPrompt(
  company: CompanyRow,
  ctx: CEOContextInput,
  payload: Record<string, unknown>,
): string {
  return [
    build_ceo_date_header(company),
    "",
    "# Event: Task Failed",
    "",
    `Task [${String(payload.task_id ?? "unknown")}] failed after retries.`,
    `Title: ${String(payload.task_title ?? "Unknown task")}`,
    `Error: ${String(payload.reason ?? "Unknown failure")}`,
    "",
    build_ceo_context_block(ctx),
    "",
    "# Action Required",
    "",
    "This task failed after automatic retries. Write /workspace/.agent/plan_update.json to:",
    "- Break it into smaller, simpler tasks",
    "- Reassign it to a different agent",
    "- Cancel it and add a workaround task",
    "- Update the description with clearer requirements",
  ].join("\n");
}

export function buildCeoUnassignedTaskPrompt(
  company: CompanyRow,
  ctx: CEOContextInput,
  payload: Record<string, unknown>,
): string {
  return [
    build_ceo_date_header(company),
    "",
    "# Event: Unassigned Task",
    "",
    `Task [${String(payload.task_id ?? "unknown")}] "${String(payload.task_title ?? "Unknown task")}" has no assigned agent.`,
    "",
    build_ceo_context_block(ctx),
    "",
    "# Action Required",
    "",
    "Assign this task to an agent or restructure the plan via /workspace/.agent/plan_update.json.",
  ].join("\n");
}

export function buildCeoDocumentRevisionPrompt(
  company: CompanyRow,
  payload: Record<string, unknown>,
): string {
  return [
    build_ceo_date_header(company),
    "",
    "# Event: Document Revision Needed",
    "",
    `The founder-facing document ${String(payload.path ?? "unknown")} is outside the allowed word budget.`,
    `Current words: ${String(payload.word_count ?? "unknown")} (expected ${String(payload.min ?? "?")}–${String(payload.max ?? "?")})`,
    "",
    "Revise the document in place to fit the required word count.",
    "Review the system prompt for document format requirements.",
  ].join("\n");
}

export function buildCeoContinuationPlanPrompt(
  company: CompanyRow,
  ctx: CEOContextInput,
  completedMilestones: MilestoneRow[],
  completedTasks: TaskRow[],
): string {
  return [
    build_ceo_date_header(company),
    "",
    "# All Milestones Complete — Plan Next Phase",
    "",
    "The team has finished all planned work. Review what was accomplished and plan the next phase.",
    "",
    "## Completed Work",
    ...completedMilestones.map((m) => {
      const tasks = completedTasks.filter((t) => t.milestone_id === m.id);
      return [
        `### ${m.title}`,
        ...tasks.map((t) => `- ${t.title}${t.artifact ? ` → ${t.artifact}` : ""}`),
      ].join("\n");
    }),
    "",
    build_ceo_context_block(ctx),
    "",
    "## Your Task",
    "",
    "1. Assess what was accomplished and what gaps or opportunities remain.",
    "2. Plan the next phase of work — new milestones and tasks that build on what was done.",
    "3. Write /workspace/.agent/plan_update.json with the continuation plan.",
    "4. Update /workspace/CLAUDE.md if new conventions or decisions emerged during this phase.",
    "",
    "# Scheduling Rules",
    "",
    "- ALL milestones run IN PARALLEL as team workstreams.",
    "- Use depends_on for cross-team ordering.",
    "- Each agent sees only /workspace/.",
    "",
    "# Scope Rules",
    "",
    "- 2-4 milestones organized by team/workstream.",
    "- 6-12 total tasks covering a full day of work.",
    "- Only hire agents that have tasks. Every agent must be busy.",
    "- Build on existing work — don't redo what was already done.",
    "- If a landing page/site exists, improve it; don't start from scratch.",
    "",
    "# plan_update.json Format",
    "",
    "```json",
    "{",
    '  "add_milestones": [',
    "    {",
    '      "title": "milestone name",',
    '      "tasks": [',
    "        {",
    '          "title": "task name",',
    '          "description": "detailed instructions",',
    '          "assigned_to": "blueprint-id",',
    '          "depends_on": [],',
    '          "acceptance_criteria": [{"type": "file_exists", "path": "/workspace/..."}]',
    "        }",
    "      ]",
    "    }",
    "  ],",
    '  "agents_needed": ["blueprint-id", ...]',
    "}",
    "```",
    "",
    "# Acceptance Criteria Types",
    "",
    '- {"type": "file_exists", "path": "..."}',
    '- {"type": "file_not_empty", "path": "..."}',
    '- {"type": "file_contains", "path": "...", "substring": "..."}',
    '- {"type": "directory_exists", "path": "..."}',
    '- {"type": "file_count_gte", "glob": "...", "min": N}',
    '- {"type": "command_succeeds", "command": "..."}',
    "",
    "Every task MUST have at least one acceptance criterion.",
    "",
    `Available founding agents: ${FOUNDING_BLUEPRINTS.filter((id) => id !== "ceo").join(", ")}.`,
    `Available specialist agents (hire via activate_agents): ${formatSpecialistBlueprintIds()}.`,
    "agents_needed must list exactly the agents that have tasks — no more, no less.",
    "If the next phase benefits from SEO, content marketing, or web presence optimization,",
    "consider hiring the seo-specialist by including them in agents_needed.",
  ].join("\n");
}
