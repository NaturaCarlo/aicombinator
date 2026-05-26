import type { Env } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";
import { createAndProvisionCompany, hasInferableCompanyMeaning } from "./companies.js";
import {
  buildFallbackLaunchSessionTurn,
  ensureFallbackOptions,
  generateLaunchArtifacts,
  generateLaunchSessionTurn,
  generateLaunchSessionTurnStreaming,
  type LaunchSessionArtifacts,
  type LaunchSessionBrief,
  type LaunchSessionMessageInput,
  type LaunchSessionMode,
  type LaunchSessionOption,
  type LaunchSessionReadiness,
  type LaunchSessionTurnGeneration,
  type LaunchSessionTurnAttemptLog,
  type LaunchSessionTurnResult,
  type StreamingLaunchTurnEvent,
} from "../provisioning/launch-session.js";
import { generateId } from "../provisioning/config-builder.js";

type LaunchSessionStatus = "active" | "ready" | "launching" | "launched";

type LaunchSessionRow = {
  id: string;
  user_id: string;
  status: LaunchSessionStatus;
  mode: LaunchSessionMode;
  input_name: string | null;
  input_idea: string;
  suggested_name: string | null;
  brief_json: string;
  readiness_json: string;
  artifacts_json: string | null;
  launched_company_id: string | null;
  created_at: string;
  updated_at: string;
};

type LaunchSessionMessageRow = {
  id: string;
  session_id: string;
  role: "founder" | "assistant";
  content: string;
  options_json: string | null;
  created_at: string;
};

type LaunchSessionTurnRow = {
  id: string;
  session_id: string;
  founder_message_id: string;
  assistant_message_id: string;
  status: AssistantMessagePhase;
  attempts: number;
  provider: string | null;
  model: string | null;
  duration_ms: number | null;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  prompt_chars: number | null;
  transcript_messages: number | null;
  status_code: number | null;
  created_at: string;
  updated_at: string;
};

type LaunchSessionResponse = {
  id: string;
  status: LaunchSessionStatus;
  mode: LaunchSessionMode;
  inputName: string | null;
  inputIdea: string;
  suggestedName: string | null;
  ready: boolean;
  readiness: LaunchSessionReadiness;
  brief: LaunchSessionBrief;
  artifacts: LaunchSessionArtifacts | null;
  launchedCompanyId: string | null;
  messages: Array<{
    id: string;
    role: "founder" | "assistant";
    content: string;
    options: LaunchSessionOption[];
    pending: boolean;
    error: boolean;
    streaming?: boolean;
    createdAt: string;
  }>;
  currentTurn: {
    status: AssistantMessagePhase;
    attempts: number;
    provider: string | null;
    model: string | null;
    durationMs: number | null;
    lastError: string | null;
    startedAt: string | null;
    completedAt: string | null;
    promptChars: number | null;
    transcriptMessages: number | null;
    attemptHistory: LaunchSessionTurnAttemptLog[];
  } | null;
  processing: boolean;
  createdAt: string;
  updatedAt: string;
};

const PENDING_ASSISTANT_PREFIX = "[[pending-opus]] ";
const PROCESSING_ASSISTANT_PREFIX = "[[processing-opus]] ";
const ERROR_ASSISTANT_PREFIX = "[[error-opus]] ";
const BOOTSTRAP_FOUNDER_PREFIX = "[[bootstrap-founder]] ";
const PROCESSING_STALE_MS = 120_000;
const TURN_HARD_TIMEOUT_MS = 120_000;
const ABANDONED_PROCESSING_MS = 90_000;
const MAX_TURN_ATTEMPTS = 4;

const TURN_ATTEMPT_HISTORY_PREFIX = "launch-session-attempt-history:";
const TURN_ERROR_REPAIR_PREFIX = "launch-session-turn-repair:";

type AssistantMessagePhase = "pending" | "processing" | "error" | "complete";

type LaunchTurnMeta = {
  status: AssistantMessagePhase;
  attempts: number;
  provider: string | null;
  model: string | null;
  durationMs: number | null;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  promptChars: number | null;
  transcriptMessages: number | null;
  statusCode: number | null;
};

function parseJsonObject<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function requireAuthenticatedUser(request: Request, env: Env): Promise<string | Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json(
      { error: "Invalid token" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  return userId;
}

function normalizeMode(raw: string | null | undefined): LaunchSessionMode {
  if (raw === "quick" || raw === "deep") {
    return raw;
  }
  return "standard";
}

function getAssistantMessagePhase(content: string): AssistantMessagePhase {
  if (content.startsWith(PENDING_ASSISTANT_PREFIX)) return "pending";
  if (content.startsWith(PROCESSING_ASSISTANT_PREFIX)) return "processing";
  if (content.startsWith(ERROR_ASSISTANT_PREFIX)) return "error";
  return "complete";
}

function stripAssistantPrefix(content: string): string {
  if (content.startsWith(PENDING_ASSISTANT_PREFIX)) {
    return content.slice(PENDING_ASSISTANT_PREFIX.length);
  }
  if (content.startsWith(PROCESSING_ASSISTANT_PREFIX)) {
    return content.slice(PROCESSING_ASSISTANT_PREFIX.length);
  }
  if (content.startsWith(ERROR_ASSISTANT_PREFIX)) {
    return content.slice(ERROR_ASSISTANT_PREFIX.length);
  }
  return content;
}

function isBootstrapFounderMessage(content: string): boolean {
  return content.startsWith(BOOTSTRAP_FOUNDER_PREFIX);
}

function stripFounderPrefix(content: string): string {
  if (content.startsWith(BOOTSTRAP_FOUNDER_PREFIX)) {
    return content.slice(BOOTSTRAP_FOUNDER_PREFIX.length);
  }
  return content;
}

function buildTurnMetaFromAttempt(input: {
  status: AssistantMessagePhase;
  attempts: number;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  attemptLog: LaunchSessionTurnAttemptLog | null;
}): LaunchTurnMeta {
  return {
    status: input.status,
    attempts: input.attempts,
    provider: input.attemptLog?.provider ?? null,
    model: input.attemptLog?.model ?? null,
    durationMs: input.attemptLog?.durationMs ?? null,
    lastError: input.lastError ?? input.attemptLog?.error ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    promptChars: input.attemptLog?.promptChars ?? null,
    transcriptMessages: input.attemptLog?.transcriptMessages ?? null,
    statusCode: input.attemptLog?.statusCode ?? null,
  };
}

function buildInitialBrief(idea: string): LaunchSessionBrief {
  return {
    concept: idea.trim(),
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
    autonomyConfidence: 25,
  };
}

function buildInitialReadiness(): LaunchSessionReadiness {
  return {
    score: 20,
    ready: false,
    blockers: ["The company still needs a concrete customer, offer, and first milestone."],
    strengths: [],
    nextBestQuestion: null,
  };
}

async function loadSession(env: Env, sessionId: string, userId: string): Promise<LaunchSessionRow | null> {
  return env.DB.prepare(
    `SELECT id, user_id, status, mode, input_name, input_idea, suggested_name,
            brief_json, readiness_json, artifacts_json, launched_company_id,
            created_at, updated_at
     FROM launch_sessions
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
  ).bind(sessionId, userId).first<LaunchSessionRow>();
}

async function loadSessionMessages(env: Env, sessionId: string): Promise<LaunchSessionMessageRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, session_id, role, content, options_json, created_at
     FROM launch_session_messages
     WHERE session_id = ?
     ORDER BY created_at ASC,
              CASE role WHEN 'founder' THEN 0 ELSE 1 END ASC,
              id ASC`,
  ).bind(sessionId).all<LaunchSessionMessageRow>();
  return result.results ?? [];
}

async function loadSessionTurns(env: Env, sessionId: string): Promise<LaunchSessionTurnRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, session_id, founder_message_id, assistant_message_id, status, attempts,
            provider, model, duration_ms, last_error, started_at, completed_at,
            prompt_chars, transcript_messages, status_code, created_at, updated_at
     FROM launch_session_turns
     WHERE session_id = ?
     ORDER BY created_at ASC, id ASC`,
  ).bind(sessionId).all<LaunchSessionTurnRow>();
  return result.results ?? [];
}

async function loadSessionTurnByAssistantMessage(
  env: Env,
  assistantMessageId: string,
): Promise<LaunchSessionTurnRow | null> {
  return env.DB.prepare(
    `SELECT id, session_id, founder_message_id, assistant_message_id, status, attempts,
            provider, model, duration_ms, last_error, started_at, completed_at,
            prompt_chars, transcript_messages, status_code, created_at, updated_at
     FROM launch_session_turns
     WHERE assistant_message_id = ?
     LIMIT 1`,
  ).bind(assistantMessageId).first<LaunchSessionTurnRow>();
}

function turnMetaFromRow(row: LaunchSessionTurnRow | null): LaunchTurnMeta | null {
  if (!row) {
    return null;
  }
  return {
    status: row.status,
    attempts: row.attempts,
    provider: row.provider,
    model: row.model,
    durationMs: row.duration_ms,
    lastError: row.last_error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    promptChars: row.prompt_chars,
    transcriptMessages: row.transcript_messages,
    statusCode: row.status_code,
  };
}

function getTurnStatusFromLegacyMessage(
  message: LaunchSessionMessageRow,
  legacyMeta: LaunchTurnMeta | null,
): AssistantMessagePhase {
  const content = message.content ?? "";
  if (content.startsWith(PENDING_ASSISTANT_PREFIX)) return "pending";
  if (content.startsWith(PROCESSING_ASSISTANT_PREFIX)) return "processing";
  if (content.startsWith(ERROR_ASSISTANT_PREFIX)) return "error";
  if (stripAssistantPrefix(content).trim()) return "complete";
  if (legacyMeta?.status) return legacyMeta.status;
  return "pending";
}

function normalizeTurnMetaFromLegacy(
  message: LaunchSessionMessageRow,
  status: AssistantMessagePhase,
  legacyMeta: LaunchTurnMeta | null,
): LaunchTurnMeta {
  const fallbackCompletedAt = status === "complete" ? message.created_at : null;
  const attempts = Math.max(
    legacyMeta?.attempts ?? 0,
    status === "complete" || status === "error" ? 1 : 0,
  );
  return {
    status,
    attempts,
    provider: legacyMeta?.provider ?? null,
    model: legacyMeta?.model ?? null,
    durationMs: legacyMeta?.durationMs ?? null,
    lastError: legacyMeta?.lastError ?? null,
    startedAt: legacyMeta?.startedAt ?? null,
    completedAt: legacyMeta?.completedAt ?? fallbackCompletedAt,
    promptChars: legacyMeta?.promptChars ?? null,
    transcriptMessages: legacyMeta?.transcriptMessages ?? null,
    statusCode: legacyMeta?.statusCode ?? null,
  };
}

function buildTurnMap(turns: LaunchSessionTurnRow[]): Map<string, LaunchSessionTurnRow> {
  return new Map(turns.map((turn) => [turn.assistant_message_id, turn]));
}

async function toResponse(
  env: Env,
  row: LaunchSessionRow,
  messages: LaunchSessionMessageRow[],
  turns: LaunchSessionTurnRow[],
): Promise<LaunchSessionResponse> {
  const readiness = parseJsonObject<LaunchSessionReadiness>(row.readiness_json, buildInitialReadiness());
  const turnMap = buildTurnMap(turns);
  const hydratedMessages = messages.flatMap((message) => {
    if (message.role === "founder" && isBootstrapFounderMessage(message.content)) {
      // Show the idea to the user, but strip the system instruction suffix
      const raw = stripFounderPrefix(message.content);
      const cleaned = raw.replace(/\nHelp me shape this into a company.*$/s, "").trim();
      if (!cleaned) return [];
      return [{
        id: message.id,
        role: message.role as "founder" | "assistant",
        content: cleaned,
        options: [] as LaunchSessionOption[],
        pending: false,
        error: false,
        createdAt: message.created_at,
      }];
    }
    const turn = message.role === "assistant" ? turnMap.get(message.id) ?? null : null;
    const phase = turn?.status
      ?? (message.role === "assistant" ? getAssistantMessagePhase(message.content) : "complete");
    const isInProgress = message.role === "assistant" && (phase === "pending" || phase === "processing");
    const renderedContent = message.role !== "assistant"
      ? stripFounderPrefix(message.content)
      : stripAssistantPrefix(message.content);
    return [{
      id: message.id,
      role: message.role,
      content: renderedContent,
      options: parseJsonObject<LaunchSessionOption[]>(message.options_json, []),
      pending: phase === "pending" || phase === "processing",
      error: phase === "error",
      ...(isInProgress ? { streaming: true } : {}),
      createdAt: message.created_at,
    }];
  });
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const currentTurnMeta = turnMetaFromRow(latestTurn);
  const attemptHistory = latestTurn
    ? await loadTurnAttemptHistory(env, latestTurn.assistant_message_id)
    : [];
  const currentTurn = latestTurn
    ? {
        status: currentTurnMeta?.status ?? "pending",
        attempts: currentTurnMeta?.attempts ?? 0,
        provider: currentTurnMeta?.provider ?? null,
        model: currentTurnMeta?.model ?? null,
        durationMs: currentTurnMeta?.durationMs ?? null,
        lastError: currentTurnMeta?.lastError ?? null,
        startedAt: currentTurnMeta?.startedAt ?? null,
        completedAt: currentTurnMeta?.completedAt ?? null,
        promptChars: currentTurnMeta?.promptChars ?? null,
        transcriptMessages: currentTurnMeta?.transcriptMessages ?? null,
        attemptHistory,
      }
    : null;
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    inputName: row.input_name,
    inputIdea: row.input_idea,
    suggestedName: row.suggested_name,
    ready: readiness.ready,
    readiness,
    brief: parseJsonObject<LaunchSessionBrief>(row.brief_json, buildInitialBrief(row.input_idea)),
    artifacts: parseJsonObject<LaunchSessionArtifacts | null>(row.artifacts_json, null),
    launchedCompanyId: row.launched_company_id,
    messages: hydratedMessages,
    currentTurn,
    processing: turns.some((turn) => turn.status === "pending" || turn.status === "processing"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hasPendingAssistantTurn(turns: LaunchSessionTurnRow[]): boolean {
  return turns.some((turn) => turn.status === "pending" || turn.status === "processing");
}



async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function turnAttemptHistoryKey(assistantMessageId: string): string {
  return `${TURN_ATTEMPT_HISTORY_PREFIX}${assistantMessageId}`;
}

function turnErrorRepairKey(assistantMessageId: string): string {
  return `${TURN_ERROR_REPAIR_PREFIX}${assistantMessageId}`;
}

async function loadTurnAttemptHistory(
  env: Env,
  assistantMessageId: string,
): Promise<LaunchSessionTurnAttemptLog[]> {
  const raw = await env.AUTOMATON_KV.get(turnAttemptHistoryKey(assistantMessageId), "json");
  if (!Array.isArray(raw)) {
    return [];
  }
  const attempts: LaunchSessionTurnAttemptLog[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const provider = record.provider === "anthropic" || record.provider === "openrouter"
      ? record.provider
      : null;
    const outcome = record.outcome === "success"
      || record.outcome === "non_ok"
      || record.outcome === "invalid_payload"
      || record.outcome === "error"
      ? record.outcome
      : null;
    if (!provider || !outcome) continue;
    attempts.push({
      provider,
      model: typeof record.model === "string" ? record.model : null,
      outcome,
      durationMs: typeof record.durationMs === "number" ? record.durationMs : 0,
      statusCode: typeof record.statusCode === "number" ? record.statusCode : null,
      error: typeof record.error === "string" ? record.error : null,
      promptChars: typeof record.promptChars === "number" ? record.promptChars : 0,
      transcriptMessages: typeof record.transcriptMessages === "number" ? record.transcriptMessages : 0,
    });
  }
  return attempts.slice(-8);
}

async function saveTurnAttemptHistory(
  env: Env,
  assistantMessageId: string,
  attempts: LaunchSessionTurnAttemptLog[],
): Promise<void> {
  await env.AUTOMATON_KV.put(
    turnAttemptHistoryKey(assistantMessageId),
    JSON.stringify(attempts.slice(-8)),
  );
}

async function alreadyRepairedTurnError(
  env: Env,
  assistantMessageId: string,
): Promise<boolean> {
  return Boolean(await env.AUTOMATON_KV.get(turnErrorRepairKey(assistantMessageId)));
}

async function markTurnErrorRepaired(
  env: Env,
  assistantMessageId: string,
): Promise<void> {
  await env.AUTOMATON_KV.put(turnErrorRepairKey(assistantMessageId), "1", { expirationTtl: 60 * 60 * 12 });
}

async function loadLegacyTurnMeta(env: Env, assistantMessageId: string): Promise<LaunchTurnMeta | null> {
  const raw = await env.AUTOMATON_KV.get(`launch-session-turn:${assistantMessageId}`, "json");
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  return {
    status: record.status === "processing" || record.status === "error" || record.status === "complete"
      ? record.status
      : "pending",
    attempts: typeof record.attempts === "number" ? record.attempts : 0,
    provider: typeof record.provider === "string" ? record.provider : null,
    model: typeof record.model === "string" ? record.model : null,
    durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
    lastError: typeof record.lastError === "string" ? record.lastError : null,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
    completedAt: typeof record.completedAt === "string" ? record.completedAt : null,
    promptChars: typeof record.promptChars === "number" ? record.promptChars : null,
    transcriptMessages: typeof record.transcriptMessages === "number" ? record.transcriptMessages : null,
    statusCode: typeof record.statusCode === "number" ? record.statusCode : null,
  };
}

async function saveTurnRow(
  env: Env,
  assistantMessageId: string,
  meta: LaunchTurnMeta,
): Promise<void> {
  // Optimistic concurrency: prevent overwriting a turn that has already been
  // completed by another worker. A turn in 'complete' status is final and
  // should not be regressed to 'processing' or 'pending' by a stale worker.
  const result = await env.DB.prepare(
    `UPDATE launch_session_turns
     SET status = ?, attempts = ?, provider = ?, model = ?, duration_ms = ?, last_error = ?,
         started_at = ?, completed_at = ?, prompt_chars = ?, transcript_messages = ?,
         status_code = ?, updated_at = ?
     WHERE assistant_message_id = ? AND status != 'complete'`,
  ).bind(
    meta.status,
    meta.attempts,
    meta.provider,
    meta.model,
    meta.durationMs,
    meta.lastError,
    meta.startedAt,
    meta.completedAt,
    meta.promptChars,
    meta.transcriptMessages,
    meta.statusCode,
    new Date().toISOString(),
    assistantMessageId,
  ).run();

  if ((result.meta?.changes ?? 0) === 0 && meta.status !== "complete") {
    console.warn(
      `[saveTurnRow] Skipping: turn ${assistantMessageId} is already complete (another worker finished first).`,
    );
  }
}

async function ensureSessionTurns(
  env: Env,
  session: LaunchSessionRow,
  messages: LaunchSessionMessageRow[],
): Promise<{ messages: LaunchSessionMessageRow[]; turns: LaunchSessionTurnRow[] }> {
  let turns = await loadSessionTurns(env, session.id);
  const knownAssistantIds = new Set(turns.map((turn) => turn.assistant_message_id));
  let lastFounderId: string | null = null;
  const statements: D1PreparedStatement[] = [];
  let normalizedMessages = false;

  for (const message of messages) {
    if (message.role === "founder") {
      lastFounderId = message.id;
      continue;
    }
    if (knownAssistantIds.has(message.id) || !lastFounderId) {
      continue;
    }

    const legacyMeta = await loadLegacyTurnMeta(env, message.id);
    const status = getTurnStatusFromLegacyMessage(message, legacyMeta);
    const meta = normalizeTurnMetaFromLegacy(message, status, legacyMeta);
    const normalizedContent = status === "complete" ? stripAssistantPrefix(message.content) : "";
    const normalizedOptions = status === "complete" ? message.options_json : null;
    if (normalizedContent !== message.content || normalizedOptions !== message.options_json) {
      normalizedMessages = true;
      statements.push(
        env.DB.prepare(
          `UPDATE launch_session_messages
           SET content = ?, options_json = ?
           WHERE id = ? AND session_id = ?`,
        ).bind(
          normalizedContent,
          normalizedOptions,
          message.id,
          session.id,
        ),
      );
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO launch_session_turns (
           id, session_id, founder_message_id, assistant_message_id, status, attempts,
           provider, model, duration_ms, last_error, started_at, completed_at,
           prompt_chars, transcript_messages, status_code, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        generateId(),
        session.id,
        lastFounderId,
        message.id,
        meta.status,
        meta.attempts,
        meta.provider,
        meta.model,
        meta.durationMs,
        meta.lastError,
        meta.startedAt,
        meta.completedAt,
        meta.promptChars,
        meta.transcriptMessages,
        meta.statusCode,
        message.created_at,
        meta.completedAt ?? meta.startedAt ?? message.created_at,
      ),
    );
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
    turns = await loadSessionTurns(env, session.id);
    if (normalizedMessages) {
      messages = await loadSessionMessages(env, session.id);
    }
  }

  return { messages, turns };
}

async function repairAbandonedProcessingTurns(
  env: Env,
  session: LaunchSessionRow,
  turns: LaunchSessionTurnRow[],
): Promise<LaunchSessionTurnRow[]> {
  const abandonedProcessing = turns.filter((turn) => {
    if (turn.status !== "processing") return false;
    const updatedAt = Date.parse(turn.updated_at);
    if (Number.isNaN(updatedAt)) return false;
    return Date.now() - updatedAt >= ABANDONED_PROCESSING_MS;
  });
  // Pending turns are intentionally left alone — they should remain pending
  // until the SSE endpoint picks them up, regardless of age.
  if (abandonedProcessing.length === 0) {
    return turns;
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  // Re-queue stale "processing" turns back to pending
  for (const turn of abandonedProcessing) {
    statements.push(
      env.DB.prepare(
        `UPDATE launch_session_turns
         SET status = 'pending',
             last_error = COALESCE(last_error, 'The previous launch-studio turn stalled before completion and was re-queued.'),
             started_at = NULL,
             completed_at = NULL,
             updated_at = ?
         WHERE assistant_message_id = ? AND session_id = ?`,
      ).bind(now, turn.assistant_message_id, session.id),
    );
  }

  await env.DB.batch(statements);
  return loadSessionTurns(env, session.id);
}

async function repairRecoverableErrorTurn(
  env: Env,
  session: LaunchSessionRow,
  turns: LaunchSessionTurnRow[],
): Promise<LaunchSessionTurnRow[]> {
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  if (!latestTurn || latestTurn.status !== "error") {
    return turns;
  }
  if (await alreadyRepairedTurnError(env, latestTurn.assistant_message_id)) {
    return turns;
  }

  const attemptHistory = await loadTurnAttemptHistory(env, latestTurn.assistant_message_id);
  if (attemptHistory.length === 0 || !attemptHistory.every((attempt) => attempt.outcome === "invalid_payload")) {
    return turns;
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE launch_session_turns
     SET status = 'pending',
         attempts = 0,
         provider = NULL,
         model = NULL,
         duration_ms = NULL,
         status_code = NULL,
         last_error = 'The previous Opus turn failed on a payload-format issue and was re-queued automatically.',
         started_at = NULL,
         completed_at = NULL,
         updated_at = ?
     WHERE assistant_message_id = ? AND session_id = ?`,
  ).bind(
    now,
    latestTurn.assistant_message_id,
    session.id,
  ).run();
  await markTurnErrorRepaired(env, latestTurn.assistant_message_id);
  return loadSessionTurns(env, session.id);
}

async function loadSessionConversation(
  env: Env,
  session: LaunchSessionRow,
): Promise<{ messages: LaunchSessionMessageRow[]; turns: LaunchSessionTurnRow[] }> {
  const messages = await loadSessionMessages(env, session.id);
  const ensured = await ensureSessionTurns(env, session, messages);
  const processingRepairedTurns = await repairAbandonedProcessingTurns(env, session, ensured.turns);
  const errorRepairedTurns = await repairRecoverableErrorTurn(env, session, processingRepairedTurns);
  if (errorRepairedTurns === ensured.turns) {
    return ensured;
  }
  return { messages: ensured.messages, turns: errorRepairedTurns };
}

const ARTIFACT_CLAIM_SENTINEL = '{"_claim":true}';

function isArtifactClaimSentinel(artifactsJson: string | null | undefined): boolean {
  if (!artifactsJson) return false;
  try {
    const parsed = JSON.parse(artifactsJson);
    return parsed && typeof parsed === "object" && "_claim" in parsed;
  } catch {
    return false;
  }
}

function hasRealArtifacts(artifactsJson: string | null | undefined): boolean {
  return !!artifactsJson && !isArtifactClaimSentinel(artifactsJson);
}

async function tryClaimArtifactGeneration(env: Env, sessionId: string): Promise<boolean> {
  // Atomic D1 conditional update: only one concurrent caller can transition artifacts_json from NULL
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE launch_sessions SET artifacts_json = ?, updated_at = ? WHERE id = ? AND artifacts_json IS NULL`,
  ).bind(ARTIFACT_CLAIM_SENTINEL, now, sessionId).run();
  return (result.meta?.changes ?? 0) > 0;
}

async function clearArtifactGenerationClaim(env: Env, sessionId: string): Promise<void> {
  // Only clear if still in claiming state (don't overwrite real artifacts)
  await env.DB.prepare(
    `UPDATE launch_sessions SET artifacts_json = NULL WHERE id = ? AND artifacts_json = ?`,
  ).bind(sessionId, ARTIFACT_CLAIM_SENTINEL).run();
}

/**
 * Poll the database for real artifacts to appear (not the claim sentinel).
 * Used when tryClaimArtifactGeneration fails, indicating another path is
 * already generating artifacts. Polls every 1s for up to 30s.
 * Returns the updated session row if real artifacts appear, or null on timeout.
 */
async function waitForRealArtifacts(
  env: Env,
  sessionId: string,
  maxWaitMs = 30_000,
  pollIntervalMs = 1_000,
): Promise<LaunchSessionRow | null> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const row = await env.DB.prepare(
      `SELECT * FROM launch_sessions WHERE id = ?`,
    ).bind(sessionId).first<LaunchSessionRow>();
    if (row && hasRealArtifacts(row.artifacts_json)) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}

/**
 * Guarded version of ensureArtifacts that uses tryClaimArtifactGeneration.
 * If the claim succeeds, generates artifacts and clears the claim.
 * If the claim fails (another path is generating), polls for real artifacts.
 * Returns the updated session, or null if artifacts could not be obtained.
 */
async function guardedEnsureArtifacts(
  env: Env,
  session: LaunchSessionRow,
): Promise<LaunchSessionRow | null> {
  // If real artifacts already exist, just return
  if (hasRealArtifacts(session.artifacts_json)) {
    return session;
  }

  const claimed = await tryClaimArtifactGeneration(env, session.id);
  if (claimed) {
    try {
      return await ensureArtifacts(env, session);
    } finally {
      await clearArtifactGenerationClaim(env, session.id);
    }
  }

  // Claim failed — another path is already generating artifacts.
  // Poll for real artifacts to appear instead of duplicating work.
  return waitForRealArtifacts(env, session.id);
}

async function persistPendingAssistantTurn(input: {
  env: Env;
  session: LaunchSessionRow;
  founderMessage: string;
}): Promise<{ session: LaunchSessionRow; assistantMessageId: string }> {
  const now = new Date().toISOString();
  const founderMessageId = generateId();
  const assistantMessageId = generateId();

  await input.env.DB.batch([
    input.env.DB.prepare(
      `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
       VALUES (?, ?, 'founder', ?, NULL, ?)`,
    ).bind(founderMessageId, input.session.id, input.founderMessage, now),
    input.env.DB.prepare(
      `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
       VALUES (?, ?, 'assistant', ?, NULL, ?)`,
    ).bind(
      assistantMessageId,
      input.session.id,
      "",
      now,
    ),
    input.env.DB.prepare(
      `INSERT INTO launch_session_turns (
         id, session_id, founder_message_id, assistant_message_id, status, attempts,
         provider, model, duration_ms, last_error, started_at, completed_at,
         prompt_chars, transcript_messages, status_code, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).bind(
      generateId(),
      input.session.id,
      founderMessageId,
      assistantMessageId,
      now,
      now,
    ),
    input.env.DB.prepare(
      `UPDATE launch_sessions
       SET updated_at = ?
       WHERE id = ?`,
    ).bind(now, input.session.id),
  ]);

  return {
    session: {
      ...input.session,
      updated_at: now,
    },
    assistantMessageId,
  };
}

async function completePendingAssistantTurn(input: {
  env: Env;
  session: LaunchSessionRow;
  assistantMessageId: string;
  assistant: LaunchSessionTurnResult;
  meta: LaunchTurnMeta;
}): Promise<void> {
  const now = new Date().toISOString();
  const nextStatus: LaunchSessionStatus = input.assistant.readiness.ready ? "ready" : "active";

  // Step 1: Execute ONLY the turn-row UPDATE with optimistic concurrency check.
  // The WHERE status = 'processing' clause ensures only one worker can win the race.
  // D1 batch() executes ALL statements in a transaction without short-circuiting,
  // so the concurrency check MUST run alone before any message/session writes.
  const turnResult = await input.env.DB.prepare(
    `UPDATE launch_session_turns
     SET status = ?, attempts = ?, provider = ?, model = ?, duration_ms = ?, last_error = ?,
         started_at = ?, completed_at = ?, prompt_chars = ?, transcript_messages = ?,
         status_code = ?, updated_at = ?
     WHERE assistant_message_id = ? AND status = 'processing'`,
  ).bind(
    input.meta.status,
    input.meta.attempts,
    input.meta.provider,
    input.meta.model,
    input.meta.durationMs,
    input.meta.lastError,
    input.meta.startedAt,
    input.meta.completedAt,
    input.meta.promptChars,
    input.meta.transcriptMessages,
    input.meta.statusCode,
    now,
    input.assistantMessageId,
  ).run();

  // Step 2: Check rows affected. If 0, another worker already completed this turn —
  // return early WITHOUT touching message or session data (prevents data corruption).
  if ((turnResult.meta?.changes ?? 0) === 0) {
    console.warn(
      `[completePendingAssistantTurn] Lost race: turn ${input.assistantMessageId} is no longer in processing status (completed by another worker). Returning early without updating message/session.`,
    );
    return;
  }

  // Step 3: Only the winning worker reaches here. Execute message + session UPDATEs
  // in a batch for atomicity between these two dependent writes.
  // Note: There is a small crash window between step 1 and step 3, but:
  //   - Crash = incomplete completion (recoverable via retry/reclaim)
  //   - Old bug = data corruption from concurrent overwrite (NOT recoverable)
  await input.env.DB.batch([
    input.env.DB.prepare(
      `UPDATE launch_session_messages
       SET content = ?, options_json = ?
       WHERE id = ? AND session_id = ?`,
    ).bind(
      input.assistant.assistantMessage,
      JSON.stringify(input.assistant.options),
      input.assistantMessageId,
      input.session.id,
    ),
    input.env.DB.prepare(
      `UPDATE launch_sessions
       SET status = ?, suggested_name = ?, brief_json = ?, readiness_json = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      nextStatus,
      input.assistant.suggestedCompanyName ?? input.session.suggested_name,
      JSON.stringify(input.assistant.brief),
      JSON.stringify(input.assistant.readiness),
      now,
      input.session.id,
    ),
  ]);
}

async function markAssistantTurnError(input: {
  env: Env;
  session: LaunchSessionRow;
  assistantMessageId: string;
  error: string;
  meta: LaunchTurnMeta;
}): Promise<void> {
  await input.env.DB.prepare(
    `UPDATE launch_session_messages
     SET content = '', options_json = NULL
     WHERE id = ? AND session_id = ?`,
  ).bind(
    input.assistantMessageId,
    input.session.id,
  ).run();
  await saveTurnRow(input.env, input.assistantMessageId, {
    ...input.meta,
    status: "error",
    lastError: input.error,
  });
}

async function resetAssistantTurnToPending(input: {
  env: Env;
  session: LaunchSessionRow;
  assistantMessageId: string;
  meta: LaunchTurnMeta;
}): Promise<void> {
  await input.env.DB.prepare(
    `UPDATE launch_session_messages
     SET content = '', options_json = NULL
     WHERE id = ? AND session_id = ?`,
  ).bind(
    input.assistantMessageId,
    input.session.id,
  ).run();
  await saveTurnRow(input.env, input.assistantMessageId, input.meta);
}

async function retryAssistantTurn(input: {
  env: Env;
  session: LaunchSessionRow;
  assistantMessageId: string;
}): Promise<void> {
  await resetAssistantTurnToPending({
    ...input,
    meta: {
      status: "pending",
      attempts: 0,
      provider: null,
      model: null,
      durationMs: null,
      lastError: null,
      startedAt: null,
      completedAt: null,
      promptChars: null,
      transcriptMessages: null,
      statusCode: null,
    },
  });
}

async function ensureArtifacts(
  env: Env,
  session: LaunchSessionRow,
): Promise<LaunchSessionRow> {
  // Skip if real artifacts already exist (not just a claim sentinel)
  if (hasRealArtifacts(session.artifacts_json)) {
    return session;
  }

  const brief = parseJsonObject<LaunchSessionBrief>(session.brief_json, buildInitialBrief(session.input_idea));
  const artifacts = await generateLaunchArtifacts({
    env,
    companyName: session.suggested_name || session.input_name || "New Company",
    idea: session.input_idea,
    brief,
  });
  const now = new Date().toISOString();
  // Use conditional write: only update if no real artifacts exist yet.
  // This handles both NULL (direct call) and claim sentinel (via tryClaimArtifactGeneration).
  await env.DB.prepare(
    `UPDATE launch_sessions
     SET artifacts_json = ?, updated_at = ?
     WHERE id = ? AND (artifacts_json IS NULL OR artifacts_json = ?)`,
  ).bind(JSON.stringify(artifacts), now, session.id, ARTIFACT_CLAIM_SENTINEL).run();

  return {
    ...session,
    artifacts_json: JSON.stringify(artifacts),
    updated_at: now,
  };
}

function kickoffArtifactGenerationIfNeeded(
  env: Env,
  ctx: ExecutionContext,
  session: LaunchSessionRow,
): void {
  if (session.status !== "ready" || session.artifacts_json) {
    return;
  }

  ctx.waitUntil((async () => {
    const claimed = await tryClaimArtifactGeneration(env, session.id);
    if (!claimed) {
      return;
    }
    try {
      await ensureArtifacts(env, session);
    } finally {
      await clearArtifactGenerationClaim(env, session.id);
    }
  })());
}

async function maybeUpgradeGenericKickoff(
  env: Env,
  session: LaunchSessionRow,
  messages: LaunchSessionMessageRow[],
): Promise<{ session: LaunchSessionRow; messages: LaunchSessionMessageRow[] }> {
  if (messages.length !== 2) {
    return { session, messages };
  }

  const assistant = messages.find((message) => message.role === "assistant");
  if (!assistant) {
    return { session, messages };
  }

  if (!assistant.content.startsWith("Let's turn ") || !assistant.content.includes("Right now we need to sharpen three things before launch")) {
    return { session, messages };
  }

  const improved = buildFallbackLaunchSessionTurn({
    companyName: session.suggested_name || session.input_name,
    idea: session.input_idea,
    brief: parseJsonObject<LaunchSessionBrief>(session.brief_json, buildInitialBrief(session.input_idea)),
  });
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE launch_session_messages
       SET content = ?, options_json = ?
       WHERE id = ? AND session_id = ?`,
    ).bind(
      improved.assistantMessage,
      JSON.stringify(improved.options),
      assistant.id,
      session.id,
    ),
    env.DB.prepare(
      `UPDATE launch_session_turns
       SET status = 'complete', attempts = CASE WHEN attempts < 1 THEN 1 ELSE attempts END,
           last_error = NULL, completed_at = COALESCE(completed_at, ?), updated_at = ?
       WHERE assistant_message_id = ? AND session_id = ?`,
    ).bind(
      now,
      now,
      assistant.id,
      session.id,
    ),
    env.DB.prepare(
      `UPDATE launch_sessions
       SET suggested_name = ?, brief_json = ?, readiness_json = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      improved.suggestedCompanyName ?? session.suggested_name,
      JSON.stringify(improved.brief),
      JSON.stringify(improved.readiness),
      now,
      session.id,
    ),
  ]);

  const updatedSession: LaunchSessionRow = {
    ...session,
    suggested_name: improved.suggestedCompanyName ?? session.suggested_name,
    brief_json: JSON.stringify(improved.brief),
    readiness_json: JSON.stringify(improved.readiness),
    updated_at: now,
  };
  const updatedMessages = await loadSessionMessages(env, session.id);
  return { session: updatedSession, messages: updatedMessages };
}

async function tryClaimAssistantTurn(input: {
  env: Env;
  session: LaunchSessionRow;
  turn: LaunchSessionTurnRow;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await input.env.DB.prepare(
    `UPDATE launch_session_turns
     SET status = 'processing', started_at = ?, completed_at = NULL, last_error = NULL, updated_at = ?
     WHERE assistant_message_id = ? AND session_id = ? AND status = ? AND updated_at = ?`,
  ).bind(
    now,
    now,
    input.turn.assistant_message_id,
    input.session.id,
    input.turn.status,
    input.turn.updated_at,
  ).run();
  return (result.meta?.changes ?? 0) > 0;
}

async function runAssistantTurn(input: {
  env: Env;
  session: LaunchSessionRow;
  assistantMessageId: string;
  brief: LaunchSessionBrief;
  transcript: LaunchSessionMessageInput[];
}): Promise<void> {
  const currentTurn = await loadSessionTurnByAssistantMessage(input.env, input.assistantMessageId);
  const priorAttemptHistory = await loadTurnAttemptHistory(input.env, input.assistantMessageId);
  const meta = turnMetaFromRow(currentTurn) ?? {
    status: "processing" as AssistantMessagePhase,
    attempts: 0,
    provider: null,
    model: null,
    durationMs: null,
    lastError: null,
    startedAt: null,
    completedAt: null,
    promptChars: null,
    transcriptMessages: null,
    statusCode: null,
  };
  const attempts = meta.attempts + 1;
  await saveTurnRow(input.env, input.assistantMessageId, {
    ...meta,
    status: "processing",
    attempts,
    lastError: null,
    startedAt: meta.startedAt ?? new Date().toISOString(),
    completedAt: null,
  });

  const generated = await withTimeout<LaunchSessionTurnGeneration>(
    generateLaunchSessionTurn({
      env: input.env,
      mode: input.session.mode,
      companyName: input.session.suggested_name || input.session.input_name,
      idea: input.session.input_idea,
      brief: input.brief,
      messages: input.transcript,
    }),
    TURN_HARD_TIMEOUT_MS,
    () => ({
      ok: false,
      error: `The launch-studio turn exceeded the ${Math.round(TURN_HARD_TIMEOUT_MS / 1000)}s hard timeout.`,
      attempts: [],
    }),
  );
  await saveTurnAttemptHistory(
    input.env,
    input.assistantMessageId,
    [...priorAttemptHistory, ...generated.attempts],
  );
  const completedAt = new Date().toISOString();
  const finalAttempt = generated.attempts.length > 0
    ? generated.attempts[generated.attempts.length - 1]
    : null;

  if (generated.ok && generated.result) {
    // If the founder explicitly asked to launch, force readiness
    const lastFounderMessage = input.transcript.length > 0
      ? input.transcript[input.transcript.length - 1]
      : null;
    if (lastFounderMessage?.role === "founder") {
      const lower = lastFounderMessage.content.toLowerCase();
      const launchIntent = /\b(launch|let'?s go|ship it|ready|start|good enough|looks good|do it|go ahead|just launch|make it happen)\b/i.test(lower);
      if (launchIntent && !generated.result.readiness.ready) {
        generated.result.readiness = {
          ...generated.result.readiness,
          ready: true,
          score: Math.max(generated.result.readiness.score, 90),
          blockers: [],
          nextBestQuestion: null,
        };
      }
    }

    // Ensure there are always options after an assistant turn
    generated.result = ensureFallbackOptions(generated.result, {
      idea: input.session.input_idea,
      companyName: input.session.suggested_name || input.session.input_name,
    });

    await completePendingAssistantTurn({
      env: input.env,
      session: input.session,
      assistantMessageId: input.assistantMessageId,
      assistant: generated.result,
      meta: buildTurnMetaFromAttempt({
        status: "complete",
        attempts,
        lastError: null,
        startedAt: meta.startedAt ?? completedAt,
        completedAt,
        attemptLog: finalAttempt,
      }),
    });
    if (generated.result.readiness.ready) {
      await guardedEnsureArtifacts(input.env, {
        ...input.session,
        status: "ready",
        suggested_name: generated.result.suggestedCompanyName ?? input.session.suggested_name,
        brief_json: JSON.stringify(generated.result.brief),
        readiness_json: JSON.stringify(generated.result.readiness),
        updated_at: new Date().toISOString(),
      });
    }
    return;
  }

  const error = generated.error ?? "No usable model output was returned.";
  if (attempts >= MAX_TURN_ATTEMPTS) {
    await markAssistantTurnError({
      env: input.env,
      session: input.session,
      assistantMessageId: input.assistantMessageId,
      error,
      meta: buildTurnMetaFromAttempt({
        status: "error",
        attempts,
        lastError: error,
        startedAt: meta.startedAt ?? completedAt,
        completedAt,
        attemptLog: finalAttempt,
      }),
    });
    return;
  }

  await resetAssistantTurnToPending({
    env: input.env,
    session: input.session,
    assistantMessageId: input.assistantMessageId,
    meta: buildTurnMetaFromAttempt({
      status: "pending",
      attempts,
      lastError: error,
      startedAt: null,
      completedAt,
      attemptLog: finalAttempt,
    }),
  });
}

function buildTranscriptUpToMessage(
  messages: LaunchSessionMessageRow[],
  turns: LaunchSessionTurnRow[],
  assistantMessageId: string,
): LaunchSessionMessageInput[] {
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId);
  const relevantMessages = assistantIndex >= 0
    ? messages.slice(0, assistantIndex)
    : messages;
  const turnMap = buildTurnMap(turns);
  return relevantMessages.flatMap<LaunchSessionMessageInput>((message) => {
    if (message.role === "founder") {
      return [{ role: "founder", content: stripFounderPrefix(message.content) }];
    }
    const turn = turnMap.get(message.id);
    const phase = turn?.status ?? getAssistantMessagePhase(message.content);
    if (phase !== "complete") {
      return [];
    }
    return [{ role: "assistant", content: stripAssistantPrefix(message.content) }];
  });
}

// NOTE: kickoffPendingAssistantTurn and runPendingAssistantTurn were removed as part of
// the launch turn race condition fix. The SSE /stream endpoint is now the sole processor
// of turns via generateLaunchSessionTurnStreaming. This eliminates the race where
// ctx.waitUntil would claim the turn before the SSE endpoint could stream it.

export async function handleCreateLaunchSession(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const userId = await requireAuthenticatedUser(request, env);
  if (typeof userId !== "string") {
    return userId;
  }

  const body = await request.json().catch(() => ({})) as {
    companyName?: string;
    idea?: string;
    mode?: string;
  };

  const idea = body.idea?.trim() || "";
  if (idea.length < 5) {
    return Response.json(
      { error: "Please describe your business idea in plain language first." },
      { status: 400, headers: corsHeaders(env) },
    );
  }
  if (!hasInferableCompanyMeaning(idea)) {
    return Response.json(
      {
        error: "Please describe the company in plain language so we can infer what it actually does.",
        detail: "Try one simple sentence about the product and who it is for. Example: \"An AI assistant that helps dentists answer inbound leads faster.\"",
      },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const sessionId = generateId();
  const mode = normalizeMode(body.mode);
  const now = new Date().toISOString();
  const session: LaunchSessionRow = {
    id: sessionId,
    user_id: userId,
    status: "active",
    mode,
    input_name: body.companyName?.trim() || null,
    input_idea: idea,
    suggested_name: body.companyName?.trim() || null,
    brief_json: JSON.stringify(buildInitialBrief(idea)),
    readiness_json: JSON.stringify(buildInitialReadiness()),
    artifacts_json: null,
    launched_company_id: null,
    created_at: now,
    updated_at: now,
  };

  await env.DB.prepare(
    `INSERT INTO launch_sessions (
       id, user_id, status, mode, input_name, input_idea, suggested_name,
       brief_json, readiness_json, artifacts_json, launched_company_id,
       created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    session.id,
    session.user_id,
    session.status,
    session.mode,
    session.input_name,
    session.input_idea,
    session.suggested_name,
    session.brief_json,
    session.readiness_json,
    session.artifacts_json,
    session.launched_company_id,
    session.created_at,
    session.updated_at,
  ).run();

  const initialFounderMessage = [
    session.input_name ? `Proposed company name: ${session.input_name}` : null,
    `Idea: ${session.input_idea}`,
    "Help me shape this into a company the AI team can run autonomously for a long time with minimal founder input.",
  ].filter(Boolean).join("\n");

  const pending = await persistPendingAssistantTurn({
    env,
    session,
    founderMessage: `${BOOTSTRAP_FOUNDER_PREFIX}${initialFounderMessage}`,
  });

  const { messages, turns } = await loadSessionConversation(env, pending.session);
  // Turn stays pending — the SSE /stream endpoint is the sole processor.
  // This eliminates the race condition where kickoffPendingAssistantTurn via
  // ctx.waitUntil would claim the turn before the SSE endpoint could stream it.
  return Response.json(await toResponse(env, pending.session, messages, turns), { headers: corsHeaders(env) });
}

export async function handleGetLaunchSession(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  sessionId: string,
): Promise<Response> {
  const userId = await requireAuthenticatedUser(request, env);
  if (typeof userId !== "string") {
    return userId;
  }

  let session = await loadSession(env, sessionId, userId);
  if (!session) {
    return Response.json(
      { error: "Launch session not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }
  let { messages, turns } = await loadSessionConversation(env, session);
  const upgraded = await maybeUpgradeGenericKickoff(env, session, messages);
  session = upgraded.session;
  ({ messages, turns } = await loadSessionConversation(env, session));
  kickoffArtifactGenerationIfNeeded(env, ctx, session);

  // Do NOT run the turn inline — that blocks the response for 90-120s and can timeout.
  // The SSE /stream endpoint is the sole processor of turns, ensuring proper streaming.
  return Response.json(await toResponse(env, session, messages, turns), { headers: corsHeaders(env) });
}

export async function handleLaunchSessionMessage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  sessionId: string,
): Promise<Response> {
  const userId = await requireAuthenticatedUser(request, env);
  if (typeof userId !== "string") {
    return userId;
  }

  let session = await loadSession(env, sessionId, userId);
  if (!session) {
    return Response.json(
      { error: "Launch session not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }
  if (session.status === "launched" || session.status === "launching") {
    return Response.json(
      { error: "This launch session has already been used." },
      { status: 409, headers: corsHeaders(env) },
    );
  }

  const body = await request.json().catch(() => ({})) as { message?: string };
  const founderMessage = body.message?.trim() || "";
  if (!founderMessage) {
    return Response.json(
      { error: "Message is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  let { messages, turns } = await loadSessionConversation(env, session);
  if (hasPendingAssistantTurn(turns)) {
    return Response.json(
      { error: "Opus is still responding to the current turn." },
      { status: 409, headers: corsHeaders(env) },
    );
  }
  const brief = parseJsonObject<LaunchSessionBrief>(session.brief_json, buildInitialBrief(session.input_idea));
  const pending = await persistPendingAssistantTurn({
    env,
    session,
    founderMessage,
  });
  const pendingConversation = await loadSessionConversation(env, pending.session);
  // Turn stays pending — the SSE /stream endpoint is the sole processor.
  return Response.json(
    await toResponse(env, pending.session, pendingConversation.messages, pendingConversation.turns),
    { headers: corsHeaders(env) },
  );
}

export async function handleRetryLaunchSessionTurn(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  sessionId: string,
): Promise<Response> {
  const userId = await requireAuthenticatedUser(request, env);
  if (typeof userId !== "string") {
    return userId;
  }

  const session = await loadSession(env, sessionId, userId);
  if (!session) {
    return Response.json(
      { error: "Launch session not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  // Load raw turns first (before repair) to check the unmodified turn status.
  // This is needed because loadSessionConversation runs repairAbandonedProcessingTurns,
  // which would convert stale processing turns to pending before we can detect them.
  const rawTurns = await loadSessionTurns(env, session.id);
  const lastRawTurn = rawTurns.length > 0 ? rawTurns[rawTurns.length - 1] : null;
  if (!lastRawTurn) {
    return Response.json(
      { error: "There is no Opus turn to retry yet." },
      { status: 409, headers: corsHeaders(env) },
    );
  }

  const phase = lastRawTurn.status;
  if (phase === "complete") {
    return Response.json(
      { error: "The latest Opus turn already completed." },
      { status: 409, headers: corsHeaders(env) },
    );
  }

  if (phase === "pending") {
    return Response.json(
      { error: "This turn is queued and waiting to be processed. Please wait." },
      { status: 409, headers: corsHeaders(env) },
    );
  }

  if (phase === "processing") {
    const updatedAt = Date.parse(lastRawTurn.updated_at);
    const elapsed = Number.isNaN(updatedAt) ? Infinity : Date.now() - updatedAt;
    if (elapsed < PROCESSING_STALE_MS) {
      return Response.json(
        { error: "This turn is still being processed. Please wait a moment before retrying." },
        { status: 409, headers: corsHeaders(env) },
      );
    }
    // Stale processing turn — force-reset and requeue
    await retryAssistantTurn({
      env,
      session,
      assistantMessageId: lastRawTurn.assistant_message_id,
    });
  }

  if (phase === "error") {
    await retryAssistantTurn({
      env,
      session,
      assistantMessageId: lastRawTurn.assistant_message_id,
    });
  }

  const { messages, turns } = await loadSessionConversation(env, session);
  // Turn stays pending — the SSE /stream endpoint is the sole processor.
  return Response.json(await toResponse(env, session, messages, turns), { headers: corsHeaders(env) });
}

export async function handleLaunchFromSession(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  sessionId: string,
): Promise<Response> {
  const userId = await requireAuthenticatedUser(request, env);
  if (typeof userId !== "string") {
    return userId;
  }

  let session = await loadSession(env, sessionId, userId);
  if (!session) {
    return Response.json(
      { error: "Launch session not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }
  // 1. Check readiness BEFORE any status change
  const readiness = parseJsonObject<LaunchSessionReadiness>(session.readiness_json, buildInitialReadiness());
  if (!readiness.ready) {
    return Response.json(
      { error: "This company brief is not ready to launch yet.", blockers: readiness.blockers },
      { status: 409, headers: corsHeaders(env) },
    );
  }

  // 2. Atomically claim this session using 'launching' intermediate status.
  //    This prevents double-launches while ensuring clients never see 'launched'
  //    without a launched_company_id.
  const claimResult = await env.DB.prepare(
    `UPDATE launch_sessions
     SET status = 'launching', updated_at = ?
     WHERE id = ? AND status NOT IN ('launching', 'launched')`,
  ).bind(new Date().toISOString(), session.id).run();

  if ((claimResult.meta?.changes ?? 0) === 0) {
    // Another request already claimed or launched this session
    return Response.json(
      { error: "This launch session has already launched a company.", companyId: session.launched_company_id },
      { status: 409, headers: corsHeaders(env) },
    );
  }

  // 3. Ensure artifacts BEFORE setting status to 'launched'
  //    Use guarded version to prevent duplicate generation when the deferred
  //    stream artifact path is already running with a claim.
  const artifactSession = await guardedEnsureArtifacts(env, session);
  if (artifactSession) {
    session = artifactSession;
  }
  const artifacts = parseJsonObject<LaunchSessionArtifacts | null>(session.artifacts_json, null);
  if (!artifacts) {
    // Roll back to 'ready' since we can't actually launch
    await env.DB.prepare(
      `UPDATE launch_sessions SET status = 'ready', updated_at = ? WHERE id = ?`,
    ).bind(new Date().toISOString(), session.id).run();
    return Response.json(
      { error: "Launch artifacts could not be prepared." },
      { status: 500, headers: corsHeaders(env) },
    );
  }

  const brief = parseJsonObject<LaunchSessionBrief>(session.brief_json, buildInitialBrief(session.input_idea));

  // 4. Provision the company. Only set 'launched' AFTER provisioning succeeds.
  try {
    const result = await createAndProvisionCompany(
      {
        userId,
        idea: session.input_idea,
        requestedName: session.suggested_name || session.input_name,
        expandedBrief: [
          artifacts.companySpecMd,
          "",
          artifacts.missionMd,
          "",
          artifacts.firstMilestoneMd,
          "",
          artifacts.autonomyContractMd,
        ].join("\n"),
        companyGoal: brief.concept || session.input_idea,
      },
      env,
      ctx,
    );

    // Atomically set status to 'launched' AND record the company ID together
    await env.DB.prepare(
      `UPDATE launch_sessions
       SET status = 'launched', launched_company_id = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(result.id, new Date().toISOString(), session.id).run();

    return Response.json(result, { status: 201, headers: corsHeaders(env) });
  } catch (error) {
    // Determine whether the failure happened before or after company creation.
    // Pre-provision failures (4xx: credit check, validation, bad input) are safe
    // to roll back because no company row exists yet. Post-provision failures
    // (5xx: supervisor unreachable, DB write after INSERT) may have created a
    // company row, so we keep 'launched' to prevent duplicate provisioning.
    const errorStatus = typeof (error as { status?: number }).status === "number"
      ? (error as { status: number }).status
      : 500;
    const isPreProvisionFailure = errorStatus >= 400 && errorStatus < 500;

    if (isPreProvisionFailure) {
      await env.DB.prepare(
        `UPDATE launch_sessions SET status = 'ready', updated_at = ? WHERE id = ?`,
      ).bind(new Date().toISOString(), session.id).run();
    } else {
      // Post-provision failure: keep status as 'launching' to prevent duplicate provisioning.
      // The claim check uses WHERE status NOT IN ('launching', 'launched'), so 'launching'
      // still blocks re-attempts. Unlike 'launched', 'launching' does NOT violate the
      // invariant that 'launched' always has a launched_company_id.
      // No status update needed — session is already in 'launching' from the claim step.
    }

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Could not launch company. Please try again.",
        requiredCredits: (error as { requiredCredits?: number }).requiredCredits,
        balance: (error as { balance?: number }).balance,
      },
      { status: errorStatus, headers: corsHeaders(env) },
    );
  }
}

function serializeSseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function handleStreamLaunchSession(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  sessionId: string,
): Promise<Response> {
  const userId = await requireAuthenticatedUser(request, env);
  if (typeof userId !== "string") {
    return userId;
  }

  let session = await loadSession(env, sessionId, userId);
  if (!session) {
    return Response.json(
      { error: "Launch session not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  let { messages, turns } = await loadSessionConversation(env, session);
  const upgraded = await maybeUpgradeGenericKickoff(env, session, messages);
  session = upgraded.session;
  ({ messages, turns } = await loadSessionConversation(env, session));
  kickoffArtifactGenerationIfNeeded(env, ctx, session);

  const hasPending = hasPendingAssistantTurn(turns);

  if (!hasPending) {
    // Turn already complete — send done event immediately with current state
    const sessionResponse = await toResponse(env, session, messages, turns);
    const body = serializeSseEvent({ type: "done", session: sessionResponse });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(env),
      },
    });
  }

  // Turn is pending — use true streaming to pipe tokens as they arrive
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  if (!latestTurn) {
    const sessionResponse = await toResponse(env, session, messages, turns);
    const body = serializeSseEvent({ type: "done", session: sessionResponse });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(env),
      },
    });
  }

  // Claim the turn for processing
  const phase = latestTurn.status;
  const canClaim = phase === "pending"
    || (phase === "processing" && Date.now() - new Date(latestTurn.updated_at).getTime() >= PROCESSING_STALE_MS);

  if (!canClaim) {
    // Turn is being processed by another worker — fall back to non-streaming polling behavior
    const processingResponse = await toResponse(env, session, messages, turns);
    const body = serializeSseEvent({ type: "processing", session: processingResponse });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(env),
      },
    });
  }

  const claimed = await tryClaimAssistantTurn({ env, session, turn: latestTurn });
  if (!claimed) {
    // Race lost — another request claimed the turn. Return processing state.
    const processingResponse = await toResponse(env, session, messages, turns);
    const body = serializeSseEvent({ type: "processing", session: processingResponse });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(env),
      },
    });
  }

  const brief = parseJsonObject<LaunchSessionBrief>(session.brief_json, buildInitialBrief(session.input_idea));
  const transcript = buildTranscriptUpToMessage(messages, turns, latestTurn.assistant_message_id);

  // Set up the SSE TransformStream for true incremental streaming
  const encoder = new TextEncoder();
  const responseStream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = responseStream.writable.getWriter();

  // Capture variables for the async background task
  const assistantMessageId = latestTurn.assistant_message_id;
  const capturedSession = session;
  const capturedUserId = userId;

  // Run the streaming turn in the background via ctx.waitUntil so the
  // Response can be returned immediately and chunks piped to the client.
  ctx.waitUntil((async () => {
    // Start a periodic heartbeat to prevent connection timeouts during
    // processing gaps (e.g. after tokens end, before done event with DB writes).
    // SSE comments (": heartbeat\n\n") are ignored by EventSource parsers
    // but keep the TCP connection alive.
    const HEARTBEAT_INTERVAL_MS = 10_000;
    const heartbeatTimer = setInterval(async () => {
      try {
        await writer.write(encoder.encode(": heartbeat\n\n"));
      } catch {
        // Writer may be closed; heartbeat is best-effort.
      }
    }, HEARTBEAT_INTERVAL_MS);

    try {
      // Send processing event first
      const processingResponse = await toResponse(env, capturedSession, messages, turns);
      await writer.write(encoder.encode(serializeSseEvent({ type: "processing", session: processingResponse })));

      // Load attempt history for the turn
      const priorAttemptHistory = await loadTurnAttemptHistory(env, assistantMessageId);
      const currentTurn = await loadSessionTurnByAssistantMessage(env, assistantMessageId);
      const meta = turnMetaFromRow(currentTurn) ?? {
        status: "processing" as AssistantMessagePhase,
        attempts: 0,
        provider: null,
        model: null,
        durationMs: null,
        lastError: null,
        startedAt: null,
        completedAt: null,
        promptChars: null,
        transcriptMessages: null,
        statusCode: null,
      };
      const attempts = meta.attempts + 1;
      await saveTurnRow(env, assistantMessageId, {
        ...meta,
        status: "processing",
        attempts,
        lastError: null,
        startedAt: meta.startedAt ?? new Date().toISOString(),
        completedAt: null,
      });

      // Use the streaming generator
      const stream = generateLaunchSessionTurnStreaming({
        env,
        mode: capturedSession.mode,
        companyName: capturedSession.suggested_name || capturedSession.input_name,
        idea: capturedSession.input_idea,
        brief,
        messages: transcript,
      });

      let generation: LaunchSessionTurnGeneration | null = null;
      for await (const event of stream) {
        if (event.type === "token") {
          await writer.write(encoder.encode(serializeSseEvent({ type: "token", content: event.content })));
        } else if (event.type === "result") {
          generation = event.generation;
        }
      }

      // Send a heartbeat after streaming ends to keep the connection alive
      // during the processing gap (DB writes, artifact generation) before done.
      try {
        await writer.write(encoder.encode(": heartbeat\n\n"));
      } catch {
        // Writer may be closed; heartbeat is best-effort.
      }

      if (!generation) {
        generation = {
          ok: false,
          error: "Streaming generator produced no result.",
          attempts: [],
        };
      }

      // Save attempt history
      await saveTurnAttemptHistory(env, assistantMessageId, [
        ...priorAttemptHistory,
        ...generation.attempts,
      ]);

      const completedAt = new Date().toISOString();
      const finalAttempt = generation.attempts.length > 0
        ? generation.attempts[generation.attempts.length - 1]
        : null;

      // Artifact session captured inside the success branch, used after done event
      let artifactSession: LaunchSessionRow | null = null;

      if (generation.ok && generation.result) {
        // If the founder explicitly asked to launch, force readiness
        const lastFounderMessage = transcript.length > 0
          ? transcript[transcript.length - 1]
          : null;
        if (lastFounderMessage?.role === "founder") {
          const lower = lastFounderMessage.content.toLowerCase();
          const launchIntent = /\b(launch|let'?s go|ship it|ready|start|good enough|looks good|do it|go ahead|just launch|make it happen)\b/i.test(lower);
          if (launchIntent && !generation.result.readiness.ready) {
            generation.result.readiness = {
              ...generation.result.readiness,
              ready: true,
              score: Math.max(generation.result.readiness.score, 90),
              blockers: [],
              nextBestQuestion: null,
            };
          }
        }

        // Ensure there are always options after an assistant turn
        generation.result = ensureFallbackOptions(generation.result, {
          idea: capturedSession.input_idea,
          companyName: capturedSession.suggested_name || capturedSession.input_name,
        });

        await completePendingAssistantTurn({
          env,
          session: capturedSession,
          assistantMessageId,
          assistant: generation.result,
          meta: buildTurnMetaFromAttempt({
            status: "complete",
            attempts,
            lastError: null,
            startedAt: meta.startedAt ?? completedAt,
            completedAt,
            attemptLog: finalAttempt,
          }),
        });

        // Capture artifact session for deferred generation after the done event
        if (generation.result.readiness.ready) {
          artifactSession = {
            ...capturedSession,
            status: "ready" as const,
            suggested_name: generation.result.suggestedCompanyName ?? capturedSession.suggested_name,
            brief_json: JSON.stringify(generation.result.brief),
            readiness_json: JSON.stringify(generation.result.readiness),
            updated_at: new Date().toISOString(),
          };
        }
      } else {
        const error = generation.error ?? "No usable model output was returned.";
        if (attempts >= MAX_TURN_ATTEMPTS) {
          await markAssistantTurnError({
            env,
            session: capturedSession,
            assistantMessageId,
            error,
            meta: buildTurnMetaFromAttempt({
              status: "error",
              attempts,
              lastError: error,
              startedAt: meta.startedAt ?? completedAt,
              completedAt,
              attemptLog: finalAttempt,
            }),
          });
        } else {
          await resetAssistantTurnToPending({
            env,
            session: capturedSession,
            assistantMessageId,
            meta: buildTurnMetaFromAttempt({
              status: "pending",
              attempts,
              lastError: error,
              startedAt: null,
              completedAt,
              attemptLog: finalAttempt,
            }),
          });
        }
      }

      // Reload final state and send done event IMMEDIATELY — don't block on artifact generation
      const finalSession = (await loadSession(env, sessionId, capturedUserId)) ?? capturedSession;
      const finalConversation = await loadSessionConversation(env, finalSession);
      const finalResponse = await toResponse(env, finalSession, finalConversation.messages, finalConversation.turns);
      await writer.write(encoder.encode(serializeSseEvent({ type: "done", session: finalResponse })));

      // Defer artifact generation AFTER the done event is sent.
      // IMPORTANT: Wrap in its own ctx.waitUntil() so the artifact promise is
      // lifecycle-bound independently of the outer streaming ctx.waitUntil().
      // Without this, when the outer async function resolves (writer.close()),
      // Cloudflare may terminate the isolate and kill the detached artifact promise.
      if (artifactSession) {
        const artifactPromise = (async () => {
          const claimed = await tryClaimArtifactGeneration(env, artifactSession.id);
          if (!claimed) return;
          try {
            await ensureArtifacts(env, artifactSession);
          } finally {
            await clearArtifactGenerationClaim(env, artifactSession.id);
          }
        })().catch((err) => {
          console.warn("[launch-session-stream] deferred artifact generation failed", err instanceof Error ? err.message : "unknown");
        });
        ctx.waitUntil(artifactPromise);
      }
    } catch (error) {
      console.warn("[launch-session-stream] stream handler error", error instanceof Error ? error.message : "unknown");
      try {
        await writer.write(encoder.encode(serializeSseEvent({
          type: "error",
          error: error instanceof Error ? error.message : "Stream processing failed.",
        })));
      } catch {
        // Writer may already be closed
      }
    } finally {
      clearInterval(heartbeatTimer);
      try {
        await writer.close();
      } catch {
        // Writer may already be closed
      }
    }
  })());

  return new Response(responseStream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(env),
    },
  });
}
