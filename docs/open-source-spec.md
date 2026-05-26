# AI Combinator — Open Source Specification

This document defines the public-facing interfaces, formats, and API contracts for the AI Combinator platform. It is intended for third-party developers who want to build custom agent adapters, contribute skills to the ecosystem, or integrate external services via the API.

---

## 1. Adapter Interface Specification

The adapter layer abstracts agent execution runtimes behind a unified interface. Every agent — whether it runs via the Claude Code SDK, an external HTTP webhook, a local shell script, or a relay-spawned Codex process — is invoked through the same `AgentAdapter` contract. This design allows platform operators and third-party developers to add support for new agent runtimes without modifying the core supervisor orchestration logic. The `AgentInvoker` routes each agent turn to the correct adapter based on the `adapterType` field declared in the agent's blueprint or metadata. When no explicit adapter type is set, routing falls back to the default `ClaudeCodeAdapter`. All adapters must return an `AgentTurnResult` with a consistent set of fields so that the supervisor can uniformly handle credit billing, logging, error recovery, and task state transitions regardless of the underlying runtime.

### Core TypeScript Interfaces

```typescript
/** Supported adapter runtime types. */
type AdapterType = "claude-code" | "http-webhook" | "bash" | "codex";

/** Token usage reported by an agent turn. */
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The result of a single agent turn.
 * Every adapter must return an object conforming to this interface.
 */
interface AgentTurnResult {
  /** Whether the turn completed successfully. */
  success: boolean;
  /** Token usage for credit billing. External adapters may report zero. */
  tokenUsage: TokenUsage;
  /** The agent's text output (response, work summary, etc.). */
  output?: string;
  /** Error description when success is false. */
  error?: string;
  /** Whether the turn was aborted (timeout, cancellation). */
  aborted: boolean;
  /** Number of tool calls the agent made during this turn. */
  toolCallCount: number;
  /** Wall-clock duration of the turn in milliseconds. */
  durationMs: number;
  /** Session ID for conversation persistence (Claude Code only). */
  sessionId?: string;
}

/** Options forwarded from the AgentInvoker to the adapter. */
interface AdapterInvokeOptions {
  /** Per-turn limit overrides (timeout, max tool calls, etc.). */
  turnLimits?: Partial<TurnLimits>;
  /** Additional text appended to the system prompt. */
  systemPromptSuffix?: string;
  /** Full system prompt override (replaces the built prompt). */
  systemPromptOverride?: string;
  /** Streaming callback for text deltas (used by Claude Code for SSE). */
  onTextDelta?: (text: string) => Promise<void> | void;
  /** Abort controller for cancelling the turn. */
  abortController?: AbortController;
  /** Session key override (defaults to agent.id). */
  sessionKey?: string;
}

/** Turn-level resource limits enforced by the supervisor. */
interface TurnLimits {
  maxCreditsPerTurn: number;
  maxTokensInput: number;
  maxTokensOutput: number;
  maxToolCallsPerTurn: number;
  maxInferenceRoundsPerTurn: number;
  turnTimeoutMs: number;
}

/**
 * The agent adapter interface.
 * All adapters must implement this single method.
 */
interface AgentAdapter {
  invoke(
    agent: AgentRow,
    prompt: string,
    workspaceDir: string,
    options?: AdapterInvokeOptions,
  ): Promise<AgentTurnResult>;
}
```

### Built-in Adapters

| Adapter               | `adapterType`    | Runtime                          | Configuration                              |
|-----------------------|------------------|----------------------------------|--------------------------------------------|
| `ClaudeCodeAdapter`   | `"claude-code"`  | Claude Code SDK (Anthropic)      | API key, model tier, session persistence   |
| `HttpWebhookAdapter`  | `"http-webhook"` | External HTTP POST endpoint      | `webhook_url` on agent row or metadata     |
| `BashAdapter`         | `"bash"`         | Local shell script via `spawn`   | `scriptPath` in agent metadata JSON        |
| `CodexAdapter`        | `"codex"`        | Agent Relay (non-Anthropic LLMs) | `RelayManager` instance, blueprint config  |

### Adapter Routing

The `AgentInvoker` determines the adapter for each turn using a two-step resolution:

1. **Explicit `adapterType`**: checked first on the agent's `adapter_type` database column, then in the agent's `metadata` JSON field, then on the agent's blueprint.
2. **Provider fallback**: if no explicit adapter type is set, the agent's blueprint `provider` field is used — `"claude"` routes to `ClaudeCodeAdapter`, `"codex"` or `"openclaw"` routes to `CodexAdapter`.

### Error Contract

All adapters must handle errors gracefully and return an `AgentTurnResult` with `success: false` rather than throwing exceptions. The specific error semantics are:

| Scenario                | `success` | `aborted` | `error` pattern                     |
|-------------------------|-----------|-----------|-------------------------------------|
| Timeout exceeded        | `false`   | `true`    | Contains "timeout" (case-insensitive) |
| Non-2xx HTTP response   | `false`   | `false`   | Contains HTTP status code (e.g. "502") |
| Malformed response body | `false`   | `false`   | Contains "parse" or "invalid"       |
| Connection refused      | `false`   | `false`   | Contains "ECONNREFUSED" or "fetch failed" |
| Script non-zero exit    | `false`   | `false`   | Contains "exit" and the exit code   |
| Missing configuration   | `false`   | `false`   | Descriptive message about what's missing |

### Implementing a Custom Adapter

To add a new adapter runtime:

1. Create a class implementing the `AgentAdapter` interface in `supervisor/src/adapters/`.
2. Implement the `invoke()` method. Always return an `AgentTurnResult` — never throw.
3. Handle timeouts by respecting `options.turnLimits.turnTimeoutMs` and returning `aborted: true`.
4. Handle cancellation by checking `options.abortController.signal` and aborting promptly.
5. Report token usage when available; use `{ inputTokens: 0, outputTokens: 0 }` for runtimes that don't track tokens.
6. Register the adapter in `AgentInvoker`'s constructor and add a routing case in the `getAdapterType()` switch block.
7. Add the new adapter type string to the `AdapterType` union in `supervisor/src/types.ts`.

### Webhook Payload Format

The `HttpWebhookAdapter` sends the following JSON payload via HTTP POST:

```json
{
  "prompt": "The task prompt or user message",
  "agentId": "agent-uuid-here",
  "taskId": "task-uuid-or-null",
  "workspaceDir": "/path/to/workspace"
}
```

The expected JSON response:

```json
{
  "output": "The agent's text response or work summary",
  "success": true,
  "error": null
}
```

Only the `output` field is required. If `success` is omitted, it defaults to `true`. If the response is not valid JSON, the adapter returns `success: false` with a parse error.

---

## 2. Skill Format Specification

The skill system normalizes skill definitions from multiple agent ecosystems into a unified `SkillDescriptor` type. Skills are units of reusable agent capability — each one encapsulates a name, description, and a set of instructions that are injected into an agent's system prompt at execution time. The platform supports importing skills from the Paperclip ecosystem (using `SKILL.md` files with YAML frontmatter), the Claude ecosystem (using plain markdown files in `.claude/skills/`), and generic descriptor objects submitted via API. All formats are automatically detected by file path and parsed into the same normalized representation. During agent execution, the supervisor builds the system prompt by appending each associated skill's instructions, giving the agent contextual awareness of its capabilities without requiring manual prompt construction.

### SkillDescriptor Interface

```typescript
/**
 * Normalized skill representation used internally by the supervisor.
 * All ecosystem formats are parsed into this shape.
 */
interface SkillDescriptor {
  /** URL-safe slug identifier (e.g. "code-review"). */
  slug: string;
  /** Human-readable skill name (e.g. "Code Review"). */
  name: string;
  /** Brief description of what the skill does. */
  description: string;
  /** Full skill instructions injected into the agent's system prompt. */
  instructions: string;
}
```

### Supported Formats

#### Format 1: Paperclip `SKILL.md` (YAML Frontmatter + Markdown Body)

**Path pattern**: `skills/<slug>/SKILL.md`

Skills in the Paperclip format use YAML frontmatter delimited by `---` for metadata, followed by a markdown body containing the detailed instructions.

```markdown
---
name: Code Review
description: Performs thorough code reviews with actionable feedback
---
# Code Review Instructions

When reviewing code, follow these steps:

1. Check for correctness — does the code do what it claims?
2. Check for security — are there injection risks, exposed secrets, or auth gaps?
3. Check for performance — are there N+1 queries, unnecessary allocations, or blocking calls?
4. Provide specific, actionable feedback with line references.

Always start with what the code does well before listing concerns.
```

**Parsing rules**:
- The `slug` is derived from the parent directory name (e.g. `skills/code-review/SKILL.md` → slug `"code-review"`).
- The `name` field is read from frontmatter; if absent, the slug is converted to title case (`"code-review"` → `"Code Review"`).
- The `description` field is read from frontmatter; if absent, defaults to an empty string.
- The `instructions` field contains the markdown body after the frontmatter delimiter. If no frontmatter is present, the entire file content is used as instructions.

#### Format 2: Claude `.claude/skills/*.md` (Plain Markdown)

**Path pattern**: `.claude/skills/<filename>.md`

Claude-format skills are plain markdown files without YAML frontmatter. Metadata is inferred from the file content.

```markdown
# Deployment Checklist

Before deploying to production, verify the following:

1. All tests pass (`npm test`)
2. TypeScript compiles without errors (`tsc --noEmit`)
3. No console.log statements in production code
4. Environment variables are set in the deployment target
5. Database migrations have been applied
6. Rate limiting is configured for public endpoints
```

**Parsing rules**:
- The `slug` is derived from the filename without the `.md` extension (e.g. `deployment-checklist.md` → slug `"deployment-checklist"`).
- The `name` is extracted from the first markdown heading (`#` or `##`); if no heading exists, the slug is converted to title case.
- The `description` is extracted from the first non-heading paragraph after the first heading; if absent, defaults to an empty string.
- The `instructions` field contains the entire file content.

#### Format 3: Generic Descriptor Object

Skills can also be provided as plain objects via API payloads or programmatic registration:

```typescript
interface GenericSkillInput {
  name: string;
  description?: string;
  instructions: string;
  slug?: string; // auto-generated from name if omitted
}
```

### Slug Normalization

All slugs are normalized to URL-safe strings using these rules:
- Convert to lowercase.
- Replace all non-alphanumeric characters with hyphens.
- Strip leading and trailing hyphens.
- If the result is empty, default to `"unnamed"`.

Example: `"My Cool Skill!"` → `"my-cool-skill"`

### Batch Parsing and Format Detection

The `parseSkillFiles()` function accepts an array of `{ path, content }` entries and auto-detects the format by inspecting the file path:

| Path Pattern                        | Detected Format  |
|-------------------------------------|------------------|
| `skills/<slug>/SKILL.md`            | Paperclip        |
| `.claude/skills/<filename>.md`      | Claude           |
| Any other `.md` file                | Paperclip (fallback) |

### Skill Injection into Agent Prompts

During agent execution, the supervisor builds the system prompt by:

1. Starting with the agent's blueprint system prompt (personality, role, rules).
2. Appending a `## Skills` section listing each associated skill.
3. For each skill, including the full `instructions` text as a subsection.

This ensures agents have contextual awareness of their capabilities without requiring manual prompt editing. Skills are associated with agents through the companies.sh import process or via API-based agent registration.

---

## 3. API Contract Specification

The Worker API (hosted at `api.example.com`) exposes RESTful JSON endpoints for managing external agents, importing companies.sh packages, and managing automations. All endpoints require Clerk JWT authentication. The API follows consistent patterns: authenticated requests include a `Bearer` token in the `Authorization` header, responses use standard HTTP status codes, and error payloads follow a uniform `{ error: string }` shape. Company-scoped endpoints verify that the authenticated user owns the target company before proceeding.

### Authentication

All API endpoints require a valid Clerk JWT token:

```
Authorization: Bearer <clerk-jwt-token>
```

**Error responses**:
- `401 Unauthorized` — missing or invalid JWT token.
- `404 Not Found` — company does not exist or the authenticated user is not the owner.

### External Agent Registration API

Register and list external (webhook-based) agents for a company.

#### `POST /api/companies/:companyId/agents/external`

Create a new external agent that the supervisor can dispatch tasks to via webhook.

**Request body**:

```json
{
  "name": "My External Agent",
  "role": "worker",
  "webhookUrl": "https://my-service.example.com/agent-webhook",
  "adapterType": "http-webhook"
}
```

| Field         | Type   | Required | Default          | Description                                        |
|---------------|--------|----------|------------------|----------------------------------------------------|
| `name`        | string | Yes      | —                | Display name for the agent (min 1 character).      |
| `role`        | string | No       | `"worker"`       | Agent role (e.g. `"worker"`, `"specialist"`).      |
| `webhookUrl`  | string | Yes      | —                | HTTP/HTTPS URL for task dispatch.                  |
| `adapterType` | string | No       | `"http-webhook"` | One of: `"http-webhook"`, `"bash"`, `"codex"`.     |

**Success response** (`201 Created`):

```json
{
  "agent": {
    "id": "ag_abc123",
    "company_id": "co_xyz789",
    "name": "My External Agent",
    "role": "worker",
    "status": "idle",
    "model_tier": "sonnet",
    "webhook_url": "https://my-service.example.com/agent-webhook",
    "adapter_type": "http-webhook",
    "source": "external",
    "created_at": "2026-03-28T00:00:00.000Z",
    "updated_at": "2026-03-28T00:00:00.000Z"
  }
}
```

**Error responses**:
- `400 Bad Request` — invalid JSON, missing name, invalid webhook URL, or unsupported adapter type.
- `401 Unauthorized` — missing or invalid JWT.
- `404 Not Found` — company not found or not owned by user.

**Validation rules**:
- `name` must be a non-empty string.
- `webhookUrl` must be a valid `http://` or `https://` URL. Other protocols (e.g. `ftp://`) are rejected.
- `adapterType` must be one of the supported types listed above.

#### `GET /api/companies/:companyId/agents/external`

List all external agents registered for a company.

**Success response** (`200 OK`):

```json
{
  "agents": [
    {
      "id": "ag_abc123",
      "company_id": "co_xyz789",
      "name": "My External Agent",
      "role": "worker",
      "status": "idle",
      "webhook_url": "https://my-service.example.com/agent-webhook",
      "adapter_type": "http-webhook",
      "source": "external",
      "created_at": "2026-03-28T00:00:00.000Z"
    }
  ]
}
```

### Companies.sh Import API

Import agents and skills from a companies.sh-compatible GitHub package.

#### `POST /api/companies/:companyId/import/companies-sh`

Parse a companies.sh package from GitHub and import its agents and skills into the company.

**Request body**:

```json
{
  "packageRef": "paperclipai/companies/gstack"
}
```

| Field        | Type   | Required | Description                                                         |
|--------------|--------|----------|---------------------------------------------------------------------|
| `packageRef` | string | Yes      | Package reference: `"owner/repo/path"` or a full GitHub URL.        |

**Accepted `packageRef` formats**:
- `"owner/repo/path"` — fetches from `https://raw.githubusercontent.com/owner/repo/main/path/`
- `"owner/repo"` — root-level package
- `"https://github.com/owner/repo"` — full GitHub URL
- `"https://github.com/owner/repo/tree/main/path"` — URL with subpath

**Expected package structure on GitHub**:

```
COMPANY.md              # YAML frontmatter: name, description, goals
agents/
  agent-slug/
    AGENTS.md           # YAML frontmatter: name, role, title, reportsTo, skills
skills/
  skill-slug/
    SKILL.md            # YAML frontmatter + markdown instructions
```

**Success response** (`200 OK`):

```json
{
  "company": {
    "name": "GStack",
    "description": "AI-powered development platform",
    "goals": ["Ship v2.0", "Reach 1000 users"]
  },
  "agents": {
    "created": ["Alice", "Bob"],
    "skipped": [],
    "errors": []
  },
  "skills": [
    { "slug": "code-review", "name": "Code Review" }
  ],
  "errors": []
}
```

**Error responses**:
- `400 Bad Request` — missing `packageRef` or invalid format (must have at least `owner/repo`).
- `401 Unauthorized` — missing or invalid JWT.
- `404 Not Found` — company not found or not owned by user.
- `502 Bad Gateway` — supervisor is unreachable.

**Idempotency**: importing the same package twice does not create duplicate agents. Existing agents (matched by name within the company) are skipped; their metadata may be refreshed.

### Automations API

List and manage scheduled automations (cron tasks) for a company. Automations are recurring prompts that the CEO agent executes on a schedule.

#### `GET /api/companies/:companyId/automations`

List all automations for a company.

**Success response** (`200 OK`):

```json
{
  "automations": [
    {
      "id": "cron_abc123",
      "company_id": "co_xyz789",
      "agent_id": "ag_ceo001",
      "title": "Daily standup summary",
      "description": "Summarize yesterday's progress and today's plan",
      "schedule": "0 9 * * *",
      "prompt": "Summarize yesterday's progress and create today's plan for the team.",
      "enabled": 1,
      "last_run_at": "2026-03-27T09:00:00.000Z",
      "created_by": "ceo",
      "created_at": "2026-03-20T14:30:00.000Z"
    }
  ]
}
```

| Field         | Type         | Description                                             |
|---------------|--------------|---------------------------------------------------------|
| `id`          | string       | Unique automation identifier.                           |
| `company_id`  | string       | Company this automation belongs to.                     |
| `agent_id`    | string       | Agent that executes the automation (typically CEO).     |
| `title`       | string\|null | Human-readable automation title.                        |
| `description` | string\|null | Longer description of what the automation does.         |
| `schedule`    | string       | Cron expression (standard 5-field format).              |
| `prompt`      | string       | The prompt sent to the agent on each scheduled run.     |
| `enabled`     | number       | `1` for enabled, `0` for disabled.                      |
| `last_run_at` | string\|null | ISO 8601 timestamp of the last execution, or null.      |
| `created_by`  | string       | Who created this automation (e.g. `"ceo"`, user ID).   |
| `created_at`  | string       | ISO 8601 timestamp of creation.                         |

#### `PATCH /api/companies/:companyId/automations/:automationId`

Toggle an automation's enabled state.

**Request body**:

```json
{
  "enabled": false
}
```

| Field     | Type    | Required | Description                           |
|-----------|---------|----------|---------------------------------------|
| `enabled` | boolean | Yes      | Whether the automation should be active. |

**Success response** (`200 OK`):

```json
{
  "updated": true,
  "id": "cron_abc123",
  "enabled": false
}
```

**Error responses**:
- `400 Bad Request` — invalid JSON or missing `enabled` field.
- `401 Unauthorized` — missing or invalid JWT.
- `404 Not Found` — automation or company not found.

### Common Error Response Format

All error responses follow a consistent shape:

```json
{
  "error": "Human-readable error description"
}
```

HTTP status codes used across the API:

| Code | Meaning                  | When                                              |
|------|--------------------------|---------------------------------------------------|
| 200  | OK                       | Successful read or update.                        |
| 201  | Created                  | Resource successfully created.                    |
| 400  | Bad Request              | Invalid input, missing required fields.           |
| 401  | Unauthorized             | Missing or invalid authentication token.          |
| 404  | Not Found                | Resource doesn't exist or user lacks access.      |
| 502  | Bad Gateway              | Upstream service (supervisor) is unreachable.     |
