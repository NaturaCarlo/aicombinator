import type { Env } from "../types.js";

const OPENROUTER_TIMEOUT_MS = 30000;
const LUCKY_IDEA_FALLBACKS = [
  {
    name: "PermitPilot",
    idea: "An AI permit desk for small construction contractors that reads city permit requirements, assembles the application packet, flags missing documents, and tracks approval deadlines so jobs stop slipping before they start.",
  },
  {
    name: "ClaimHarbor",
    idea: "A claims operations copilot for independent dental clinics that turns insurer remittance files into clear explanations of denials, recommended resubmissions, and a live queue of recoverable revenue.",
  },
  {
    name: "ShelfSignal",
    idea: "A retail intelligence platform for boutique food brands that watches in-store shelf photos, detects stockouts and placement problems, and generates a field-action plan for reps before revenue disappears.",
  },
  {
    name: "LeaseLight",
    idea: "An AI leasing assistant for small property managers that qualifies inbound renters, schedules showings, answers repetitive questions, and keeps every unit's funnel moving without a full-time leasing team.",
  },
  {
    name: "RecallKit",
    idea: "A patient recall system for independent veterinary clinics that identifies overdue visits, drafts personalized outreach, and books appointments back into open calendar slots automatically.",
  },
  {
    name: "TenderForge",
    idea: "A proposal engine for B2B agencies that turns a call transcript and client website into a polished, fixed-scope proposal with timeline, pricing logic, and objection-handling notes in under 15 minutes.",
  },
];

export function fallbackCompanyName(idea: string): string {
  return idea.split(/\s+/).slice(0, 2).join(" ") + " AI";
}

function pickLuckyIdeaFallback(): { name: string; idea: string } {
  const index = Math.floor(Math.random() * LUCKY_IDEA_FALLBACKS.length);
  return LUCKY_IDEA_FALLBACKS[index] ?? LUCKY_IDEA_FALLBACKS[0];
}

export function fallbackGenesisPrompt(companyName: string, idea: string): string {
  return [
    `# Mission`,
    `${companyName} builds ${idea}. The company will ship a working v1 product, deploy it to the web, and start acquiring users from day one.`,
    "",
    `# Target Customer`,
    `People who need ${idea}. Identify the most specific buyer persona during the first day of work.`,
    "",
    `# Core Product (v1)`,
    `A web application or landing page that delivers the core value proposition of: ${idea}. Build the simplest version that a real user can try.`,
    "",
    `# Day 1 Priorities`,
    `1. CTO: Build and deploy a landing page at the hosted domain with headline, value prop, and email capture form.`,
    `2. CTO: Build a working prototype or demo of the core product feature.`,
    `3. CMO: Write the positioning — one sentence that explains what ${companyName} does and why someone should care.`,
    `4. CMO: Draft 3 outbound messages to potential early users or communities where the target customer hangs out.`,
    `5. CEO: Write the execution plan with milestones for the first week: landing page, prototype, first 10 signups.`,
    "",
    `# Success Metrics (Week 1)`,
    `- Landing page live and deployed`,
    `- Working prototype or demo available`,
    `- 10+ email signups or waitlist entries`,
    `- 5+ outbound messages sent to potential users`,
    "",
    `# Competitive Wedge`,
    `${companyName} moves faster than any competitor because the entire team is AI-native and can ship code, content, and campaigns 24/7.`,
  ].join("\n");
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate a creative company name from a business idea using the same
 * top-tier model policy used for user-facing launch flows.
 */
export async function generateCompanyName(
  idea: string,
  env: Env,
  timeoutMs = OPENROUTER_TIMEOUT_MS,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": env.FRONTEND_URL,
          "X-Title": "Agentmarket",
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4-6",
          max_tokens: 50,
          messages: [
            {
              role: "system",
              content:
                "Generate a short, catchy company name (1-3 words) for the following business idea. Return ONLY the name, nothing else. No quotes, no explanation.",
            },
            { role: "user", content: idea },
          ],
        }),
      },
      timeoutMs,
    );
  } catch {
    return fallbackCompanyName(idea);
  }

  if (!res.ok) {
    return fallbackCompanyName(idea);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  const name = data.choices?.[0]?.message?.content?.trim();
  return name || fallbackCompanyName(idea);
}

export async function generateLuckyStartupIdea(
  env: Env,
  timeoutMs = OPENROUTER_TIMEOUT_MS,
): Promise<{ name: string; idea: string }> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": env.FRONTEND_URL,
          "X-Title": "Agentmarket",
        },
        body: JSON.stringify({
          model: "anthropic/claude-opus-4.6",
          max_tokens: 260,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "lucky_startup_idea",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  idea: { type: "string" },
                },
                required: ["name", "idea"],
                additionalProperties: false,
              },
            },
          },
          messages: [
            {
              role: "system",
              content: [
                "Generate one startup idea that is original, concrete, and immediately buildable by a small autonomous AI team.",
                "Return JSON with:",
                '- name: a short startup name, 1-3 words',
                '- idea: one compact paragraph in plain language that clearly states the customer, painful problem, product, and concrete benefit',
                "Constraints:",
                "- No crypto, no gambling, no generic 'AI platform', no social app clone, no vague marketplace.",
                "- Make it specific enough that an engineer and marketer could start the company today.",
                "- Keep the idea under 95 words.",
              ].join("\n"),
            },
          ],
        }),
      },
      timeoutMs,
    );
  } catch {
    return pickLuckyIdeaFallback();
  }

  if (!res.ok) {
    return pickLuckyIdeaFallback();
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    return pickLuckyIdeaFallback();
  }

  try {
    const parsed = JSON.parse(raw) as { name?: unknown; idea?: unknown };
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    const idea = typeof parsed.idea === "string" ? parsed.idea.trim() : "";
    if (!name || !idea) {
      return pickLuckyIdeaFallback();
    }
    return { name, idea };
  } catch {
    return pickLuckyIdeaFallback();
  }
}

/**
 * Expand a raw idea into a detailed genesis prompt for the agent.
 */
export async function generateGenesisPrompt(
  idea: string,
  companyName: string,
  env: Env,
  timeoutMs = OPENROUTER_TIMEOUT_MS,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": env.FRONTEND_URL,
          "X-Title": "Agentmarket",
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4-6",
          max_tokens: 2000,
          messages: [
            {
              role: "system",
              content: `You are a startup operator writing the founding brief for an autonomous AI company. This brief will be read by a CEO agent, CTO agent, and CMO agent who will immediately begin building the business. They have a code workspace, internet access, and can deploy websites, send emails, and run campaigns.

Write a sharp, specific launch brief in markdown. No preamble, no meta-commentary — start with the first header.

# Mission
State exactly what the company does, who it serves, and the concrete outcome it delivers. Name the product type. Be specific enough that an engineer could start building after reading just this section. 2-3 sentences max.

# Target Customer
Who is the buyer? What is their specific painful problem? How do they solve it today (and why is that bad)? Be concrete — name job titles, industries, or demographics. One paragraph.

# Core Product (v1)
Describe the minimum product that delivers real value. What does the user see? What does it do? Be specific about the format: is it a web app, an API, a Chrome extension, a Slack bot, a landing page with a waitlist? What are the 2-3 core features of v1? One paragraph.

# Day 1 Priorities
Exactly 5 numbered items. Each must be a specific, concrete action — not a category. Bad: "Set up marketing." Good: "Build a landing page at the hosted domain with headline, value prop, email capture form, and a demo video placeholder."

Format each as: "[Number]. [CTO/CMO/CEO]: [Specific concrete action with deliverable]"

# Success Metrics (Week 1)
3-5 measurable metrics. Each must be a number the CEO can check: "Landing page live and indexed", "10+ email signups", "3 outbound emails sent to prospects", "Working prototype deployed", "First user feedback collected".

# Competitive Wedge
2-3 sentences. What specifically makes this company win against alternatives? Name the alternatives if possible.

Rules:
- Be operational. Every sentence should help someone build something today.
- Never use buzzwords like "leverage", "revolutionize", "cutting-edge", "seamless", "empower".
- Never mention fundraising, hiring humans, or "market research" as a priority.
- The CTO has access to a full dev workspace and can deploy web apps. The CMO can send emails and create content. The CEO coordinates and writes strategy docs.
- Keep it under 600 words total.`,
            },
            {
              role: "user",
              content: `Company: ${companyName}\n\nFounder's idea: ${idea}`,
            },
          ],
        }),
      },
      timeoutMs,
    );
  } catch {
    return fallbackGenesisPrompt(companyName, idea);
  }

  if (!res.ok) {
    return fallbackGenesisPrompt(companyName, idea);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices?.[0]?.message?.content?.trim()
    || fallbackGenesisPrompt(companyName, idea);
}

/**
 * Generate a URL-safe slug from a name, with random suffix for uniqueness.
 */
export function buildSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
}

/**
 * Generate a ULID-like ID (timestamp + random).
 */
export function generateId(): string {
  const t = Date.now().toString(36);
  const r = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 12);
  return `${t}${r}`;
}
