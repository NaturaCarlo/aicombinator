export type CompanyState =
  | "awaiting_funding"
  | "provisioning"
  | "planning"
  | "running"
  | "completed"
  | "sleeping"
  | "paused"
  | "failed"
  | "dead";

export interface Company {
  id: string;
  name: string;
  slug: string;
  idea: string;
  state: CompanyState;
  inferenceModel: string;
  budgetCents: number;
  spentCents: number;
  publicVisible: boolean;
  hostedDomain?: string | null;
  emailDomain?: string | null;
  customDomain?: string | null;
  customDomainCandidate?: string | null;
  customDomainStatus?: string | null;
  runtimeTier?: string | null;
  dedicatedVmStatus?: string | null;
  egressTier?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyStatus {
  companyId: string;
  name: string;
  state: CompanyState;
  engineState?: string | null;
  controlPlane?: {
    mode: "vm_local";
    supervisorReachable: boolean;
    mirrorStatus: "healthy" | "delayed" | "down";
    syncQueueDepth: number | null;
    oldestQueuedAt: string | null;
    lastSuccessfulSyncAt: string | null;
    statusMessage: string;
  };
  turnCount: number;
  lastTurnTime: string | null;
  budgetCents: number;
  spentCents: number;
  remainingCents: number;
  model: string;
  sandboxId: string | null;
  recentThinking: string | null;
  lastHeartbeat: string | null;
  publicVisible: boolean;
  hostedDomain?: string | null;
  emailDomain?: string | null;
  customDomain?: string | null;
  customDomainCandidate?: string | null;
  customDomainStatus?: string | null;
  runtimeTier?: string | null;
  dedicatedVmStatus?: string | null;
  dedicatedVmId?: string | null;
  dedicatedVmIp?: string | null;
  egressTier?: string | null;
  mode?: "autonomous" | "manual";
  domainBundle?: {
    status: "pending_purchase" | "pending_dns" | "pending_mail" | "active" | "failed";
    domain: string;
    totalCredits: number;
    registrationCostUsd: number;
    renewalCostUsd: number | null;
    message: string;
    error: string | null;
    purchasedAt: string | null;
    completedAt: string | null;
  } | null;
  emailAliases?: Array<{
    aliasType: "ceo" | "sales" | "support" | string;
    emailAddress: string;
    status: "pending" | "active" | "error" | string;
    ownerAgentId: string | null;
  }>;
  verifiedTelemetry?: {
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
  };
  recentTurns: {
    id: string;
    timestamp: string;
    state: string;
    thinking: string;
    toolCallCount: number;
    costCents: number;
  }[];
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

export interface FounderTaskAction {
  type: "founder_input";
  resolutionIds: string[];
  prompt: string | null;
  approveLabel: string;
  rejectLabel: string;
  replyPlaceholder: string | null;
  replyRequired: boolean;
}

export interface FounderCreditReservation {
  companyId: string;
  companyName: string;
  state: FounderCompanyState | null;
  reserved: number;
  isCurrentCompany: boolean;
}

export interface AgentSkillBadge {
  slug: string;
  name: string;
}

export interface FounderVisibleAgent {
  id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: FounderAgentStatus;
  email_address?: string | null;
  lastActiveAt: string | null;
  lastTurnAt: string | null;
  reports_to: string | null;
  adapter_type: string | null;
  webhook_url: string | null;
  source: string;
  /** Total standard tokens consumed by this agent */
  total_credits_consumed: number;
  /** LLM model tier for this agent */
  model_tier: string;
  /** Custom instructions (legacy — superseded by system_prompt) */
  instructions: string;
  /** Complete system prompt override. When non-null, used as the full prompt at runtime. */
  system_prompt: string | null;
  skills?: AgentSkillBadge[];
}

export interface FounderVisibleTask {
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
  blockedBy?: { taskId: string; title: string }[];
  action?: FounderTaskAction | null;
}

export interface FounderState {
  companyId: string;
  name: string;
  state: FounderCompanyState;
  status: CompanyStatus;
  /** Token balance and reservation info. Units are standard tokens. */
  credits: {
    /** Total token balance */
    balance: number;
    /** Tokens currently reserved for active turns */
    reserved: number;
    /** Tokens available for use (balance - reserved) */
    available: number;
    /** Tokens reserved by the current company */
    currentCompanyReserved: number;
    /** Tokens reserved by other companies */
    otherCompanyReserved: number;
    contentionReason: string | null;
    reservations: FounderCreditReservation[];
  };
  agents: FounderVisibleAgent[];
  tasks: FounderVisibleTask[];
  documents: CompanyDocument[];
  artifacts: CompanyArtifact[];
  opsSummary: {
    headline: string;
    detail: string;
  };
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
  id: string;
  label: string;
  detail?: string;
  state: "done" | "active" | "pending";
}

export interface LaunchAgentPreview {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  icon: string | null;
}

export interface LaunchTaskPreview {
  id: string;
  title: string;
  status: string;
  owner_name: string | null;
}

export interface CompanyLaunchStatus {
  companyId: string;
  name: string;
  companyState: CompanyState;
  engineState: CompanyState | null;
  ready: boolean;
  terminal: boolean;
  stage: LaunchStage;
  progressPercent: number;
  headline: string;
  detail: string;
  missingItems: string[];
  steps: LaunchStep[];
  team: LaunchAgentPreview[];
  taskPreview: LaunchTaskPreview[];
  missionText: string | null;
  supervisorReachable: boolean;
}

export type LaunchSessionMode = "quick" | "standard" | "deep";

export interface LaunchSessionOption {
  title: string;
  description: string;
  founderReply: string;
}

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

export interface LaunchSessionArtifacts {
  companySpecMd: string;
  missionMd: string;
  firstMilestoneMd: string;
  autonomyContractMd: string;
}

export interface LaunchSessionMessage {
  id: string;
  role: "founder" | "assistant";
  content: string;
  options: LaunchSessionOption[];
  pending: boolean;
  streaming?: boolean;
  error: boolean;
  createdAt: string;
}

export interface LaunchSessionCurrentTurn {
  status: "pending" | "processing" | "error" | "complete";
  attempts: number;
  provider: string | null;
  model: string | null;
  durationMs: number | null;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  promptChars: number | null;
  transcriptMessages: number | null;
  attemptHistory: Array<{
    provider: "anthropic" | "openrouter";
    model: string | null;
    outcome: "success" | "non_ok" | "invalid_payload" | "error";
    durationMs: number;
    statusCode: number | null;
    error: string | null;
    promptChars: number;
    transcriptMessages: number;
  }>;
}

export interface LaunchSession {
  id: string;
  status: "active" | "ready" | "launched";
  mode: LaunchSessionMode;
  inputName: string | null;
  inputIdea: string;
  suggestedName: string | null;
  ready: boolean;
  readiness: LaunchSessionReadiness;
  brief: LaunchSessionBrief;
  artifacts: LaunchSessionArtifacts | null;
  launchedCompanyId: string | null;
  messages: LaunchSessionMessage[];
  currentTurn: LaunchSessionCurrentTurn | null;
  processing: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityEntry {
  id: string;
  type: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface FounderChatMessage {
  id: string;
  entryType: "founder_chat" | "ceo_notice";
  founderMessage: string | null;
  ceoReply: string | null;
  status: "pending" | "complete" | "error";
  error?: string | null;
  createdAt: string;
}

export type ApplicationStatus = "draft" | "submitted" | "accepted" | "rejected";

export interface Application {
  id: string;
  user_id: string;
  status: ApplicationStatus;
  founder_name: string;
  founder_bio: string;
  agent_experience: string;
  prev_projects: string;
  founder_linkedin: string;
  founder_github: string;
  founder_twitter: string;
  company_name: string;
  tagline: string;
  category: string;
  problem_statement: string;
  target_customer: string;
  agent_core_loop: string;
  first_twenty_four_hours: string;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

export interface PublicProfile {
  name: string;
  idea: string;
  state: CompanyState;
  turnCount: number;
  uptime: string;
  createdAt: string;
  recentActivity: {
    summary: string;
    timestamp: string;
  }[];
}

// ─── Admin Types ──────────────────────────────────────────────

export interface AdminApplication extends Application {
  email: string | null;
  user_name: string | null;
  image_url: string | null;
  admin_notes: string | null;
}

export interface AdminCompany {
  id: string;
  name: string;
  slug: string;
  idea: string;
  state: CompanyState;
  inference_model: string;
  budget_cents: number;
  spent_cents: number;
  public_visible: number;
  created_at: string;
  updated_at: string;
  email: string | null;
  owner_name: string | null;
  owner_image: string | null;
  has_card: number;
  pending_purchases: number;
}

export interface AdminCompanyAgent {
  id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: string;
  reports_to: string | null;
  capabilities: string[];
  last_heartbeat_at: string | null;
  created_at: string;
}

export interface AdminCompanyMessage {
  id: string;
  fromName: string;
  toName: string;
  type: string;
  subject: string | null;
  body: string;
  priority: string;
  status: string;
  createdAt: string;
}

export interface AdminCompanyDetail {
  id: string;
  name: string;
  slug: string;
  idea: string;
  genesis_prompt: string;
  state: CompanyState;
  inference_model: string;
  budget_cents: number;
  spent_cents: number;
  public_visible: number;
  created_at: string;
  updated_at: string;
  email: string | null;
  owner_name: string | null;
  owner_image: string | null;
  card: {
    id: string;
    last_four: string;
    card_brand: string;
    status: string;
    balance_cents: number;
    spending_limit_cents: number;
  } | null;
  recentPurchases: AdminPurchaseRequest[];
  recentActivity: {
    id: string;
    type: string;
    summary: string;
    created_at: string;
  }[];
  heartbeat: {
    state: string;
    turnCount: number;
    spentCents: number;
    thinking: string;
    lastTurnTime: string;
    timestamp: string;
  } | null;
  agents: AdminCompanyAgent[];
  messages: AdminCompanyMessage[];
}

export interface AdminPurchaseRequest {
  id: string;
  company_id: string;
  description: string;
  amount_cents: number | null;
  url: string | null;
  status: string;
  notes: string | null;
  admin_notes: string | null;
  created_at: string;
  resolved_at: string | null;
  company_name?: string;
  company_slug?: string;
}

export interface AdminHealthAgent {
  companyId: string;
  name: string;
  slug: string;
  state: string;
  budgetCents: number;
  spentCents: number;
  inferenceModel: string;
  lastHeartbeat: string | null;
  turnCount: number;
  isHealthy: boolean;
}

export interface AdminHealthStats {
  total: number;
  running: number;
  healthy: number;
  totalSpentCents: number;
}

// ─── Multi-Agent Orchestration Types ─────────────────────────

export type AgentStatus = "idle" | "free" | "running" | "working" | "sleeping" | "offline" | "error" | "paused" | "terminated" | "pending_approval";

export interface Agent {
  id: string;
  company_id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reports_to: string | null;
  capabilities: string;
  adapter_config: string;
  runtime_config: string;
  permissions: string;
  last_heartbeat_at: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  // Phase 5+ fields
  blueprint_id?: string | null;
  model_tier?: string;
  email_address?: string | null;
  total_credits_consumed?: number;
  last_wake_at?: string | null;
  last_sleep_at?: string | null;
  department?: string | null;
  adapter_type?: string | null;
  webhook_url?: string | null;
  instructions?: string;
  system_prompt?: string | null;
  source?: string;
}



export interface CostSummary {
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  eventCount: number;
}

export interface CostByAgent {
  agent_id: string | null;
  agent_name: string | null;
  total_cost_cents: number;
  total_input_tokens: number;
  total_output_tokens: number;
  event_count: number;
}

// ─── Agent Messages ──────────────────────────────────────────

export interface AgentMessage {
  id: string;
  companyId: string;
  fromAgentId: string | null;
  fromName: string;
  fromRole: string;
  toAgentId: string;
  toName: string;
  toRole: string;
  type: "message" | "task" | "report" | "approval_request";
  subject: string | null;
  body: string;
  priority: string;
  status: string;
  parentMessageId: string | null;
  createdAt: string;
  readAt: string | null;
  metadata?: Record<string, unknown>;
}

// ─── Billing Types ────────────────────────────────────────────

export interface BillingStatus {
  credits: {
    balance: number;
    history: CreditEvent[];
    totalEvents: number;
  };
  subscription: {
    plan: "free" | "paid" | "pro" | "max";
    status: "active" | "past_due" | "cancelled" | "trialing";
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelledAt: string | null;
  };
  autoRefill: {
    enabled: boolean;
    threshold: number;
    amount: number;
  };
  entitlements: {
    monthlyTokens: number;
    runtimeTier: "shared" | "dedicated";
    egressTier: "standard" | "residential";
    customDomainIncluded: boolean;
  };
  limits: {
    maxCompanies: number;
  };
}

export interface CreditPurchaseConfirmation {
  status: "granted" | "pending_payment" | "failed";
  balance: number;
  grantedCredits: number;
}

export interface DomainBundleQuote {
  quoteId: string;
  domain: string;
  emailBundleCredits: number;
  domainCredits: number;
  totalCredits: number;
  registrationCostUsd: number;
  renewalCostUsd: number | null;
  expiresAt: string;
  inboxes: string[];
}

export interface DomainBundlePurchaseResult {
  orderId: string;
  bundle: NonNullable<CompanyStatus["domainBundle"]>;
  remainingCredits: number;
}

export interface CreditEvent {
  id: string;
  type: "grant" | "deduct" | "refill" | "subscription" | "free_tier" | "expiry";
  amount: number;
  balance_after: number;
  description: string | null;
  company_id: string | null;
  company_name: string | null;
  created_at: string;
}

// ─── Tasks ──────────────────────────────────────────────────

export type TaskStatus = "pending" | "ready" | "todo" | "in_progress" | "blocked" | "done" | "cancelled" | "failed";

export interface Task {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  owner_agent_id: string | null;
  blocked_reason: string | null;
  artifact: string | null;
  parent_task_id: string | null;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Blueprints ─────────────────────────────────────────────

// ─── Burn Rate ──────────────────────────────────────────────

/** Burn rate metrics. All values are in standard tokens. */
export interface BurnRateMetrics {
  /** Standard tokens consumed in the last 1 hour */
  creditsLast1h: number;
  /** Standard tokens consumed in the last 24 hours */
  creditsLast24h: number;
  /** Standard tokens consumed per hour */
  creditsPerHour: number;
  /** Standard tokens consumed per day */
  creditsPerDay: number;
  daysRemaining: number | null;
  /** Current standard token balance */
  balance: number;
}

// ─── Real-time Events ───────────────────────────────────────

export type RealtimeEventType =
  | "agent_wake"
  | "agent_sleep"
  | "agent_error"
  | "credit_deduct"
  | "task_update"
  | "company_state";

export interface RealtimeEvent {
  type: RealtimeEventType;
  companyId: string;
  agentId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

// ─── Company Documents ───────────────────────────────────────

export interface CompanyDocument {
  id: string;
  type: "mission" | "daily_report" | "milestone" | "escalation" | "question" | "workspace_document";
  title: string;
  body: string;
  agentName?: string;
  createdAt: string;
  excerpt?: string;
  path?: string;
  category?: string;
}

export interface CompanyArtifact {
  path: string;
  title: string;
  kind: string;
  excerpt: string;
  updatedAt: string;
  urls?: string[];
  previewDataUrl?: string;
  openUrl?: string;
}
