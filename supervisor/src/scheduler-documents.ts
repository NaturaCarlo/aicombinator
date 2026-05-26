import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compute_day_number } from "./agent-runner.js";
import { deriveFallbackMission } from "./scheduler-prompts.js";
import { ensure_workspace_agent_dir } from "./scheduler-helpers.js";
import type { CompanyRow, PlanDocument } from "./types.js";

function now_pt_date(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function sentence_case(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

function compact_founder_direction(company: CompanyRow): string {
  return sentence_case(
    company.goal?.trim()
    || company.genesis_prompt?.trim()
    || `Build a real company around ${company.name}`,
  );
}

export function build_current_plan_markdown(company: CompanyRow, mission: string, plan: PlanDocument): string {
  const lines = [
    "# Current Plan",
    "",
    "## Mission",
    mission.trim(),
    "",
    "## Right Now",
    `We are executing the smallest credible first milestone for ${company.name}. The goal is to show real founder-visible progress quickly, not produce extra internal strategy documents.`,
    "",
  ];

  for (const [milestoneIndex, milestone] of plan.milestones.entries()) {
    lines.push(`## Milestone ${milestoneIndex + 1}: ${milestone.title}`);
    if (milestone.description?.trim()) {
      lines.push(milestone.description.trim());
      lines.push("");
    }
    for (const task of milestone.tasks) {
      lines.push(`- ${task.title} — ${task.assigned_to}`);
      lines.push(`  ${task.description.trim()}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function build_mission_manifesto(company: CompanyRow, mission: string, plan: PlanDocument): string {
  const summary = sentence_case(mission || deriveFallbackMission(company));
  const founderDirection = compact_founder_direction(company);
  const firstMilestone = plan.milestones[0];
  const firstOutputs = firstMilestone?.tasks.slice(0, 3).map((task) => task.title) ?? [];

  const principles = [
    "Ship founder-visible progress before polishing secondary systems.",
    "Prefer real artifacts and grounded proof over speculative claims.",
    "Keep the first version simple enough to launch, learn from, and improve quickly.",
  ];

  const lines = [
    "# Mission",
    "",
    summary,
    "",
    "## Founder Direction",
    founderDirection,
    "",
    "## Why This Matters",
    sentence_case(`${company.name} should feel like a real, specific company with a believable first offer, a clear audience, and visible execution discipline from the first day`),
    "",
    "## What We Are Building First",
    firstMilestone
      ? sentence_case(`${company.name} is proving itself through ${firstMilestone.title.toLowerCase()}. ${firstMilestone.description?.trim() || "The first milestone should make the company feel real immediately."}`)
      : sentence_case(`${company.name} is focused on the smallest credible first product that a founder can immediately inspect.`),
    "",
    ...(
      firstOutputs.length > 0
        ? [
            "### First Visible Outputs",
            ...firstOutputs.map((output) => `- ${output}`),
            "",
          ]
        : []
    ),
    "## Operating Principles",
    ...principles.map((principle) => `- ${principle}`),
    "",
    "## Definition of Momentum",
    sentence_case(`The company is on track when each turn leaves the workspace more real: clearer positioning, stronger product surfaces, or more usable execution artifacts that match the founder direction for ${company.name}`),
    "",
    "## What We Will Not Confuse With Progress",
    "- We do not count generic planning notes as momentum when a concrete artifact could be shipped instead.",
    "- We do not claim customers, revenue, or traction unless those facts are grounded in verified telemetry or real external evidence.",
    "- We do not expand scope until the current milestone produces a founder-visible result that feels coherent and usable.",
  ];

  return `${lines.join("\n").trim()}\n`;
}

export function build_execution_contract(
  company: CompanyRow,
  mission: string,
  plan: PlanDocument,
  ptDate: string,
  dayNumber: number,
): string {
  return `${JSON.stringify(
    {
      company_id: company.id,
      company_name: company.name,
      mission: mission.trim(),
      pt_date: ptDate,
      day_number: dayNumber,
      objective: "Create a visible, founder-ready company as fast as possible.",
      working_rules: [
        "Prioritize real artifacts over extra planning.",
        "Do not invent commercial outcomes.",
        "If blocked, surface the blocker clearly and propose the smallest next step.",
        "Use the hosted domain and /workspace/site for founder-facing web output.",
      ],
      active_milestone: plan.milestones[0]?.title ?? "Initial milestone",
      milestones: plan.milestones.map((milestone, index) => ({
        order: index + 1,
        title: milestone.title,
        description: milestone.description,
        tasks: milestone.tasks.map((task) => ({
          title: task.title,
          assigned_to: task.assigned_to,
          depends_on: task.depends_on,
        })),
      })),
    },
    null,
    2,
  )}\n`;
}

export function build_goal_markdown(company: CompanyRow, mission: string): string {
  return [
    "# Goal",
    "",
    company.goal?.trim() || mission.trim(),
    "",
    "Turn this into a real operating company with visible progress and grounded founder updates.",
    "",
  ].join("\n");
}

export function build_operating_system_markdown(company: CompanyRow): string {
  return [
    "# Operating System",
    "",
    `You are working inside ${company.name}.`,
    "",
    "Read these files before acting:",
    "- /workspace/docs/goal.md",
    "- /workspace/docs/execution-contract.json",
    "- /workspace/docs/plan.md",
    "",
    "Execution rules:",
    "- Advance one concrete deliverable per turn.",
    "- Leave real file changes in /workspace before finishing.",
    "- Do not invent traction, leads, meetings, or revenue.",
    "- Use the hosted domain and /workspace/site for founder-facing web output.",
    "- If blocked, record the blocker clearly and recommend the smallest next move.",
    "",
  ].join("\n");
}

export function materialize_early_mission(workspace: string, company: CompanyRow, mission: string): void {
  const docsDir = join(workspace, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "mission.md"), build_mission_manifesto(company, mission, { milestones: [], agents_needed: [] }));
}

export function materialize_initial_company_files(workspace: string, company: CompanyRow, mission: string, plan: PlanDocument): void {
  const docsDir = join(workspace, "docs");
  mkdirSync(docsDir, { recursive: true });
  ensure_workspace_agent_dir(workspace);

  const ptDate = now_pt_date();
  const dayNumber = compute_day_number(company);
  writeFileSync(join(docsDir, "mission.md"), build_mission_manifesto(company, mission, plan));
  writeFileSync(join(docsDir, "plan.md"), build_current_plan_markdown(company, mission, plan));
  writeFileSync(
    join(docsDir, "execution-contract.json"),
    build_execution_contract(company, mission, plan, ptDate, dayNumber),
  );
  writeFileSync(join(docsDir, "goal.md"), build_goal_markdown(company, mission));
  writeFileSync(join(workspace, ".agent", "OPERATING_SYSTEM.md"), build_operating_system_markdown(company));
  writeFileSync(join(docsDir, "DESIGN.md"), generate_design_md(
    company.name,
    company.genesis_prompt ?? company.goal ?? mission,
    infer_industry(company.genesis_prompt ?? company.goal ?? mission),
  ));
}

// ---------------------------------------------------------------------------
// DESIGN.md generation — provides a design system spec that guides agents
// building UI/landing pages so visual output is consistent and professional.
// ---------------------------------------------------------------------------

interface IndustryTheme {
  atmosphere: string;
  primary: string;
  primary_name: string;
  secondary: string;
  secondary_name: string;
  accent: string;
  accent_name: string;
  neutral_bg: string;
  neutral_text: string;
  font_display: string;
  font_body: string;
}

const INDUSTRY_THEMES: Record<string, IndustryTheme> = {
  fintech: {
    atmosphere: "Trust, precision, and reliability. Clean surfaces with structured hierarchy convey financial confidence. The palette communicates security and professionalism while remaining approachable.",
    primary: "#0F3460", primary_name: "Deep Navy",
    secondary: "#16697A", secondary_name: "Teal",
    accent: "#FFA62B", accent_name: "Amber",
    neutral_bg: "#F8F9FA", neutral_text: "#1A1A2E",
    font_display: "Inter, system-ui, sans-serif",
    font_body: "Inter, system-ui, sans-serif",
  },
  healthcare: {
    atmosphere: "Warm, caring, and calm. Soft tones and generous whitespace create a welcoming, wellness-oriented experience. The design should feel reassuring and easy to navigate.",
    primary: "#2B6777", primary_name: "Ocean Teal",
    secondary: "#52AB98", secondary_name: "Sage Green",
    accent: "#C8553D", accent_name: "Warm Coral",
    neutral_bg: "#F2F7F5", neutral_text: "#2D3436",
    font_display: "Source Sans Pro, system-ui, sans-serif",
    font_body: "Source Sans Pro, system-ui, sans-serif",
  },
  creative: {
    atmosphere: "Bold, expressive, and vibrant. High-contrast elements and dynamic layouts signal creative energy. The design itself should feel like a portfolio piece.",
    primary: "#6C5CE7", primary_name: "Electric Purple",
    secondary: "#00CEC9", secondary_name: "Cyan",
    accent: "#FD79A8", accent_name: "Hot Pink",
    neutral_bg: "#FAFAFA", neutral_text: "#2D3436",
    font_display: "Poppins, system-ui, sans-serif",
    font_body: "Inter, system-ui, sans-serif",
  },
  ecommerce: {
    atmosphere: "Conversion-focused and product-forward. Clean grids, clear CTAs, and trust signals guide users toward action. Visual hierarchy prioritizes products and offers.",
    primary: "#2D3436", primary_name: "Charcoal",
    secondary: "#00B894", secondary_name: "Emerald",
    accent: "#E17055", accent_name: "Burnt Orange",
    neutral_bg: "#FFFFFF", neutral_text: "#2D3436",
    font_display: "DM Sans, system-ui, sans-serif",
    font_body: "DM Sans, system-ui, sans-serif",
  },
  education: {
    atmosphere: "Friendly, clear, and encouraging. The design should feel approachable and easy to follow. Bright accents add energy without overwhelming informational content.",
    primary: "#2E86AB", primary_name: "Sky Blue",
    secondary: "#A23B72", secondary_name: "Berry",
    accent: "#F18F01", accent_name: "Sunflower",
    neutral_bg: "#F5F6FA", neutral_text: "#2D3436",
    font_display: "Nunito, system-ui, sans-serif",
    font_body: "Nunito, system-ui, sans-serif",
  },
  technology: {
    atmosphere: "Modern, minimal, and precise. Sharp interfaces with clear information hierarchy. The design conveys technical capability without feeling sterile.",
    primary: "#1B1F3B", primary_name: "Midnight Blue",
    secondary: "#3D5AF1", secondary_name: "Electric Blue",
    accent: "#22D1EE", accent_name: "Cyan",
    neutral_bg: "#F7F8FC", neutral_text: "#1B1F3B",
    font_display: "Inter, system-ui, sans-serif",
    font_body: "Inter, system-ui, sans-serif",
  },
};

const DEFAULT_THEME: IndustryTheme = INDUSTRY_THEMES.technology;

function infer_industry(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(fintech|banking|payment|finance|financial|invest|trading|lending|insurance)\b/.test(lower)) return "fintech";
  if (/\b(health|medical|clinic|patient|wellness|telemedicine|telehealth|pharma|doctor|hospital)\b/.test(lower)) return "healthcare";
  if (/\b(design|creative|art|photo|video|music|media|studio|brand|portfolio|animation)\b/.test(lower)) return "creative";
  if (/\b(shop|store|ecommerce|e-commerce|retail|product|marketplace|merchant|cart|checkout)\b/.test(lower)) return "ecommerce";
  if (/\b(edu|learn|course|school|university|training|tutor|student|teacher|academy)\b/.test(lower)) return "education";
  return "technology";
}

export function generate_design_md(company_name: string, brief: string, industry_context: string): string {
  const theme = INDUSTRY_THEMES[industry_context] ?? DEFAULT_THEME;

  return `# Design System: ${company_name}

> Auto-generated design system for ${company_name}. All agents building visual output (landing pages, websites, UI components) MUST follow these guidelines.

**Company brief:** ${brief}

---

## 1. Visual Theme & Atmosphere

${theme.atmosphere}

The overall feel for ${company_name} should match the company's positioning: professional enough to build trust with the target audience, distinctive enough to be memorable. Every visual decision should reinforce what ${company_name} does and who it serves.

**Key Characteristics:**
- Clean, structured layouts with clear visual hierarchy
- Generous whitespace for readability and focus
- Consistent spacing and alignment throughout
- Purposeful use of color — not decorative, but communicative

---

## 2. Color Palette & Roles

### Primary
- **${theme.primary_name}** (\`${theme.primary}\`): Primary brand color. Used for headers, primary buttons, key UI anchors.
- **${theme.secondary_name}** (\`${theme.secondary}\`): Secondary brand color. Used for supporting elements, secondary buttons, highlights.

### Accent
- **${theme.accent_name}** (\`${theme.accent}\`): Accent color for CTAs, alerts, badges, and emphasis. Use sparingly for maximum impact.

### Neutrals
- **Background** (\`${theme.neutral_bg}\`): Page background and surface color.
- **Text** (\`${theme.neutral_text}\`): Primary text color. Use at 100% for headings, 70% for body, 50% for secondary text.
- **Border**: \`rgba(0, 0, 0, 0.1)\` for subtle borders, \`rgba(0, 0, 0, 0.2)\` for emphasized.
- **White** (\`#FFFFFF\`): Card surfaces, overlays.

### Semantic
- **Success**: \`#27AE60\` — confirmations, positive states.
- **Warning**: \`#F2994A\` — caution, pending states.
- **Error**: \`#EB5757\` — errors, destructive actions.
- **Info**: \`#2D9CDB\` — informational notices.

---

## 3. Typography Rules

### Font Stack
- **Display / Headings**: \`${theme.font_display}\`
- **Body / UI**: \`${theme.font_body}\`
- **Code / Monospace**: \`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace\`

### Hierarchy

| Role | Size | Weight | Line Height | Use |
|------|------|--------|-------------|-----|
| Display / Hero | 48–64px | 700 | 1.1 | Hero headlines, page titles |
| H1 | 36–40px | 700 | 1.2 | Section headings |
| H2 | 28–32px | 600 | 1.25 | Sub-section headings |
| H3 | 22–24px | 600 | 1.3 | Card titles, feature headings |
| H4 | 18–20px | 600 | 1.35 | Small headings |
| Body Large | 18px | 400 | 1.6 | Hero subtitles, lead paragraphs |
| Body | 16px | 400 | 1.6 | Standard body text |
| Body Small | 14px | 400 | 1.5 | Captions, metadata |
| Label | 12px | 500 | 1.4 | Badges, tags, micro-labels |

---

## 4. Component Stylings

### Buttons

**Primary**
- Background: \`${theme.primary}\`
- Text: \`#FFFFFF\`
- Padding: 12px 24px
- Border-radius: 6px
- Font: 16px, weight 600
- Hover: darken background 10%, subtle shadow
- Active: darken 15%
- Disabled: 50% opacity, no pointer events

**Secondary**
- Background: transparent
- Border: 2px solid \`${theme.primary}\`
- Text: \`${theme.primary}\`
- Padding: 12px 24px
- Hover: fill background with primary at 8% opacity

**Ghost**
- Background: transparent
- Text: \`${theme.neutral_text}\` at 70%
- Padding: 8px 16px
- Hover: background \`rgba(0, 0, 0, 0.05)\`

### Cards
- Background: \`#FFFFFF\`
- Border: 1px solid \`rgba(0, 0, 0, 0.08)\`
- Border-radius: 8px
- Padding: 24px
- Shadow: \`0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.06)\`
- Hover: shadow intensifies — \`0 4px 12px rgba(0, 0, 0, 0.1)\`

### Inputs
- Background: \`#FFFFFF\`
- Border: 1px solid \`rgba(0, 0, 0, 0.15)\`
- Border-radius: 6px
- Padding: 10px 14px
- Font: 16px body font
- Focus: border color \`${theme.primary}\`, subtle ring shadow
- Error: border color \`#EB5757\`

### Navigation
- Background: \`#FFFFFF\` or \`${theme.neutral_bg}\` with subtle backdrop blur
- Height: 64px
- Logo left, links center or right
- Link font: 15px, weight 500
- Active link: color \`${theme.primary}\`, bottom border indicator

---

## 5. Layout Principles

### Spacing Scale (8px base)
- 4px, 8px, 12px, 16px, 24px, 32px, 48px, 64px, 96px, 128px

### Grid
- Max content width: 1200px, centered
- 12-column grid for complex layouts
- Standard gutters: 24px (desktop), 16px (mobile)

### Section Spacing
- Between major sections: 80–120px
- Between sub-sections: 48–64px
- Between elements within a section: 24–32px

### Whitespace Philosophy
- Generous margins around key content for focus
- Content blocks should breathe — avoid cramming
- Use whitespace to create visual grouping (proximity principle)

---

## 6. Do's and Don'ts

### Do's
- ✅ Use the color palette consistently — primary for key actions, accent for emphasis
- ✅ Maintain a clear visual hierarchy with type scale
- ✅ Include clear, prominent CTAs on every page section
- ✅ Use real, specific copy that reflects ${company_name}'s value proposition
- ✅ Test on mobile viewports — touch targets must be ≥ 44px
- ✅ Use semantic HTML (h1-h6 hierarchy, nav, main, section, footer)
- ✅ Keep pages fast — optimize images, minimize external dependencies

### Don'ts
- ❌ Don't use more than 3 font weights on a page
- ❌ Don't use pure black (\`#000000\`) for text — use the neutral text color instead
- ❌ Don't place important content below the fold without a scroll indicator
- ❌ Don't use low-contrast text (WCAG AA minimum: 4.5:1 for body, 3:1 for large text)
- ❌ Don't use more than 2 accent colors on a single page
- ❌ Don't center-align body paragraphs longer than 3 lines
- ❌ Don't use stock placeholder text — always use relevant copy for ${company_name}

---

## 7. Responsive Behavior

### Breakpoints
| Name | Width | Layout Changes |
|------|-------|---------------|
| Mobile | < 640px | Single column, stacked navigation, full-width cards |
| Tablet | 640–1024px | 2-column grids, condensed navigation |
| Desktop | > 1024px | Full layout, max-width container, sidebar if needed |

### Touch Targets
- All interactive elements: minimum 44px × 44px
- Buttons: comfortable padding (12px+ vertical)
- Form inputs: minimum height 44px

### Mobile Adaptations
- Hero text scales down: 48px → 32px → 28px
- Navigation collapses to hamburger menu
- Cards stack vertically with full width
- Section spacing reduces: 80px → 48px → 32px
- Horizontal scrolling is never acceptable

---

## 8. Landing Page Composition Patterns

Follow these proven section patterns when building landing pages. Every landing page should include most of these sections in this order.

### Hero Section
- **Background**: Gradient from primary (\`${theme.primary}\`) to secondary (\`${theme.secondary}\`), angled or radial. Never use a plain white background for heroes.
- **Headline**: h1, Display size (48–64px), white or light text on dark gradient, max 8 words.
- **Subtitle**: text-lg (18px), 70% opacity white, max 2 lines.
- **CTA Buttons**: Two buttons side by side — one primary (solid, contrasting with gradient) and one ghost (white outline). Generous padding (16px 32px).
- **Optional**: Hero image or illustration on the right (50/50 split on desktop, stacked on mobile).
- **Spacing**: 120px top/bottom padding, centered content with max-width 800px for text.

### Features Grid
- **Layout**: 3-column grid on desktop, single column on mobile. Gap: 32px.
- **Each Card**: Icon (48px, accent color) + title (h3, 22px, font-weight 600) + description (body, 16px, 70% text opacity).
- **Card Styling**: White background, subtle shadow (\`0 1px 3px rgba(0,0,0,0.08)\`), border-radius 8px, padding 32px.
- **Hover**: Shadow intensifies (\`0 4px 12px rgba(0,0,0,0.1)\`), \`transition: all 0.2s ease\`.
- **Section Padding**: 80px top/bottom.

### Social Proof
- **Option A — Testimonials**: Cards with avatar (48px circle), quote (italic, body font), name + title (small, 14px). 2–3 testimonials in a row.
- **Option B — Logo Bar**: Row of 4–6 partner/client logos, grayscale (\`filter: grayscale(100%); opacity: 0.6\`), hover restores color. Caption above: "Trusted by" or "Featured in".
- **Background**: Subtle neutral background (\`${theme.neutral_bg}\`) to differentiate from adjacent sections.

### Stats Section
- **Layout**: 3–4 large numbers in a centered row.
- **Each Stat**: Large number (h2, 36px, font-weight 700, primary color) + label below (14px, 50% text opacity).
- **Separator**: Vertical dividers between stats (1px border, 10% opacity).
- **Section Padding**: 64px top/bottom.

### CTA Section
- **Background**: Contrasting color — primary (\`${theme.primary}\`) or a gradient.
- **Content**: Centered headline (h2, white) + subtitle (body, 70% white) + single primary button (large, contrasting).
- **Padding**: 80px top/bottom.
- **Keep it simple**: One clear call-to-action, no distractions.

### Footer
- **Layout**: Multi-column links (3–4 columns) + bottom bar with copyright.
- **Typography**: 14px links, 60% text opacity, hover to 100%.
- **Background**: Dark (\`${theme.neutral_text}\` or darker) with light text.
- **Bottom Bar**: Copyright + optional social icons. Separated by subtle top border.
- **Padding**: 64px top, 24px bottom.
`;
}

