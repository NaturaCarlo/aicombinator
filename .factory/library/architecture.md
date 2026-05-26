# Architecture — Launch Flow

## Overview

The launch flow lets a user describe a company idea, have a conversation with a CEO AI agent, and then launch the company (provisioning agents, generating artifacts).

## Components

### Frontend (dashboard/)

**Launch Form** (`components/launch-form.tsx`):
- Manages the full launch lifecycle: idea input → CEO conversation → provisioning
- SSE streaming via `streamLaunchSession()` from `lib/api.ts`
- Fallback polling when SSE fails
- Stall detection (15s timeout) with recovery
- State: `streamingContent` (accumulated tokens), `launchSession` (server state), `sessionBusy`

**Launch Session View** (`components/launch/launch-session-view.tsx`):
- Renders the conversation: messages list + streaming content overlay
- Uses `MarkdownContent` for rendering markdown
- Auto-scroll behavior tied to message list changes

**Launch Runtime** (`components/launch/launch-runtime.ts`):
- `waitForLaunchReady()` — Polls company status during provisioning
- Progress tracking with stall detection

**API Client** (`lib/api.ts`):
- `streamLaunchSession()` — SSE connection with token/processing/done/error handlers
- `extractSsePayloads()` — Parses SSE data events from text chunks
- `getLaunchSession()` / `sendLaunchSessionMessage()` — REST API calls

### Backend (worker/)

**Routes** (`routes/launch-sessions.ts`):
- `handleStreamLaunchSession` — SSE endpoint, claims turn, streams tokens, sends done
- `handleGetLaunchSession` — REST GET, uses `toResponse()` to serialize
- `handleLaunchSessionMessage` — POST to send user message, creates pending turn
- `handleRetryLaunchSessionTurn` — Retry failed turns
- `handleLaunchFromSession` — Transition to launched state
- `toResponse()` — Serializes session with messages and turn phases
- `completePendingAssistantTurn()` — Writes turn result to DB
- `repairAbandonedProcessingTurns()` — Cleanup stale turns
- `tryClaimArtifactGeneration()` — KV-based lock for artifact generation

**Provisioning** (`provisioning/launch-session.ts`):
- `generateLaunchSessionTurnStreaming()` — Multi-provider streaming (Anthropic → OpenRouter → non-streaming fallback)
- `generateLaunchArtifacts()` / `ensureArtifacts()` — Generate company artifacts via AI
- Claude API streaming: `content_block_delta` / `input_json_delta` format

## Data Flow

1. User types message → POST `/launch-sessions/:id/messages` → creates pending turn
2. Frontend opens SSE → GET `/launch-sessions/:id/stream`
3. SSE handler claims turn via D1 conditional update (`tryClaimAssistantTurn`)
4. Worker calls Claude API streaming → emits `token` events → emits `done` with final session
5. Frontend accumulates tokens in `streamingContent` state
6. SWR polls GET `/launch-sessions/:id` periodically (5s) → returns serialized session
7. When CEO says "ready": `ensureArtifacts()` generates company artifacts
8. User clicks launch → POST `/launch-sessions/:id/launch` → provisions agents

## Key Invariants

- Only one worker should process a turn at a time (enforced by `tryClaimAssistantTurn` optimistic lock)
- `toResponse()` is the single serialization point for both REST and SSE responses
- Turn states: pending → processing → complete (or → error → pending on retry)
- Session states: active → ready → launched
