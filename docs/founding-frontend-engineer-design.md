# Founding Frontend Engineer Design

Status: proposal only  
Date: 2026-03-08  
Scope: founding frontend engineer design, tool surface, provider selection, workflow contract, design-quality controls, and reliability model. No implementation in this document.

## 1. Objective

Build a founding frontend engineer agent that is:

- the owner of founder-visible UI implementation
- capable of turning CTO requirements and CMO messaging into a real, polished interface
- able to produce distinctive web experiences instead of generic AI boilerplate
- strict about shipping real frontend artifacts, not vague design notes
- reliable enough to work autonomously without drifting from the execution contract
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

This agent is not just "the person who writes Tailwind." It is the implementation owner for:

- the first landing page preview
- founder-visible product shells
- UI component quality
- visual coherence between message and interface
- responsive behavior
- motion, typography, spacing, and interaction polish

Its job is to make the company look real and sharp as fast as possible.

## 2. Non-goals

The founding frontend engineer should not:

- replace the CTO as technical lead
- replace the CMO as positioning owner
- replace the CEO as product strategist
- invent marketing claims that are not in the execution contract
- bypass QA
- rely on markdown plans as proof of progress
- default to generic shadcn/Tailwind starter aesthetics and call it done
- use network-fetched Google Fonts in production by default
- use raw shell and random design-site scraping as its primary workflow

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- shared filesystem plus structured tasks, messages, approvals, and workflows

This design changes the frontend-agent implementation, not the overall product architecture.

The most important existing weaknesses this design must eliminate:

- founder-visible pages that technically exist but feel generic, unfinished, or inconsistent
- the model defaulting to the same color palettes, typography, and layouts
- the frontend engineer appearing "working" without a real visible artifact improving
- no strong method for art direction beyond vague prompting
- design choices being driven by model averages instead of explicit visual references and constraints
- no structured visual QA loop

## 4. Operating position in the org

### 4.1 Chain of command

The founding frontend engineer reports to the CTO.

It takes input from:

- CTO for scope, architecture, acceptance criteria, and handoff target
- CMO for messaging, landing-page intent, and content hierarchy
- CEO only through the structured task and handoff chain

It owns:

- implementation of founder-facing UI
- the first landing page preview
- visual refinement of frontend surfaces assigned to it
- component implementation quality
- responsive behavior
- motion and interaction polish within the task scope

It does not own:

- the overall product strategy
- the marketing strategy
- final release approval

### 4.2 What "done" means

From the founding frontend engineer's point of view, work is only done when:

1. the assigned page or UI surface exists in code
2. it matches the current execution contract and messaging
3. it is responsive and visually coherent
4. it passes required automated checks
5. it survives browser inspection
6. it is handed to QA with evidence

Nothing short of that should become founder-visible "frontend progress."

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- This role has to combine coding quality with visual judgment. It must reason over implementation constraints, typography, composition, responsive behavior, browser rendering, and interaction polish in one loop.
- For founder-facing landing pages and early product surfaces, bland or incoherent output is often worse than slower output.

Recommendation:

- keep the founding frontend engineer on Opus 4.6 in v1
- later, lower-risk component maintenance or routine UI cleanup can move to a cheaper model if needed
- keep founder-facing page creation and major redesign turns on Opus

Implementation requirement:

- do not run this agent in `bypassPermissions`
- use explicit `allowedTools`
- use `Skill` with local frontend/design skills enabled
- make visual QA and browser inspection part of the normal tool loop, not optional extra work

### 5.2 Driver abstraction

Use the same provider-neutral driver abstraction proposed for the CEO, CTO, and CMO.

Recommended abstraction:

```ts
interface AgentDriver {
  provider: "anthropic" | "openai" | "openclaw" | "custom";
  supportsStreaming: boolean;
  supportsMcp: boolean;
  supportsSkills: boolean;

  runTurn(input: DriverTurnInput): Promise<DriverTurnResult>;
  streamTurn(input: DriverTurnInput, handlers: DriverStreamHandlers): Promise<DriverTurnResult>;
  resetSession(sessionKey: string): Promise<void>;
}
```

The tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

The frontend engineer must not mutate D1 directly.

Use the same per-company `CompanyCoordinator` service running on the supervisor VM as the serialized mutation layer, with local SQLite as hot state and D1 as the historical mirror.

Why:

- the frontend engineer needs structured tasks, workflow transitions, and visual QA status
- page work, review loops, and active execution notes need to be serialized and auditable
- the current system already needs stronger state discipline, not more freeform file handoffs

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - live task ownership
  - workflow stage
  - active preview state
  - current execution note
  - visual QA status
  - idempotency keys
- D1:
  - queryable task history
  - workflow history
  - agent message history
  - founder-visible execution summaries
- workspace:
  - source code
  - local UI system files
  - references and generated mock artifacts
  - screenshots and HTML/CSS prototypes
- R2:
  - screenshots
  - visual diff artifacts
  - Playwright traces
  - preview evidence bundles
  - approved reference boards

### 6.3 Source-of-truth order

The frontend engineer must treat state in this order:

1. coordinator live state
2. current task workflow record
3. D1 mirrored state
4. execution contract and architecture
5. current messaging framework if the surface is marketing-facing
6. session memory

Session memory is never authoritative.

## 7. Frontend lanes

The founding frontend engineer should not be one monolithic session. It should operate in distinct lanes.

### 7.1 Build lane

Purpose:

- implement assigned frontend surfaces
- create or improve founder-visible artifacts
- maintain the local UI system

Properties:

- autonomous
- code-writing allowed
- browser-free by default until a usable page exists
- every turn must materially improve a real frontend artifact

### 7.2 Visual critique lane

Purpose:

- inspect the page in a real browser
- compare output against references and task requirements
- identify generic, weak, or broken visual decisions

Properties:

- autonomous
- browser-heavy
- screenshot-based
- may open fixes on itself before handing to QA

### 7.3 Polish and motion lane

Purpose:

- improve spacing, typography, visual hierarchy, motion, responsiveness, and small interaction details

Properties:

- autonomous
- focused on refinement, not structural re-architecture
- should be constrained by performance and accessibility budgets

### 7.4 Component-system lane

Purpose:

- turn repeated patterns into a coherent, reusable local UI system
- avoid copy-pasted page-specific styling drift

Properties:

- autonomous
- edits tokens, primitives, and page-level patterns
- should not become a giant design-system project detached from current delivery

## 8. Files and contracts the frontend engineer owns

Required files:

- frontend implementation files under `/workspace/src/`
- `/workspace/docs/ui-system.json`
- `/workspace/docs/front-end-implementation-plan.md`
- `/workspace/docs/front-end-visual-audit.md`
- `/workspace/.agent/reference-board/README.md`

The CTO remains authoritative for:

- `/workspace/docs/architecture.md`
- task decomposition and technical constraints

The CMO remains authoritative for:

- `/workspace/docs/messaging-framework.md`
- positioning and message hierarchy

The frontend engineer should translate those inputs into an actual interface.

### 8.1 Proposed `ui-system.json`

This should be the local implementation contract for visual identity and reusable UI decisions.

Suggested schema:

```json
{
  "surface": "landing_page",
  "visualDirection": "editorial-minimal with bold proof blocks and asymmetric composition",
  "antiGoals": [
    "purple gradient hero",
    "default Inter-on-white SaaS look",
    "generic 3-card feature grid above the fold"
  ],
  "typography": {
    "display": "Onest Variable",
    "body": "Varta Variable",
    "displayUse": "headlines and hero numerals",
    "bodyUse": "body copy, metadata, and cards"
  },
  "palette": {
    "base": "#f6f1e8",
    "text": "#1f1914",
    "accent": "#e86f2f",
    "secondary": "#205c56"
  },
  "layoutMotifs": [
    "offset hero stack",
    "proof rail",
    "framed CTA block"
  ],
  "motionProfile": "subtle entrance + one high-attention CTA interaction",
  "componentRules": {
    "buttons": "chunky radius, medium weight, no neon glow",
    "cards": "thin stroke, slightly warm fill, no generic shadow blobs",
    "sections": "alternate compressed and airy rhythms"
  }
}
```

## 9. The critical design problem: how to avoid generic AI websites

This is the most important part of the frontend-agent design.

### 9.1 What current users and tools are converging on

Recent tooling and practitioner feedback all point to the same pattern:

- AI is weak when asked to invent the whole visual language from a vague prompt
- AI gets much stronger when working inside a constrained design system or curated section set
- visual references matter more than structure-only prompts
- separate art direction from content generation
- force the model to commit to a distinct visual direction and explicit anti-goals

This pattern shows up in multiple places:

- Figma's `Make Designs` approach is based on design systems and composable templates, not unconstrained generation.
- Duda's `Populate Template with AI` explicitly keeps structure/design quality anchored in prebuilt templates while AI fills in customer-specific content.
- Relume's style-guide workflow is centered on generating a style guide first, then exporting a coherent concept, not asking AI to invent a complete site from nothing every time.
- 21st.dev explicitly exposes screens, themes, and high-quality components as inspiration/reference material, which is a better input than generic prompts.
- Recent practitioner threads consistently report that better results come from screenshot references, strong visual constraints, curated section libraries, and rough human or predesigned mockups as anchors.

### 9.2 The design-quality contract this agent must follow

The frontend engineer should never design "from scratch" in one pass.

Instead, every founder-facing surface should follow this sequence:

1. choose a visual direction
2. choose anti-goals
3. assemble a reference board
4. choose a type pairing and palette
5. choose 1-3 layout motifs
6. implement the page
7. inspect in browser
8. critique for genericness
9. refine before QA handoff

### 9.3 Required anti-generic methods

The agent should be forced to use these methods:

#### A. Design-system-first, not prompt-first

Do not ask the model to improvise every button, card, and section.

Instead:

- maintain a small local component and section library
- treat the page as composition plus art direction, not blank-page generation
- evolve patterns over time so each company gets a coherent visual language

#### B. Reference-board-first

Before designing a major founder-facing surface, the agent should collect:

- 3-5 screenshots of high-quality reference sections
- 1-2 theme references
- 1-2 negative references for what to avoid

These should be stored under `/workspace/.agent/reference-board/`.

#### C. Explicit visual direction

Every page needs a named visual direction, such as:

- editorial minimal
- warm craft product
- technical brutalist
- premium dark data product
- playful kinetic startup

If the model is not forced to commit to a direction, it will regress to average SaaS output.

#### D. Explicit anti-goals

The agent should define what not to do, for example:

- no purple gradients
- no generic centered hero with a pill badge
- no Inter-on-white default
- no three-equal-card feature section at the top
- no oversized generic blob backgrounds

#### E. Typography as a first-class lever

Most AI-generated websites look the same because they use the same font stack and typographic hierarchy.

The agent should:

- use self-hosted variable fonts
- choose a distinct display/body pairing
- use width, weight, and optical sizing intentionally
- vary rhythm, not just font size

#### F. Composition motifs, not just sections

The page should be defined by reusable composition motifs, such as:

- offset stacks
- proof rails
- framed CTA islands
- side labels
- tension between wide and compressed columns

This produces more distinctive pages than "hero + features + testimonials + CTA" alone.

#### G. Screenshot critique loop

The agent should critique the rendered page from screenshots, not just from code.

Code can look "fine" while the interface still feels generic or badly balanced.

#### H. Separate messaging from visual design

The CMO can define:

- the promise
- the hierarchy
- the proof points

The frontend engineer should decide:

- spatial hierarchy
- typography treatment
- pacing
- visual emphasis
- motion and interaction detail

#### I. Curated section library

The fastest path to unique results is not infinite generation. It is a curated library of:

- 8-12 hero variants
- 8-12 proof/social-proof variants
- 6-10 pricing or CTA variants
- 6-10 narrative or problem/solution variants

The agent should compose from strong patterns, then customize heavily.

### 9.4 What providers and tools support this best

For this role, the strongest current stack is:

- design inspiration: 21st.dev screens/themes/components
- style-guide thinking: internalized from Relume-style workflows, not outsourced blindly
- browser critique: Browserbase + Playwright
- typography: Fontsource self-hosted variable fonts
- visual regression: Playwright screenshot comparisons
- component test harness: Storybook test + a11y addons where useful

This is better than asking a model to invent everything from vague prompts.

## 10. Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | Frontend access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.create_tasks`, `org.send_message`, `org.record_execution_note` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable workflow state matching the current architecture | Full |
| Workspace code/docs | `Read`, `Glob`, `Grep`, `Edit`, `Write` | Claude Code built-in tools | Lowest-latency edits on the real shared workspace | Full |
| Repository state | `repo.status`, `repo.diff`, `repo.checkpoint`, `repo.restore_checkpoint`, `repo.log` | Internal MCP server over local Git CLI in the supervisor workspace | Reliable checkpoints and safe rollback of visual changes without assuming remote GitHub sync | Full |
| Local app execution | `dev.install`, `dev.lint`, `dev.typecheck`, `dev.start_preview`, `dev.stop_preview`, `dev.inspect_port` | Internal MCP server over the local company runtime | Fastest and most accurate way to validate the real UI surface | Full |
| Browser inspection | `browser.open`, `browser.inspect`, `browser.screenshot`, `browser.extract` | Browserbase Sessions + Playwright + Browserbase Contexts | Deterministic browser testing with screenshots, replay, and persistent contexts when needed | Full |
| Visual regression and critique | `visual.capture`, `visual.compare`, `visual.highlight_diffs`, `visual.store_reference` | Internal MCP server over Playwright screenshot capture + pixel diff + R2 | Founder-facing UI quality should be assessed visually, not only by code diff | Full |
| Accessibility checks | `a11y.run_axe`, `a11y.storybook_scan`, `a11y.get_report` | axe-core via Storybook addon-a11y plus internal MCP wrapper | Reliable early accessibility checks integrated into component work | Full |
| Performance audits | `perf.run_lighthouse`, `perf.compare_baseline`, `perf.get_budget_status` | Lighthouse CI + Lighthouse CLI wrapped in internal MCP | Best current open standard for page-level perf regressions and budget assertions | Full |
| Design references and inspiration | `design.get_reference_screens`, `design.get_theme_examples`, `design.capture_reference`, `design.get_curated_font_pairs`, `design.get_layout_motifs` | Internal MCP backed by 21st.dev screens/themes/components, workspace reference boards, and curated local metadata | Best way to keep the agent grounded in strong visual references instead of generic averages | Read-heavy |
| Typography assets | `fonts.list_pairs`, `fonts.install_font_pair`, `fonts.preview_axes` | Internal MCP backed by Fontsource variable font packages | Self-hosted fonts, version locking, performance, and richer typographic variation | Full |
| Motion and interaction primitives | `motion.add_pattern`, `motion.preview_transition`, `motion.audit_reduced_motion` | Internal MCP over Motion for React by default, optional GSAP recipes for special sequences | Reliable React-native animation with room for more ambitious hero work when justified | Full |
| Artifact inspection | `artifacts.list`, `artifacts.open`, `artifacts.inspect_html` | Internal Worker/Supervisor artifact routes | Uses the real founder-visible outputs and previews | Full |

## 11. Provider notes

### 11.1 Model

Use Claude Opus 4.6 for this agent in v1.

This is one of the few roles where visual judgment plus implementation quality make stronger reasoning worth the extra cost.

### 11.2 Browser automation

Use Browserbase plus Playwright as the primary browser stack.

Reason:

- real browser rendering matters for visual quality
- screenshots matter more than DOM alone for this role
- Browserbase gives replay/debugging and reliable browser hosting

### 11.3 Design inspiration

Use an internal `design` MCP backed primarily by 21st.dev's screens, themes, and components plus local reference-board storage.

Reason:

- 21st.dev is code-adjacent and component-oriented
- it exposes both inspiration and implementation-level references
- it is more useful for this agent than a generic design gallery

Do not make the agent depend directly on a third-party MCP server for core design flow in v1.

Read-only ingestion is better than execution dependency.

### 11.4 Typography

Use Fontsource variable font packages as the primary font provider.

Reason:

- self-hosted
- version-locked
- privacy-safe
- avoids network dependency on Google Fonts
- variable axes give the agent real typographic range

### 11.5 Motion

Use Motion for React as the default motion library.

Reason:

- production-grade
- React-native
- smaller conceptual surface than GSAP for standard UI motion

Use GSAP patterns only as an optional phase-2 or special-case path for hero-level narrative motion when simpler motion is not enough.

### 11.6 Visual testing

Use Playwright screenshot comparisons and an internal visual MCP as the primary visual diff system.

Use Storybook visual and a11y tooling where the codebase has reusable components worth isolating.

This is more reliable than manually "eyeballing" every page in chat.

## 12. Exact permission profile

### 12.1 Build lane

Recommended SDK configuration:

- `permissionMode: "acceptEdits"`
- explicit `allowedTools`
- `settingSources: ["user", "project"]`

Allowed tools:

- `Read`
- `Glob`
- `Grep`
- `Edit`
- `Write`
- `Skill`
- `mcp__org__get_live_state`
- `mcp__org__get_tasks`
- `mcp__org__send_messages`
- `mcp__org__record_execution_note`
- `mcp__repo__status`
- `mcp__repo__diff`
- `mcp__repo__checkpoint`
- `mcp__repo__log`
- `mcp__dev__install`
- `mcp__dev__lint`
- `mcp__dev__typecheck`
- `mcp__dev__start_preview`
- `mcp__dev__stop_preview`
- `mcp__dev__inspect_port`
- `mcp__design__get_reference_screens`
- `mcp__design__get_theme_examples`
- `mcp__design__capture_reference`
- `mcp__design__get_curated_font_pairs`
- `mcp__design__get_layout_motifs`
- `mcp__fonts__list_pairs`
- `mcp__fonts__install_font_pair`
- `mcp__fonts__preview_axes`
- `mcp__artifacts__list`
- `mcp__artifacts__open`

Disallowed tools:

- raw `Bash`
- direct cloud deploy tools
- direct secrets tools
- direct founder email tools
- direct SQL tools

### 12.2 Visual critique and polish lanes

Recommended SDK configuration:

- `permissionMode: "acceptEdits"`
- explicit `allowedTools`

Allowed tools:

- all read/edit tools above
- `mcp__browser__open`
- `mcp__browser__inspect`
- `mcp__browser__screenshot`
- `mcp__browser__extract`
- `mcp__visual__capture`
- `mcp__visual__compare`
- `mcp__visual__highlight_diffs`
- `mcp__visual__store_reference`
- `mcp__a11y__run_axe`
- `mcp__a11y__storybook_scan`
- `mcp__a11y__get_report`
- `mcp__perf__run_lighthouse`
- `mcp__perf__compare_baseline`
- `mcp__perf__get_budget_status`
- `mcp__motion__add_pattern`
- `mcp__motion__preview_transition`
- `mcp__motion__audit_reduced_motion`

Extra guardrails:

- no task can be handed to QA without at least one browser screenshot and one safe execution note
- motion changes must respect reduced-motion mode
- performance and accessibility regressions must be surfaced before handoff

## 13. Internal MCP servers

### 13.1 `org` MCP

Purpose:

- internal company control-plane operations

Recommended methods:

- `get_live_state(companyId)`
- `get_tasks(companyId, filters?)`
- `send_messages(companyId, messages[])`
- `record_execution_note(companyId, note)`
- `escalate_to_cto(companyId, escalation)`

Important:

- the frontend engineer should escalate to the CTO, not the founder

### 13.2 `repo` MCP

Purpose:

- safe checkpoints and diff inspection for visual work

Recommended methods:

- `status()`
- `diff(target?)`
- `log(limit?)`
- `checkpoint(label, paths?)`
- `restore_checkpoint(id)`

### 13.3 `dev` MCP

Purpose:

- reliable local engineering execution without raw shell

Recommended methods:

- `install(packageManager?)`
- `lint()`
- `typecheck()`
- `start_preview(entrypoint?)`
- `stop_preview(previewId?)`
- `inspect_port(port)`
- `run_known_script(name, args?)`

### 13.4 `browser` MCP

Purpose:

- render and inspect the real page in a real browser

Recommended methods:

- `open(url, context?)`
- `inspect(url, instructions)`
- `screenshot(url, selector?)`
- `extract(url, schema, selector?)`

### 13.5 `visual` MCP

Purpose:

- screenshot-based visual regression and critique

Recommended methods:

- `capture(target, viewport?)`
- `compare(current, baseline)`
- `highlight_diffs(current, baseline)`
- `store_reference(name, screenshot, notes?)`
- `score_layout_shift(current, baseline?)`

Implementation note:

- store baseline screenshots and diff artifacts in R2
- make these outputs available to QA and CTO

### 13.6 `design` MCP

Purpose:

- ground the agent in strong references instead of generic visual averages

Recommended methods:

- `get_reference_screens(query, filters?)`
- `get_theme_examples(query, filters?)`
- `capture_reference(url, notes?)`
- `get_curated_font_pairs(category?)`
- `get_layout_motifs(surfaceType?)`

Implementation note:

- back this with a curated local metadata set plus 21st.dev screens/themes references
- save chosen references into `/workspace/.agent/reference-board/`

### 13.7 `fonts` MCP

Purpose:

- typography choice and installation

Recommended methods:

- `list_pairs(category?)`
- `install_font_pair(display, body)`
- `preview_axes(fontFamily, sampleText?)`

Implementation note:

- use Fontsource variable packages
- prefer self-hosted fonts only

### 13.8 `a11y` MCP

Purpose:

- accessibility checks early in the frontend loop

Recommended methods:

- `run_axe(urlOrStory)`
- `storybook_scan(componentOrStory?)`
- `get_report(id)`

### 13.9 `perf` MCP

Purpose:

- keep polish from regressing into a slow mess

Recommended methods:

- `run_lighthouse(url)`
- `compare_baseline(reportId, baselineId)`
- `get_budget_status(urlOrReportId)`

### 13.10 `motion` MCP

Purpose:

- safe use of animation and interaction patterns

Recommended methods:

- `add_pattern(kind, target)`
- `preview_transition(kind, target)`
- `audit_reduced_motion(urlOrComponent)`

## 14. Provisioning-time workflow

Immediately after company provisioning:

1. read:
   - `/workspace/docs/goal.md`
   - `/workspace/docs/execution-contract.json`
   - `/workspace/docs/architecture.md` if present
   - `/workspace/docs/messaging-framework.md` if present
   - `/workspace/.agent/OPERATING_SYSTEM.md`
2. inspect the seeded `/workspace/src/index.html`
3. create or update:
   - `/workspace/docs/ui-system.json`
   - `/workspace/docs/front-end-implementation-plan.md`
   - `/workspace/docs/front-end-visual-audit.md`
4. assemble the first reference board
5. choose:
   - visual direction
   - anti-goals
   - font pair
   - palette
   - 2-3 layout motifs
6. improve the founder-facing landing page immediately
7. run browser inspection and screenshot capture
8. keep refining until the page is a real founder-visible win

The day-zero goal is not a giant design system.

It is:

- one distinctive landing page
- one coherent visual direction
- one grounded reference board
- one UI system file

## 15. Standard workflow

### 15.1 CTO -> frontend engineer

The CTO gives:

- scope
- constraints
- acceptance criteria
- required artifact path
- handoff target

### 15.2 CMO -> frontend engineer

The CMO gives:

- message hierarchy
- tone
- proof points
- CTA logic

### 15.3 Frontend engineer implementation

The frontend engineer must:

- choose references
- choose a visual direction
- implement the page
- inspect it in-browser
- critique it visually
- refine before QA handoff

### 15.4 Frontend engineer -> QA

When ready, hand off with:

- task id
- screenshots
- preview URL if available
- required checks passed
- known limitations

### 15.5 QA -> frontend engineer

If QA fails the work:

- the task loops back with precise issues
- the frontend engineer fixes only the relevant issues and resubmits

## 16. Reliability controls

### 16.1 Hard controls

- no `bypassPermissions`
- no raw SQL
- no unrestricted shell
- no direct cloud deploy access
- no direct founder messaging
- no network fonts by default

### 16.2 State consistency

- one active frontend implementation task per agent in founder-visible state
- every handoff must include evidence
- every mutation requires an idempotency key
- every page-level handoff should reference a screenshot bundle or preview

### 16.3 Session hygiene

- build and polish lanes may persist sessions
- every turn still reloads live task state, references, and current docs
- session memory is always lower priority than coordinator and file state

### 16.4 Visual enforcement

The frontend engineer should not rely on prompt discipline alone.

Enforce these checks:

- a visual direction must be declared for founder-facing pages
- anti-goals must be declared for founder-facing pages
- at least one browser screenshot must be captured before QA handoff
- at least one accessibility scan must run before QA handoff
- at least one perf budget check must run on landing-page level work

### 16.5 Visibility

Every frontend turn should persist:

- current primary task id
- current artifact path
- current safe execution note
- latest preview URL, if available
- latest screenshot bundle id
- current visual direction label

Do not expose raw chain of thought.

Instead, expose safe progress notes such as:

- "Replacing generic hero layout with offset editorial composition"
- "Testing new font pair and proof block spacing at mobile breakpoints"
- "Fixing Lighthouse regression after adding motion to hero CTA"
- "Running screenshot comparison against previous landing-page baseline"

## 17. What to borrow from current research and tools

The strongest pattern from both tools and practitioners is:

- constrain generation
- ground it in references
- use a style guide
- compose from strong sections
- critique from screenshots

The frontend engineer should explicitly borrow:

- design-system-first generation from Figma's design-system approach
- template plus AI-content separation from Duda's template-population approach
- style-guide-first workflows from Relume
- reference screens and themes from 21st.dev
- self-hosted variable-font workflows from Fontsource

The agent should not treat "prompt again until it looks good" as its design method.

## 18. Why Relay should not be the primary frontend bus

Relay may become useful later for heterogeneous design/build collaboration.

But it should not be the founding frontend engineer's primary bus in v1.

Reason:

- this role needs structured tasks, reviews, evidence bundles, and visual state
- freeform chat is weak as the source of truth for visual implementation
- the current system needs stronger workflow and QA signals more than faster chatter

Recommended position:

- primary bus: internal structured coordination through the local coordinator + D1 mirror
- optional future transport: Relay for live pair-design or pair-debug sessions once the structured workflow layer is stable

## 19. Implementation phases

### Phase 1: frontend control plane

- keep the agent on Opus 4.6
- remove `bypassPermissions`
- add `browser`, `visual`, `design`, `fonts`, `a11y`, `perf`, and `motion` MCP servers
- define `ui-system.json` and reference-board workflow

### Phase 2: anti-generic enforcement

- require visual direction and anti-goals on founder-facing tasks
- require screenshot critique before QA handoff
- add curated section library and motif metadata
- add font-pair and palette constraints

### Phase 3: component and polish discipline

- add Storybook-based component testing where appropriate
- add reusable section/component primitives
- add visual regression baselines in R2

### Phase 4: visibility and evals

- stream safe execution notes into founder UI
- expose screenshot bundles and visual diff summaries
- add evals for genericness, responsiveness, contrast, and page coherence

### Phase 5: multi-provider portability

- keep the same tool plane
- add provider drivers for Codex or other models later
- optionally add Relay for real-time collaboration

## 20. Recommended final stack

If I were implementing the founding frontend engineer next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Screenshot and evidence storage: Cloudflare R2
- Browser automation: Browserbase + Playwright + Browserbase Contexts
- Design references: internal `design` MCP backed by 21st.dev screens/themes/components plus local reference boards
- Typography: Fontsource self-hosted variable fonts
- Motion: Motion for React by default, GSAP only for special-case narrative hero work
- Accessibility checks: axe-core via Storybook addon-a11y and internal MCP
- Visual regression: Playwright screenshot comparisons
- Performance: Lighthouse CI / Lighthouse CLI

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the founding frontend engineer, while directly attacking the biggest failure mode of AI web generation, which is generic design.

## 21. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Claude 4.6 model docs: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- Browserbase docs and contexts: [docs.browserbase.com/introduction](https://docs.browserbase.com/introduction), [docs.browserbase.com/features/contexts](https://docs.browserbase.com/features/contexts)
- Browserbase session replay: [docs.browserbase.com/features/session-replay](https://docs.browserbase.com/features/session-replay)
- Fontsource docs and variable fonts: [fontsource.org/docs/getting-started](https://fontsource.org/docs/getting-started), [fontsource.org/docs/getting-started/variable](https://fontsource.org/docs/getting-started/variable)
- Variable fonts on the web: [web.dev/articles/variable-fonts](https://web.dev/articles/variable-fonts)
- Lighthouse and Lighthouse CI: [developer.chrome.com/docs/lighthouse](https://developer.chrome.com/docs/lighthouse/), [web.dev/articles/lighthouse-ci](https://web.dev/articles/lighthouse-ci), [github.com/GoogleChrome/lighthouse-ci](https://github.com/GoogleChrome/lighthouse-ci)
- Playwright visual comparisons: [playwright.dev/docs/test-snapshots](https://playwright.dev/docs/test-snapshots)
- Storybook visual and accessibility testing: [storybook.js.org/docs/8.6/writing-tests/visual-testing](https://storybook.js.org/docs/8.6/writing-tests/visual-testing), [storybook.js.org/docs/writing-tests/accessibility-testing](https://storybook.js.org/docs/writing-tests/accessibility-testing)
- Storybook component/UI testing: [storybook.js.org/docs/writing-tests](https://storybook.js.org/docs/writing-tests)
- Motion for React: [motion.dev](https://motion.dev/), [motion.dev/docs/react-installation](https://motion.dev/docs/react-installation)
- 21st.dev community screens/themes/components: [21st.mintlify.app/community](https://21st.mintlify.app/community)
- Relume Style Guide Builder: [relume.io/style-guide](https://www.relume.io/style-guide)
- Duda Populate Template with AI: [blog.duda.co/duda-unveils-populate-template-with-ai](https://blog.duda.co/duda-unveils-populate-template-with-ai), [support.duda.co/hc/en-us/articles/29227748275607-Generate-a-Site-with-AI](https://support.duda.co/hc/en-us/articles/29227748275607-Generate-a-Site-with-AI)
- Framer AI Style: [framer.com/help/articles/what-is-ai-style](https://www.framer.com/help/articles/what-is-ai-style/)
- Figma design-system and template-first generation references: [figma.com/blog/inside-figma-a-retrospective-on-make-designs](https://www.figma.com/blog/inside-figma-a-retrospective-on-make-designs/), [figma.com/blog/team-library-1-0](https://www.figma.com/blog/team-library-1-0/)
- Practitioner discussion on avoiding generic AI design: [reddit.com/r/SaasDevelopers/comments/1r5zwro/aigenerated_websites_always_look_generic_how_do](https://www.reddit.com/r/SaasDevelopers/comments/1r5zwro/aigenerated_websites_always_look_generic_how_do/), [reddit.com/r/ClaudeCode/comments/1r5zy5n/aigenerated_websites_always_look_generic_how_do](https://www.reddit.com/r/ClaudeCode/comments/1r5zy5n/aigenerated_websites_always_look_generic_how_do/), [reddit.com/r/ChatGPTCoding/comments/1mk0b87](https://www.reddit.com/r/ChatGPTCoding/comments/1mk0b87/)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
