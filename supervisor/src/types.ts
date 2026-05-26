/**
 * Supervisor V2 types.
 *
 * This file combines:
 * - The core V2 data model from SUPERVISOR-SPEC.md
 * - Gaps-spec additions for founder docs, telemetry mirror, and dedicated VM routing
 * - Minimal compatibility exports for carried-over files
 */

// ---------------------------------------------------------------------------
// Core config
// ---------------------------------------------------------------------------

export interface SupervisorConfig {
  workerApiUrl: string;
  internalApiKey: string;
  anthropicApiKey: string;
  port: number;
  dbPath: string;
  scopeUserId?: string;
  founderTimezone: string;
  syncIntervalMs: number;
  cronIntervalMs: number;
  stallCheckEveryTurns: number;
  containerConfig: ContainerConfig;
  relayConfig: RelayConfig;
  openclawConfig?: OpenClawConfig;
}

// ---------------------------------------------------------------------------
// Shared enums / unions
// ---------------------------------------------------------------------------

export type CompanyState =
  | "awaiting_funding"
  | "provisioning"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "dead";

export type AgentStatus =
  | "idle"
  | "working"
  | "paused"
  | "terminated"
  | "error"
  // compatibility with carried-over code / older state labels
  | "running"
  | "sleeping"
  | "pending_approval";

export type TaskStatus =
  | "pending"
  | "ready"
  | "in_progress"
  | "blocked"
  | "done"
  | "cancelled"
  | "failed";

export type MilestoneStatus = "pending" | "active" | "done" | "cancelled" | "failed";
export type MessageRole = "user" | "ceo";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalType =
  | "purchase_service"
  | "external_signup"
  | "strategic_decision"
  | "domain_purchase"
  | "tool_access"
  | "other";

export type ModelTier =
  | "minimax-m2.5"
  | "gemini-3-flash"
  | "glm-4.7"
  | "kimi-k2.5"
  | "haiku-4-5"
  | "glm-5"
  | "gpt-5.2"
  | "gpt-5.2-codex"
  | "gpt-5.3-codex"
  | "gemini-3.1-pro"
  | "gpt-5.4"
  | "sonnet-4-5"
  | "sonnet-4-6"
  | "opus-4-5"
  | "opus-4-6"
  // Legacy tier names (backward compatibility)
  | "haiku"
  | "sonnet"
  | "opus"
  | "gpt4o-mini";
export type AgentProvider = "claude" | "codex" | "openclaw";

export type AdapterType = "claude-code" | "http-webhook" | "bash" | "codex";

// ---------------------------------------------------------------------------
// Container / MCP compatibility
// ---------------------------------------------------------------------------

export interface ContainerResources {
  cpuLimit: string;
  memoryLimit: string;
  cpuReservation: string;
  memoryReservation: string;
}

export const DEFAULT_CONTAINER_RESOURCES: ContainerResources = {
  cpuLimit: "2.0",
  memoryLimit: "2g",
  cpuReservation: "0.5",
  memoryReservation: "512m",
};

export interface ContainerConfig {
  companiesDir: string;
  mcpServersDir: string;
  networkName: string;
  resources: ContainerResources;
}

export const MCP_SERVERS = [
  "email",
  "browser",
  "finance",
  "domain",
  "social",
] as const;

export type McpServerName = (typeof MCP_SERVERS)[number];

export interface ContainerInfo {
  companyId: string;
  containerId: string;
  containerName: string;
  workspaceDir: string;
  status: "created" | "running" | "stopped" | "removing";
}

// ---------------------------------------------------------------------------
// OpenClaw runtime config
// ---------------------------------------------------------------------------

export interface OpenClawConfig {
  /** Whether OpenClaw runtime is available (default: false) */
  enabled: boolean;
  /** Docker image for OpenClaw containers (default: "ghcr.io/openclaw/openclaw:latest") */
  dockerImage: string;
  /** Gateway port inside container (default: 18789) */
  gatewayPort: number;
  /** Default model string for OpenClaw (default: "anthropic/claude-sonnet-4-6") */
  defaultModel: string;
}

export const DEFAULT_OPENCLAW_CONFIG: OpenClawConfig = {
  enabled: false,
  dockerImage: "ghcr.io/openclaw/openclaw:latest",
  gatewayPort: 18789,
  defaultModel: "anthropic/claude-sonnet-4-6",
};

/** Maps supervisor ModelTier to OpenClaw model identifiers. */
export const OPENCLAW_MODEL_MAP: Record<ModelTier, string> = {
  // 15 primary models
  "minimax-m2.5": "anthropic/claude-sonnet-4-6",
  "gemini-3-flash": "anthropic/claude-sonnet-4-6",
  "glm-4.7": "anthropic/claude-sonnet-4-6",
  "kimi-k2.5": "anthropic/claude-sonnet-4-6",
  "haiku-4-5": "anthropic/claude-sonnet-4-6",
  "glm-5": "anthropic/claude-sonnet-4-6",
  "gpt-5.2": "anthropic/claude-sonnet-4-6",
  "gpt-5.2-codex": "anthropic/claude-sonnet-4-6",
  "gpt-5.3-codex": "anthropic/claude-sonnet-4-6",
  "gemini-3.1-pro": "anthropic/claude-sonnet-4-6",
  "gpt-5.4": "anthropic/claude-sonnet-4-6",
  "sonnet-4-5": "anthropic/claude-sonnet-4-6",
  "sonnet-4-6": "anthropic/claude-sonnet-4-6",
  "opus-4-5": "anthropic/claude-sonnet-4-6",
  "opus-4-6": "anthropic/claude-sonnet-4-6",
  // Legacy tier names (backward compatibility)
  opus: "anthropic/claude-sonnet-4-6",
  sonnet: "anthropic/claude-sonnet-4-6",
  haiku: "anthropic/claude-sonnet-4-6",
  "gpt4o-mini": "anthropic/claude-sonnet-4-6",
};

// ---------------------------------------------------------------------------
// Relay compatibility (carried over, not used by V2 scheduler)
// ---------------------------------------------------------------------------

export interface RelayConfig {
  enabled: boolean;
}

export const DEFAULT_COMPANY_CHANNELS = [
  "all-hands",
  "leadership",
  "engineering",
  "marketing",
  "status",
  "escalations",
] as const;

export type CompanyChannel = (typeof DEFAULT_COMPANY_CHANNELS)[number];

export interface RelayMessage {
  from: string;
  to: string;
  text: string;
}

export interface RelayAgentHandle {
  agentId: string;
  companyId: string;
  agentName: string;
  process: unknown;
}

// ---------------------------------------------------------------------------
// Blueprint compatibility
// ---------------------------------------------------------------------------

export type AgentDepartment =
  | "executive"
  | "engineering"
  | "marketing"
  | "sales"
  | "operations"
  | "general";

export interface Workflow {
  name: string;
  steps: string[];
}

export interface AgentBlueprint {
  id: string;
  name: string;
  role: string;
  title: string;
  department: AgentDepartment | string;
  reportsTo: string;
  systemPrompt: string;
  skills: string[];
  workflows: Workflow[];
  requiredTools: string[];
  requiredApiKeys: string[];
  mcpServers: McpServerName[];
  relayChannels: string[];
  provider: AgentProvider;
  /** Optional adapter type override. When set, the AgentInvoker routes to
   *  the corresponding adapter regardless of provider. When absent/undefined,
   *  routing falls back to provider-based dispatch (defaulting to ClaudeCodeAdapter). */
  adapterType?: AdapterType;
  modelTier: ModelTier;
  estimatedCreditsPerDay: number;
  tested: boolean;
  version: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Local SQLite rows (spec source of truth)
// ---------------------------------------------------------------------------

export interface CompanyRow {
  id: string;
  user_id: string;
  name: string;
  goal: string | null;
  genesis_prompt?: string | null;
  state: CompanyState;
  container_id: string | null;
  workspace_dir: string | null;
  mode: "autonomous" | "manual";
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  id: string;
  company_id: string;
  blueprint_id: string | null;
  name: string;
  role: string;
  model_tier: ModelTier;
  status: AgentStatus;
  reports_to?: string | null;
  session_id: string | null;
  current_task_id: string | null;
  total_credits: number;
  total_credits_consumed?: number;
  last_wake_at?: string | null;
  last_sleep_at?: string | null;
  email_address?: string | null;
  metadata?: string | null;
  icon?: string | null;
  created_at: string;
  updated_at?: string;
  // compatibility / convenience fields
  title?: string | null;
  department?: string | null;
  // custom instructions (legacy — superseded by system_prompt)
  instructions?: string;
  // complete system prompt (overrides blueprint when non-null/non-empty)
  system_prompt?: string | null;
  // external agent fields
  webhook_url?: string | null;
  adapter_type?: string | null;
  source?: string;
}

export interface MilestoneRow {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  sort_order: number;
  status: MilestoneStatus;
  created_by: string;
  created_at: string;
  completed_at: string | null;
}

export interface TaskRow {
  id: string;
  company_id: string;
  milestone_id: string;
  title: string;
  description: string | null;
  acceptance_criteria: string;
  depends_on: string;
  owner_agent_id: string | null;
  status: TaskStatus;
  blocked_reason: string | null;
  artifact: string | null;
  credits_spent: number;
  turns_spent: number;
  parent_task_id: string | null;
  created_by: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CreditBalanceRow {
  user_id: string;
  balance: number;
  reserved_balance: number;
  last_synced_at: string;
}

export interface TurnLogRow {
  id: number;
  company_id: string;
  agent_id: string;
  task_id: string | null;
  input_tokens: number;
  output_tokens: number;
  credits_spent: number;
  tool_call_count: number;
  artifact_changed: number;
  agent_declared_done: number;
  output_summary: string | null;
  error: string | null;
  duration_ms: number;
  created_at: string;
}

export type CEOEventType =
  | "user_message"
  | "task_blocked"
  | "milestone_review"
  | "task_failed"
  | "no_agent_assigned"
  | "document_revision"
  | "approval_decided";

export interface CEOEventQueueRow {
  id: number;
  company_id: string;
  event_type: CEOEventType;
  payload: string;
  delivered: number;
  created_at: string;
}

export interface MessageRow {
  id: string;
  company_id: string;
  agent_id: string | null;
  role: MessageRole;
  content: string;
  created_at: string;
}

export interface CronTaskRow {
  id: string;
  company_id: string;
  agent_id: string;
  title: string | null;
  description: string | null;
  schedule: string;
  prompt: string;
  enabled: number;
  last_run_at: string | null;
  created_by: string;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  company_id: string;
  type: ApprovalType | string;
  description: string;
  related_task_id: string | null;
  status: ApprovalStatus;
  resolved_at: string | null;
  created_at: string;
}

export type CompanyTelemetryKind = "outreach" | "lead" | "meeting" | "revenue";
export type CompanyTelemetryVerificationLevel =
  | "self_reported"
  | "evidence_attached"
  | "system_verified";
export type CompanyTelemetrySource =
  | "agentmail_inbound"
  | "agentmail_outbound"
  | "calendar_booking"
  | "payment_provider"
  | "crm_import";

export interface TelemetryMirrorRow {
  id: string;
  company_id: string;
  kind: CompanyTelemetryKind;
  status: string;
  source: CompanyTelemetrySource;
  source_event_id: string;
  verification_level: CompanyTelemetryVerificationLevel;
  subject_name: string | null;
  subject_email: string | null;
  amount_cents: number | null;
  currency: string | null;
  occurred_at: string;
  created_at: string;
}

export interface SyncQueueRow {
  id: number;
  table_name: string;
  record_id: string;
  operation: "upsert" | "delete";
  payload: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Planning / updates
// ---------------------------------------------------------------------------

export type AcceptanceCriterion =
  | { type: "file_exists"; path: string }
  | { type: "file_not_empty"; path: string }
  | { type: "file_contains"; path: string; substring: string }
  | { type: "file_count_gte"; glob: string; min: number }
  | { type: "command_succeeds"; command: string }
  | { type: "directory_exists"; path: string }
  | { type: "custom"; description: string };

export interface PlanTaskInput {
  title: string;
  description: string;
  assigned_to: string;
  depends_on: string[];
  acceptance_criteria: AcceptanceCriterion[];
  milestone_id?: string;
}

export interface PlanMilestoneInput {
  title: string;
  description: string;
  tasks: PlanTaskInput[];
}

export interface PlanDocument {
  milestones: PlanMilestoneInput[];
  agents_needed: string[];
}

export interface TaskUpdateInput {
  id: string;
  title?: string;
  description?: string;
  assigned_to?: string;
  depends_on?: string[];
  acceptance_criteria?: AcceptanceCriterion[];
  milestone_id?: string;
}

export interface PlanUpdateDocument {
  goal?: string;
  add_milestones?: PlanMilestoneInput[];
  cancel_milestones?: string[];
  add_tasks?: PlanTaskInput[];
  cancel_tasks?: string[];
  update_tasks?: TaskUpdateInput[];
  activate_agents?: string[];
  deactivate_agents?: string[];
}

export interface ApprovalRequestPayload {
  type: ApprovalType | string;
  description: string;
  related_task_id?: string;
}

export interface AutomationRequestPayload {
  title: string;
  description?: string;
  schedule: string;
  prompt: string;
}

export interface TaskSignalDone {
  task_id: string;
  artifact: string;
  summary: string;
}

export interface TaskSignalBlocked {
  task_id: string;
  reason: string;
}

export type TaskSignal =
  | { type: "done"; payload: TaskSignalDone }
  | { type: "blocked"; payload: TaskSignalBlocked };

/** Written by CTO to /workspace/.agent/{agent_id}/subtask_request.json */
export interface SubtaskRequestPayload {
  title: string;
  description: string;
  assigned_to: string;
  acceptance_criteria: AcceptanceCriterion[];
  depends_on: string[];
  parent_task_id?: string;
}

export interface CriterionValidationResult {
  criterion: AcceptanceCriterion;
  passed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Runtime / reporting
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}

export interface AgentTurnResult {
  success: boolean;
  tokenUsage: TokenUsage;
  output?: string;
  error?: string;
  aborted: boolean;
  toolCallCount: number;
  durationMs: number;
  sessionId?: string;
}

export interface TurnLimits {
  maxCreditsPerTurn: number;
  maxTokensInput: number;
  maxTokensOutput: number;
  maxToolCallsPerTurn: number;
  maxInferenceRoundsPerTurn: number;
  turnTimeoutMs: number;
}

export interface SessionLimits {
  maxTurnsPerSession: number;
  maxSessionDurationMs: number;
  maxCreditsPerSession: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  maxCreditsPerTurn: 500_000,
  maxTokensInput: 200_000,
  maxTokensOutput: 64_000,
  maxToolCallsPerTurn: 200,
  maxInferenceRoundsPerTurn: 50,
  turnTimeoutMs: 3_600_000,
};

export const ROLE_LIMITS: Record<string, Partial<TurnLimits>> = {
  ceo: {},
  cto: {},
  cmo: {},
  specialist: {},
};

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  maxTurnsPerSession: 200,
  maxSessionDurationMs: 1000 * 60 * 60 * 8,
  maxCreditsPerSession: 50_000_000,
};

export interface CompanyProgressMetrics {
  company_id: string;
  state: CompanyState;
  milestones: {
    total: number;
    done: number;
    active: number;
    pending: number;
  };
  tasks: {
    total: number;
    done: number;
    in_progress: number;
    ready: number;
    pending: number;
    failed: number;
    blocked: number;
  };
  credits: {
    balance: number;
    total_balance: number;
    available_balance: number;
    reserved_total: number;
    current_company_reserved: number;
    reservation_breakdown: CompanyCreditReservation[];
    spent_total: number;
    spent_24h: number;
    burn_rate_per_hour: number;
    estimated_hours_remaining: number | null;
  };
  health: {
    last_task_completed_at: string | null;
    minutes_since_progress: number | null;
    stalled_tasks: number;
    failed_tasks: number;
  };
  agents: {
    total: number;
    working: number;
    idle: number;
  paused: number;
  };
}

export interface CompanyCreditReservation {
  company_id: string;
  company_name: string;
  company_state: CompanyState;
  reserved_balance: number;
}

export interface AgentActivityEntry {
  agent_id: string;
  agent_name: string;
  agent_role: string;
  status: AgentStatus;
  current_task: string | null;
  last_activity: string | null;
  last_active_at: string;
}

export type LaunchStage =
  | "creating_workspace"
  | "creating_ceo"
  | "ceo_mission"
  | "ceo_planning"
  | "activating_team"
  | "delegating_tasks"
  | "founder_briefing"
  | "finalizing"
  | "ready"
  | "awaiting_funding"
  | "failed";

export interface LaunchStep {
  id: LaunchStage | string;
  label: string;
  detail?: string;
  state: "done" | "active" | "pending";
}

export interface LaunchTaskPreview {
  id: string;
  title: string;
  status: TaskStatus;
  owner_name: string | null;
}

export interface LaunchAgentPreview {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: AgentStatus;
  icon: string | null;
}

export interface LaunchStatusPayload {
  company_id: string;
  name: string;
  state: CompanyState;
  ready: boolean;
  terminal: boolean;
  stage: LaunchStage;
  progress_percent: number;
  headline: string;
  detail: string;
  missing_items: string[];
  steps: LaunchStep[];
  team: LaunchAgentPreview[];
  task_preview: LaunchTaskPreview[];
  mission_text: string | null;
}

export interface Stall {
  type: "no_progress" | "no_tool_calls" | "long_running";
  task?: TaskRow;
  agent_id?: string;
  task_id?: string;
}

export interface FounderDocument {
  type: "mission" | "executive_brief" | "daily_update" | "plan";
  title: string;
  content: string;
  path: string;
  date?: string;
  created_at?: string;
}

export interface VerifiedTelemetrySummary {
  outreach: {
    total: number;
    sent: number;
    replied: number;
  };
  leads: {
    total: number;
    new: number;
    qualified: number;
  };
  meetings: {
    total: number;
    scheduled: number;
    completed: number;
  };
  revenue: {
    events: number;
    paidCount: number;
    paidCents: number;
  };
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface ProvisionCompanyPayload {
  id: string;
  user_id: string;
  name: string;
  goal: string | null;
  genesis_prompt?: string | null;
  state?: CompanyState;
  workspace_dir?: string | null;
  container_id?: string | null;
  env?: Record<string, string>;
  created_at: string;
  updated_at?: string;
}

export type FounderCompanyState = "running" | "paused" | "failed";
export type FounderAgentStatus = "free" | "working" | "paused";
export type FounderTaskStatus =
  | "active"
  | "queued"
  | "waiting_on_founder"
  | "waiting_on_dependency"
  | "done"
  | "paused";

export interface FounderStateAgentSnapshot {
  id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: FounderAgentStatus;
  email_address?: string | null;
  lastActiveAt: string | null;
  lastTurnAt: string | null;
}

export interface FounderStateTaskActionSnapshot {
  type: "founder_input";
  resolutionIds: string[];
  prompt: string | null;
  approveLabel: string;
  rejectLabel: string;
  replyPlaceholder: string | null;
  replyRequired: boolean;
}

export interface FounderStateTaskSnapshot {
  id: string;
  title: string;
  description: string | null;
  status: FounderTaskStatus;
  ownerAgentId: string | null;
  ownerName: string | null;
  ownerTitle: string | null;
  ownerIcon: string | null;
  updatedAt: string;
  completedAt: string | null;
  detail: string | null;
  parentTaskId: string | null;
  action?: FounderStateTaskActionSnapshot | null;
}

export interface FounderStateSnapshot {
  companyId: string;
  name: string;
  state: FounderCompanyState;
  credits: {
    balance: number;
    reserved: number;
    available: number;
    currentCompanyReserved: number;
    otherCompanyReserved: number;
    contentionReason: string | null;
    reservations: Array<{
      companyId: string;
      companyName: string;
      state: FounderCompanyState | null;
      reserved: number;
      isCurrentCompany: boolean;
    }>;
  };
  agents: FounderStateAgentSnapshot[];
  tasks: FounderStateTaskSnapshot[];
  opsSummary: {
    headline: string;
    detail: string;
  };
}

export interface UserMessagePayload {
  text: string;
  target_agent_id?: string;
  founder_state?: FounderStateSnapshot | null;
}

export interface ApprovalResolutionPayload {
  decision: "approved" | "rejected";
  note?: string | null;
}

export interface CreditPurchasePayload {
  user_id: string;
  amount: number;
}

export interface TelemetryMirrorPayload extends TelemetryMirrorRow {}

export interface WorkspaceArchivePayload {
  archiveBase64: string;
}

export interface HealthResponse {
  status: "ok";
  scopeUserId?: string;
  founderTimezone: string;
  companies: number;
}
