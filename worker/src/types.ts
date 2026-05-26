/**
 * Types for the Agentmarket API worker.
 */

// ─── Env bindings ────────────────────────────────────────────────
export interface Env {
  // AGENT DO removed — agent execution moving to VM supervisor
  AUTOMATON_KV: KVNamespace;
  DB: D1Database;
  ENVIRONMENT: string;
  BASE_RPC_URL: string;
  WORKER_API_URL: string;
  FRONTEND_URL: string;
  CLERK_SECRET_KEY: string;
  CLERK_WEBHOOK_SECRET: string;
  OPENROUTER_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  AGENTMAIL_API_KEY: string;
  BROWSERBASE_API_KEY: string;
  BROWSERBASE_PROJECT_ID: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SUPERVISOR_API_KEY: string;
  SUPERVISOR_URL: string;
  SHARED_SUPERVISOR_URL: string;
  BROWSERBASE_FUNCTION_ID: string;
  ADMIN_USER_IDS: string;
  GEMINI_API_KEY: string;
  PORKBUN_API_KEY: string;
  PORKBUN_SECRET_API_KEY: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_DASHBOARD_SCRIPT_NAME: string;
  HETZNER_API_TOKEN: string;
}

// ─── Agent (DO) types ────────────────────────────────────────────

export type FoundingRole = "ceo" | "cto" | "engineer" | "qa_lead" | "api_key_agent" | "cmo";

export interface AgentConfig {
  agentId: string;
  companyId?: string;
  name: string;
  role?: string;
  title?: string;
  foundingRole?: FoundingRole;
  genesisPrompt: string;
  creatorMessage: string;
  inferenceProvider: "openrouter" | "openai" | "anthropic";
  inferenceApiKey: string;
  inferenceModel: string;
  inferenceApiUrl: string;
  maxTokensPerTurn: number;
  agentmailApiKey: string;
  browserbaseApiKey: string;
  browserbaseProjectId: string;
  browserbaseFunctionId: string;
  twiliAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  captchaApiKey: string;
  cdpApiKeyId: string;
  cdpApiKeySecret: string;
  cdpWalletSecret: string;
  walletAddress: string;
  walletNetwork: string;
  hetznerApiToken: string;
  proxyUrl: string;
  proxyUser: string;
  proxyPass: string;
  vmLocation: string;
  budgetCents: number;
  spentCents: number;
  createdAt: string;
}

export type AgentState =
  | "setup"
  | "waking"
  | "running"
  | "sleeping"
  | "low_compute"
  | "critical"
  | "dead"
  | "paused"
  | "pending_approval";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: InferenceToolCall[];
  tool_call_id?: string;
}

export interface InferenceToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface InferenceResponse {
  id: string;
  model: string;
  message: ChatMessage;
  toolCalls?: InferenceToolCall[];
  usage: TokenUsage;
  finishReason: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface Turn {
  id: string;
  timestamp: string;
  state: AgentState;
  thinking: string;
  toolCalls: ToolCallResult[];
  tokenUsage: TokenUsage;
  costCents: number;
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  durationMs: number;
  error?: string;
}

export interface InferenceToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ─── Platform types ──────────────────────────────────────────────

export type CompanyState =
  | "awaiting_funding"
  | "provisioning"
  | "planning"
  | "running"
  | "sleeping"
  | "paused"
  | "completed"
  | "failed"
  | "dead";

export interface CompanyRow {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  idea: string;
  genesis_prompt: string;
  state: CompanyState;
  wallet_address: string | null;
  private_key_encrypted: string | null;
  inference_model: string;
  budget_cents: number;
  spent_cents: number;
  public_visible: number;
  goal: string | null;
  custom_domain: string | null;
  custom_domain_candidate: string | null;
  custom_domain_status: string;
  hosted_domain: string | null;
  email_domain: string | null;
  runtime_tier: string;
  dedicated_vm_status: string;
  dedicated_vm_id: string | null;
  dedicated_vm_ip: string | null;
  egress_tier: string;
  mode: "autonomous" | "manual";
  container_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainBundleQuoteRow {
  id: string;
  user_id: string;
  company_id: string;
  domain_name: string;
  registration_cost_cents: number;
  renewal_cost_cents: number | null;
  email_bundle_credits: number;
  domain_credits: number;
  total_credits: number;
  status: "quoted" | "used" | "expired" | "invalid";
  provider_payload: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export type DomainBundleOrderStatus =
  | "pending_purchase"
  | "pending_dns"
  | "pending_mail"
  | "active"
  | "failed";

export interface DomainBundleOrderRow {
  id: string;
  user_id: string;
  company_id: string;
  quote_id: string | null;
  domain_name: string;
  registration_cost_cents: number;
  renewal_cost_cents: number | null;
  email_bundle_credits: number;
  domain_credits: number;
  total_credits: number;
  status: DomainBundleOrderStatus;
  registrar_order_id: string | null;
  cloudflare_zone_id: string | null;
  cloudflare_nameservers: string | null;
  dashboard_route_ids: string | null;
  agentmail_pod_id: string | null;
  agentmail_domain_id: string | null;
  error: string | null;
  metadata: string | null;
  last_sync_attempt_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyEmailAliasRow {
  id: string;
  company_id: string;
  owner_agent_id: string | null;
  alias_type: "ceo" | "sales" | "support";
  email_address: string;
  provider: string;
  inbox_id: string | null;
  status: "pending" | "active" | "error";
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityRow {
  id: string;
  company_id: string;
  type: string;
  summary: string;
  details: string | null;
  created_at: string;
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  image_url: string | null;
  plan: SubscriptionPlan;
  max_companies: number;
  created_at: string;
  updated_at: string;
}

export interface PaymentRow {
  id: string;
  company_id: string;
  wallet_address: string;
  expected_usdc: number;
  received_usdc: number;
  status: "pending" | "confirmed" | "failed";
  tx_hash: string | null;
  created_at: string;
  confirmed_at: string | null;
}

// ─── Virtual Card types ─────────────────────────────────────────

export interface VirtualCardRow {
  id: string;
  company_id: string;
  provider_card_id: string;
  provider: string;
  cardholder_id: string | null;
  last_four: string;
  card_brand: string;
  status: "active" | "frozen" | "cancelled";
  balance_cents: number;
  spending_limit_cents: number;
  currency: string;
  created_at: string;
  updated_at: string;
}

export interface PurchaseRequestRow {
  id: string;
  company_id: string;
  description: string;
  amount_cents: number | null;
  url: string | null;
  status: "pending" | "approved" | "rejected" | "fulfilled";
  notes: string | null;
  admin_notes: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface CardTopupRow {
  id: string;
  card_id: string;
  company_id: string;
  usdc_amount: string;
  fiat_amount_cents: number;
  exchange_rate: string | null;
  status: "pending" | "confirmed" | "failed";
  tx_hash: string | null;
  created_at: string;
  completed_at: string | null;
}

// ─── Multi-Agent Orchestration types ────────────────────────────

export type AgentStatus =
  | "idle"
  | "free"
  | "running"
  | "working"
  | "sleeping"
  | "offline"
  | "error"
  | "paused"
  | "terminated"
  | "pending_approval";

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

export interface AgentRow {
  id: string;
  company_id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reports_to: string | null;
  capabilities: string; // JSON array
  adapter_config: string; // JSON
  runtime_config: string; // JSON
  permissions: string; // JSON
  last_heartbeat_at: string | null;
  metadata: string; // JSON
  blueprint_id: string | null;
  model_tier: ModelTier;
  email_address: string | null;
  total_credits_consumed: number;
  last_wake_at: string | null;
  last_sleep_at: string | null;
  department: string | null;
  webhook_url: string | null;
  adapter_type: string | null;
  instructions: string;
  system_prompt: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}


export type ApprovalType = "hire_agent" | "strategy" | "budget_override";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "revision_requested";

export interface ApprovalRow {
  id: string;
  company_id: string;
  type: ApprovalType;
  requested_by_agent_id: string | null;
  requested_by_user_id: string | null;
  status: ApprovalStatus;
  payload: string; // JSON
  decision_note: string | null;
  decided_by_user_id: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalCommentRow {
  id: string;
  company_id: string;
  approval_id: string;
  author_agent_id: string | null;
  author_user_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export type HeartbeatRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type WakeupSource = "on_demand" | "timer" | "assignment" | "automation";

export interface HeartbeatRunRow {
  id: string;
  company_id: string;
  agent_id: string;
  invocation_source: WakeupSource;
  trigger_detail: string | null;
  status: HeartbeatRunStatus;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  error_code: string | null;
  usage_json: string | null; // JSON
  result_json: string | null; // JSON
  context_snapshot: string | null; // JSON
  stdout_excerpt: string | null;
  stderr_excerpt: string | null;
  created_at: string;
  updated_at: string;
}

export type WakeupRequestStatus =
  | "queued"
  | "claimed"
  | "completed"
  | "failed"
  | "deferred_issue_execution"
  | "skipped"
  | "coalesced"
  | "cancelled";

export interface AgentWakeupRequestRow {
  id: string;
  company_id: string;
  agent_id: string;
  source: WakeupSource;
  trigger_detail: string | null;
  reason: string | null;
  payload: string | null; // JSON
  status: WakeupRequestStatus;
  coalesced_count: number;
  requested_by_actor_type: string | null;
  requested_by_actor_id: string | null;
  run_id: string | null;
  requested_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRuntimeStateRow {
  agent_id: string;
  company_id: string;
  adapter_type: string | null;
  session_id: string | null;
  state_json: string; // JSON
  last_run_id: string | null;
  last_run_status: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_cents: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentTaskSessionRow {
  id: string;
  company_id: string;
  agent_id: string;
  adapter_type: string | null;
  task_key: string;
  session_params_json: string | null; // JSON
  session_display_id: string | null;
  last_run_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentApiKeyRow {
  id: string;
  agent_id: string;
  company_id: string;
  name: string;
  key_hash: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface AgentMessageRow {
  id: string;
  company_id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: "message" | "task" | "approval_request" | "report";
  subject: string | null;
  body: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: "unread" | "read" | "acknowledged";
  parent_message_id: string | null;
  metadata: string | null;
  created_at: string;
  read_at: string | null;
}

export type CompanyTelemetryKind =
  | "outreach"
  | "lead"
  | "meeting"
  | "revenue";

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

export interface CompanyTelemetryInput {
  id?: string | null;
  agent_id?: string | null;
  task_id?: string | null;
  kind: CompanyTelemetryKind;
  status: string;
  source?: CompanyTelemetrySource | null;
  source_event_id?: string | null;
  channel?: string | null;
  verification_level?: CompanyTelemetryVerificationLevel;
  subject_name?: string | null;
  subject_email?: string | null;
  subject_company?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
  external_ref?: string | null;
  evidence_ref?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  occurred_at?: string | null;
}

export interface CompanyTelemetryRow {
  id: string;
  company_id: string;
  agent_id: string | null;
  task_id: string | null;
  kind: CompanyTelemetryKind;
  status: string;
  source: CompanyTelemetrySource;
  source_event_id: string | null;
  channel: string | null;
  verification_level: CompanyTelemetryVerificationLevel;
  subject_name: string | null;
  subject_email: string | null;
  subject_company: string | null;
  amount_cents: number | null;
  currency: string | null;
  external_ref: string | null;
  evidence_ref: string | null;
  notes: string | null;
  metadata: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyTelemetrySummary {
  scope: "verified" | "all";
  asOf: string;
  outreach: {
    total: number;
    sent: number;
    replied: number;
    failed: number;
    lastOccurredAt: string | null;
    byChannel: Record<string, number>;
  };
  leads: {
    total: number;
    new: number;
    qualified: number;
    won: number;
    lost: number;
    lastOccurredAt: string | null;
  };
  meetings: {
    total: number;
    scheduled: number;
    completed: number;
    cancelled: number;
    noShow: number;
    lastOccurredAt: string | null;
  };
  revenue: {
    events: number;
    pendingCount: number;
    paidCount: number;
    refundedCount: number;
    pendingCents: number;
    paidCents: number;
    refundedCents: number;
    currency: string | null;
    lastOccurredAt: string | null;
  };
}

export interface CostEventRow {
  id: string;
  company_id: string;
  agent_id: string;
  issue_id: string | null;
  project_id: string | null;
  billing_code: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  occurred_at: string;
  created_at: string;
}

// ─── Credit & Billing types ─────────────────────────────────────

export interface CreditBalanceRow {
  user_id: string;
  balance: number;
  updated_at: string;
}

export type CreditEventType =
  | "grant"
  | "deduct"
  | "refill"
  | "subscription"
  | "free_tier"
  | "expiry";

export interface CreditEventRow {
  id: string;
  user_id: string;
  company_id: string | null;
  agent_id: string | null;
  type: CreditEventType;
  amount: number;
  balance_after: number;
  description: string | null;
  metadata: string | null; // JSON
  created_at: string;
}

export type SubscriptionPlan = "free" | "paid" | "pro" | "max";

/** Returns true for any paid tier (legacy "paid", "pro", or "max"). */
export function isPaidPlan(plan: SubscriptionPlan | string | null | undefined): boolean {
  return plan === "paid" || plan === "pro" || plan === "max";
}
export type SubscriptionStatus = "active" | "past_due" | "cancelled" | "trialing";

export interface SubscriptionRow {
  id: string;
  user_id: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  auto_refill_enabled: number; // SQLite boolean
  auto_refill_threshold: number;
  auto_refill_amount: number;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Task types ─────────────────────────────────────────────────

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";

export interface TaskRow {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  owner_agent_id: string | null;
  status: TaskStatus;
  blocked_on: string | null;
  artifact: string | null;
  parent_task_id: string | null;
  created_by: string;
  priority: "critical" | "high" | "medium" | "low";
  created_at: string;
  updated_at: string;
}


// ─── Cron Task types ────────────────────────────────────────────

export interface CronTaskRow {
  id: string;
  company_id: string;
  agent_id: string;
  schedule: string;
  prompt: string;
  enabled: number; // SQLite boolean
  last_run_at: string | null;
  next_run_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
