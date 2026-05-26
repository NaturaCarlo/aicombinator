/**
 * Agentmarket API — Cloudflare Worker Entry Point (Hono Router)
 */

import { Hono } from "hono";
import type { Env } from "./types";
import { corsHeaders, handleOptions } from "./middleware/cors";
import { sharedSupervisorBaseUrl } from "./utils/supervisor-routing.js";
import { handleCreateCompany, handleGenerateLuckyIdea, handleListCompanies } from "./routes/companies";
import {
  handleCreateLaunchSession,
  handleGetLaunchSession,
  handleLaunchFromSession,
  handleLaunchSessionMessage,
  handleRetryLaunchSessionTurn,
  handleStreamLaunchSession,
} from "./routes/launch-sessions";
import {
  handleGetCompany,
  handleUpdateCompany,
  handleDeleteCompany,
} from "./routes/company";
import { handleCompanyStatus, handleCompanyAgentsStatus, handleCompanyLaunchStatus } from "./routes/company-status";
import { handleFounderState } from "./routes/founder-state";
import { handleCompanyActivity } from "./routes/company-activity";
import {
  handlePublicLandingFile,
  handlePublicLandingFileByHost,
  handlePublicProfile,
} from "./routes/public";
import {
  handleClerkWebhook,
  handleChatWithCeo,
  handleChatWithCeoStream,
  handleGetCeoChatHistory,
} from "./routes/webhooks";
import {
  handleCreateCard,
  handleGetCard,
  handleGetCardDetails,
  handleGetCardBalance,
  handleCardTopup,
  handlePurchaseRequest,
  handleGetPurchaseRequests,
} from "./routes/card";
import { handleGetApplication, handleSaveApplication, handleDeleteApplication } from "./routes/applications";
import {
  handleAdminListApplications,
  handleAdminUpdateApplication,
  handleAdminDeleteApplication,
  handleAdminListCompanies,
  handleAdminGetCompany,
  handleAdminUpdateCompany,
  handleAdminProvisionCompany,
  handleAdminGenerateAvatars,
  handleAdminListPurchases,
  handleAdminUpdatePurchase,
  handleAdminHealth,
} from "./routes/admin";
import {
  handleListAgents,
  handleCreateAgent,
  handleGetAgent,
  handleUpdateAgent,
  handlePauseAgent,
  handleResumeAgent,
  handleTerminateAgent,
  handleWakeAgent,
  handleCreateAgentApiKey,
  handleGetBlueprintPrompt,
} from "./routes/agents";
import {
  handleCreateExternalAgent,
  handleListExternalAgents,
} from "./routes/external-agents";
import { handleImportCompaniesSh } from "./routes/import-companies-sh";
import { handleListAutomations, handleToggleAutomation } from "./routes/automations";
import {
  handleListApprovals,
  handleCreateApproval,
  handleGetApproval,
  handleApproveApproval,
  handleRejectApproval,
  handleCreateApprovalComment,
} from "./routes/approvals";
import { handleCostSummary, handleCostByAgent } from "./routes/costs";
import {
  handleBurnRate,
  handleStatusStream,
  handleListBlueprints,
  handleListTasks,
  handleCreateTask,
  handleUpdateTask,
} from "./routes/realtime";
import { handleCompanyMessages, handleReadAgentKv } from "./routes/agent-messages";
import { handleCompanyArtifact, handleCompanyDocuments } from "./routes/company-documents";
import { handleGetAvatar } from "./routes/avatars";
import {
  handleBillingCheckout,
  handleBillingPortal,
  handleBillingPricing,
  handleBillingStatus,
  handleUpdateAutoRefill,
  handleBuyCredits,
  handleBuyTokens,
  handleConfirmCreditPurchase,
} from "./routes/billing";
import {
  handlePurchaseDomainBundle,
  handleQuoteDomainBundle,
} from "./routes/domain-bundle";
import {
  handleAgentmailWebhook,
  handleSupervisorSendFounderEmail,
} from "./routes/email";
import { handleStripeWebhook } from "./routes/stripe-webhooks";
import {
  handleSupervisorListCompanies,
  handleSupervisorRegisterSharedOrigin,
  handleSupervisorRegisterDedicatedVm,
  handleSupervisorAnthropicProxy,
  handleSupervisorLlmConfig,
  handleSupervisorUpdateCompany,
  handleSupervisorBootstrapCompany,
  handleSupervisorListAgents,
  handleSupervisorCreateAgent,
  handleSupervisorGetCompany,
  handleSupervisorListFounderChats,
  handleSupervisorListChatMessages,
  handleSupervisorCreateChatMessage,
  handleSupervisorListMilestones,
  handleSupervisorCreateMilestone,
  handleSupervisorUpdateMilestone,
  handleSupervisorListTasks,
  handleSupervisorCreateTask,
  handleSupervisorListTelemetry,
  handleSupervisorUpsertTelemetry,
  handleSupervisorListMessages,
  handleSupervisorCreateMessage,
  handleSupervisorAcknowledgeMessage,
  handleSupervisorUpdateTask,
  handleSupervisorListApprovals,
  handleSupervisorCreateApproval,
  handleSupervisorUpdateAgent,
  handleSupervisorAgentWake,
  handleSupervisorAgentSleep,
  handleSupervisorGenerateAgentAvatar,
  handleSupervisorSyncAgentSkills,
  handleSupervisorWarmAvatarPool,
  handleSupervisorListCredits,
  handleSupervisorGetBalance,
  handleSupervisorSetBalance,
  handleSupervisorReconcileStripeCredits,
  handleSupervisorDeductCredits,
  handleSupervisorListCronTasks,
  handleSupervisorCreateCronTask,
  handleSupervisorUpdateCronTask,
  handleSupervisorLogActivity,
} from "./routes/supervisor";

const app = new Hono<{ Bindings: Env }>();

// ─── CORS preflight ─────────────────────────────────────────────
app.options("*", (c) => handleOptions(c.env));

// ─── Health check ───────────────────────────────────────────────
app.get("/health", (c) => Response.json({ status: "ok", service: "agentmarket-api" }, { headers: corsHeaders(c.env) }));
app.get("/", (c) => Response.json({ status: "ok", service: "agentmarket-api" }, { headers: corsHeaders(c.env) }));

// ─── /api/applications ─────────────────────────────────────────
app.get("/api/applications", (c) => handleGetApplication(c.req.raw, c.env));
app.put("/api/applications", (c) => handleSaveApplication(c.req.raw, c.env));
app.delete("/api/applications", (c) => handleDeleteApplication(c.req.raw, c.env));

// ─── /api/admin/* ──────────────────────────────────────────────
app.get("/api/admin/applications", (c) => handleAdminListApplications(c.req.raw, c.env));
app.patch("/api/admin/applications/:id", (c) => handleAdminUpdateApplication(c.req.raw, c.env, c.req.param("id"), c.executionCtx));
app.delete("/api/admin/applications/:id", (c) => handleAdminDeleteApplication(c.req.raw, c.env, c.req.param("id")));
app.get("/api/admin/companies", (c) => handleAdminListCompanies(c.req.raw, c.env));
app.post("/api/admin/companies/:id/provision", (c) => handleAdminProvisionCompany(c.req.raw, c.env, c.req.param("id"), c.executionCtx));
app.post("/api/admin/companies/:id/generate-avatars", (c) => handleAdminGenerateAvatars(c.req.raw, c.env, c.req.param("id")));
app.get("/api/admin/companies/:id", (c) => handleAdminGetCompany(c.req.raw, c.env, c.req.param("id")));
app.patch("/api/admin/companies/:id", (c) => handleAdminUpdateCompany(c.req.raw, c.env, c.req.param("id")));
app.get("/api/admin/purchases", (c) => handleAdminListPurchases(c.req.raw, c.env));
app.patch("/api/admin/purchases/:id", (c) => handleAdminUpdatePurchase(c.req.raw, c.env, c.req.param("id")));
app.get("/api/admin/health", (c) => handleAdminHealth(c.req.raw, c.env));

// ─── /api/companies/:companyId/agents/external ─────────────────
app.get("/api/companies/:companyId/agents/external", (c) => handleListExternalAgents(c.req.raw, c.env, c.req.param("companyId")));
app.post("/api/companies/:companyId/agents/external", (c) => handleCreateExternalAgent(c.req.raw, c.env, c.req.param("companyId")));

// ─── /api/companies/:companyId/automations ─────────────────────
app.get("/api/companies/:companyId/automations", (c) => handleListAutomations(c.req.raw, c.env, c.req.param("companyId")));
app.patch("/api/companies/:companyId/automations/:automationId", (c) => handleToggleAutomation(c.req.raw, c.env, c.req.param("companyId"), c.req.param("automationId")));

// ─── /api/companies/:companyId/import/companies-sh ─────────────
app.post("/api/companies/:companyId/import/companies-sh", (c) => handleImportCompaniesSh(c.req.raw, c.env, c.req.param("companyId")));

// ─── /api/companies/:companyId/agents ──────────────────────────
app.get("/api/companies/:companyId/agents", (c) => handleListAgents(c.req.raw, c.env, c.req.param("companyId"), c.executionCtx));
app.post("/api/companies/:companyId/agents", (c) => handleCreateAgent(c.req.raw, c.env, c.req.param("companyId")));

// ─── /api/agents/:id/* ─────────────────────────────────────────
app.post("/api/agents/:id/pause", (c) => handlePauseAgent(c.req.raw, c.env, c.req.param("id")));
app.post("/api/agents/:id/resume", (c) => handleResumeAgent(c.req.raw, c.env, c.req.param("id")));
app.post("/api/agents/:id/terminate", (c) => handleTerminateAgent(c.req.raw, c.env, c.req.param("id")));
app.post("/api/agents/:id/wake", (c) => handleWakeAgent(c.req.raw, c.env, c.req.param("id")));
app.post("/api/agents/:id/keys", (c) => handleCreateAgentApiKey(c.req.raw, c.env, c.req.param("id")));
app.get("/api/agents/:id", (c) => handleGetAgent(c.req.raw, c.env, c.req.param("id")));
app.get("/api/agents/:id/blueprint-prompt", (c) => handleGetBlueprintPrompt(c.req.raw, c.env, c.req.param("id")));
app.patch("/api/agents/:id", (c) => handleUpdateAgent(c.req.raw, c.env, c.req.param("id")));

// ─── /api/companies/:companyId/approvals ───────────────────────
app.get("/api/companies/:companyId/approvals", (c) => handleListApprovals(c.req.raw, c.env, c.req.param("companyId")));
app.post("/api/companies/:companyId/approvals", (c) => handleCreateApproval(c.req.raw, c.env, c.req.param("companyId")));

// ─── /api/approvals/:id/* ──────────────────────────────────────
app.post("/api/approvals/:id/approve", (c) => handleApproveApproval(c.req.raw, c.env, c.req.param("id")));
app.post("/api/approvals/:id/reject", (c) => handleRejectApproval(c.req.raw, c.env, c.req.param("id")));
app.post("/api/approvals/:id/comments", (c) => handleCreateApprovalComment(c.req.raw, c.env, c.req.param("id")));
app.get("/api/approvals/:id", (c) => handleGetApproval(c.req.raw, c.env, c.req.param("id")));

// ─── /api/companies/:companyId/documents & artifacts ───────────
app.get("/api/companies/:companyId/documents", (c) => handleCompanyDocuments(c.req.raw, c.env, c.req.param("companyId")));
app.get("/api/companies/:companyId/artifacts", (c) => handleCompanyArtifact(c.req.raw, c.env, c.req.param("companyId")));

// ─── /api/companies/:companyId/agent-kv/:agentId/* ─────────────
app.get("/api/companies/:companyId/agent-kv/:agentId/*", (c) => {
  const key = c.req.param("*") ?? "";
  return handleReadAgentKv(c.req.raw, c.env, c.req.param("companyId"), c.req.param("agentId"), decodeURIComponent(key));
});

// ─── /api/companies/:companyId/messages ────────────────────────
app.get("/api/companies/:companyId/messages", (c) => handleCompanyMessages(c.req.raw, c.env, c.req.param("companyId")));

// ─── /api/companies/:companyId/costs ───────────────────────────
app.get("/api/companies/:companyId/costs/summary", (c) => handleCostSummary(c.req.raw, c.env, c.req.param("companyId")));
app.get("/api/companies/:companyId/costs/by-agent", (c) => handleCostByAgent(c.req.raw, c.env, c.req.param("companyId")));

// ─── /api/blueprints ───────────────────────────────────────────
app.get("/api/blueprints", (c) => handleListBlueprints(c.req.raw, c.env));

// ─── /api/companies/:companyId/burn-rate & status/stream ───────
app.get("/api/companies/:companyId/burn-rate", (c) => handleBurnRate(c.req.raw, c.env, c.req.param("companyId")));
app.get("/api/companies/:companyId/status/stream", (c) => handleStatusStream(c.req.raw, c.env, c.req.param("companyId")));

// ─── /api/companies/:companyId/tasks ───────────────────────────
app.get("/api/companies/:companyId/tasks", (c) => handleListTasks(c.req.raw, c.env, c.req.param("companyId")));
app.post("/api/companies/:companyId/tasks", (c) => handleCreateTask(c.req.raw, c.env, c.req.param("companyId")));

// ─── /api/tasks/:id ────────────────────────────────────────────
app.patch("/api/tasks/:id", (c) => handleUpdateTask(c.req.raw, c.env, c.req.param("id")));

// ─── /api/supervisor/* (internal — supervisor → worker D1) ─────
app.get("/api/supervisor/companies", (c) => handleSupervisorListCompanies(c.req.raw, c.env));
app.get("/api/supervisor/llm-config", (c) => handleSupervisorLlmConfig(c.req.raw, c.env));
app.post("/api/supervisor/shared-origin/register", (c) => handleSupervisorRegisterSharedOrigin(c.req.raw, c.env));
app.post("/api/supervisor/dedicated-vm/register", (c) => handleSupervisorRegisterDedicatedVm(c.req.raw, c.env, c.executionCtx));
app.all("/api/supervisor/anthropic-proxy/*", (c) => {
  const subpath = "/" + c.req.param("*");
  return handleSupervisorAnthropicProxy(c.req.raw, c.env, subpath);
});
app.patch("/api/supervisor/companies/:id", (c) => handleSupervisorUpdateCompany(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/companies/:id/bootstrap", (c) => handleSupervisorBootstrapCompany(c.req.raw, c.env, c.req.param("id"), c.executionCtx));
app.get("/api/supervisor/companies/:id/agents", (c) => handleSupervisorListAgents(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/companies/:id/agents", (c) => handleSupervisorCreateAgent(c.req.raw, c.env, c.req.param("id"), c.executionCtx));
app.get("/api/supervisor/companies/:id/info", (c) => handleSupervisorGetCompany(c.req.raw, c.env, c.req.param("id")));
app.get("/api/supervisor/companies/:id/founder-chats", (c) => handleSupervisorListFounderChats(c.req.raw, c.env, c.req.param("id")));
app.get("/api/supervisor/companies/:id/chat-messages", (c) => handleSupervisorListChatMessages(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/companies/:id/chat-messages", (c) => handleSupervisorCreateChatMessage(c.req.raw, c.env, c.req.param("id")));
app.get("/api/supervisor/companies/:id/tasks", (c) => handleSupervisorListTasks(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/companies/:id/tasks", (c) => handleSupervisorCreateTask(c.req.raw, c.env, c.req.param("id")));
app.get("/api/supervisor/companies/:id/milestones", (c) => handleSupervisorListMilestones(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/companies/:id/milestones", (c) => handleSupervisorCreateMilestone(c.req.raw, c.env, c.req.param("id")));
app.patch("/api/supervisor/milestones/:id", (c) => handleSupervisorUpdateMilestone(c.req.raw, c.env, c.req.param("id")));
app.get("/api/supervisor/companies/:id/telemetry", (c) => handleSupervisorListTelemetry(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/companies/:id/telemetry", (c) => handleSupervisorUpsertTelemetry(c.req.raw, c.env, c.req.param("id")));
app.get("/api/supervisor/companies/:id/messages", (c) => handleSupervisorListMessages(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/companies/:id/messages", (c) => handleSupervisorCreateMessage(c.req.raw, c.env, c.req.param("id")));
app.get("/api/supervisor/companies/:id/approvals", (c) => handleSupervisorListApprovals(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/companies/:id/approvals", (c) => handleSupervisorCreateApproval(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/companies/:id/founder-email", (c) => handleSupervisorSendFounderEmail(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/companies/:id/activity", (c) => handleSupervisorLogActivity(c.req.raw, c.env, c.req.param("id")));
app.patch("/api/supervisor/agents/:id", (c) => handleSupervisorUpdateAgent(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/agents/:id/wake", (c) => handleSupervisorAgentWake(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/agents/:id/sleep", (c) => handleSupervisorAgentSleep(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/agents/:id/avatar", (c) => handleSupervisorGenerateAgentAvatar(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/agents/:id/skills", (c) => handleSupervisorSyncAgentSkills(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/avatar-pool/warm", (c) => handleSupervisorWarmAvatarPool(c.req.raw, c.env));
app.post("/api/supervisor/messages/:id/ack", (c) => handleSupervisorAcknowledgeMessage(c.req.raw, c.env, c.req.param("id")));
app.patch("/api/supervisor/tasks/:id", (c) => handleSupervisorUpdateTask(c.req.raw, c.env, c.req.param("id")));
app.get("/api/supervisor/credits", (c) => handleSupervisorListCredits(c.req.raw, c.env));
app.get("/api/supervisor/credits/:id", (c) => handleSupervisorGetBalance(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/credits/:id/balance", (c) => handleSupervisorSetBalance(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/credits/:id/reconcile-stripe", (c) => handleSupervisorReconcileStripeCredits(c.req.raw, c.env, c.req.param("id")));
app.post("/api/supervisor/credits/:id/deduct", (c) => handleSupervisorDeductCredits(c.req.raw, c.env, c.req.param("id")));
app.get("/api/supervisor/cron-tasks", (c) => handleSupervisorListCronTasks(c.req.raw, c.env));
app.post("/api/supervisor/cron-tasks", (c) => handleSupervisorCreateCronTask(c.req.raw, c.env));
app.patch("/api/supervisor/cron-tasks/:id", (c) => handleSupervisorUpdateCronTask(c.req.raw, c.env, c.req.param("id")));

// ─── /api/billing/* ────────────────────────────────────────────
app.post("/api/billing/checkout", (c) => handleBillingCheckout(c.req.raw, c.env));
app.post("/api/billing/portal", (c) => handleBillingPortal(c.req.raw, c.env));
app.get("/api/billing/status", (c) => handleBillingStatus(c.req.raw, c.env));
app.get("/api/billing/pricing", (c) => handleBillingPricing(c.req.raw, c.env));
app.patch("/api/billing/auto-refill", (c) => handleUpdateAutoRefill(c.req.raw, c.env));
app.post("/api/billing/buy-tokens", (c) => handleBuyTokens(c.req.raw, c.env));
app.post("/api/billing/buy-credits", (c) => handleBuyCredits(c.req.raw, c.env));
app.post("/api/billing/credits/confirm", (c) => handleConfirmCreditPurchase(c.req.raw, c.env));

// ─── /api/webhooks/* ───────────────────────────────────────────
app.post("/api/webhooks/stripe", (c) => handleStripeWebhook(c.req.raw, c.env));
app.post("/api/webhooks/clerk", (c) => handleClerkWebhook(c.req.raw, c.env, c.executionCtx));
app.post("/api/webhooks/agentmail", (c) => handleAgentmailWebhook(c.req.raw, c.env, c.executionCtx));

// ─── /api/companies (collection) ───────────────────────────────
app.post("/api/companies/lucky-idea", (c) => handleGenerateLuckyIdea(c.req.raw, c.env));
app.post("/api/launch-sessions", (c) => handleCreateLaunchSession(c.req.raw, c.env, c.executionCtx));
app.get("/api/launch-sessions/:id", (c) => handleGetLaunchSession(c.req.raw, c.env, c.executionCtx, c.req.param("id")));
app.post("/api/launch-sessions/:id/messages", (c) => handleLaunchSessionMessage(c.req.raw, c.env, c.executionCtx, c.req.param("id")));
app.post("/api/launch-sessions/:id/retry-last-turn", (c) => handleRetryLaunchSessionTurn(c.req.raw, c.env, c.executionCtx, c.req.param("id")));
app.post("/api/launch-sessions/:id/launch", (c) => handleLaunchFromSession(c.req.raw, c.env, c.executionCtx, c.req.param("id")));
app.get("/api/launch-sessions/:id/stream", (c) => handleStreamLaunchSession(c.req.raw, c.env, c.executionCtx, c.req.param("id")));
app.post("/api/companies", (c) => handleCreateCompany(c.req.raw, c.env, c.executionCtx));
app.get("/api/companies", (c) => handleListCompanies(c.req.raw, c.env));

// ─── /api/companies/:id/* ──────────────────────────────────────
app.get("/api/companies/:id/status", (c) => handleCompanyStatus(c.req.raw, c.env, c.req.param("id")));
app.get("/api/companies/:id/founder-state", (c) => handleFounderState(c.req.raw, c.env, c.req.param("id")));
app.get("/api/companies/:id/launch-status", (c) => handleCompanyLaunchStatus(c.req.raw, c.env, c.req.param("id"), c.executionCtx));
app.get("/api/companies/:id/agents-status", (c) => handleCompanyAgentsStatus(c.req.raw, c.env, c.req.param("id")));
app.get("/api/companies/:id/activity", (c) => handleCompanyActivity(c.req.raw, c.env, c.req.param("id")));
app.get("/api/companies/:id/card/details", (c) => handleGetCardDetails(c.req.raw, c.env, c.req.param("id")));
app.get("/api/companies/:id/card/balance", (c) => handleGetCardBalance(c.req.raw, c.env, c.req.param("id")));
app.post("/api/companies/:id/card/topup", (c) => handleCardTopup(c.req.raw, c.env, c.req.param("id")));
app.post("/api/companies/:id/card", (c) => handleCreateCard(c.req.raw, c.env, c.req.param("id")));
app.get("/api/companies/:id/card", (c) => handleGetCard(c.req.raw, c.env, c.req.param("id")));
app.get("/api/companies/:id/purchases", (c) => handleGetPurchaseRequests(c.req.raw, c.env, c.req.param("id")));
app.get("/api/companies/:id/chat", (c) => handleGetCeoChatHistory(c.req.raw, c.env, c.req.param("id")));
app.post("/api/companies/:id/chat", (c) => handleChatWithCeo(c.req.raw, c.env, c.req.param("id")));
app.post("/api/companies/:id/chat/stream", (c) => handleChatWithCeoStream(c.req.raw, c.env, c.req.param("id"), c.executionCtx));
app.post("/api/companies/:id/domain-bundle/quote", (c) => handleQuoteDomainBundle(c.req.raw, c.env, c.req.param("id")));
app.post("/api/companies/:id/domain-bundle/purchase", (c) => handlePurchaseDomainBundle(c.req.raw, c.env, c.req.param("id")));
app.get("/api/companies/:id", (c) => handleGetCompany(c.req.raw, c.env, c.req.param("id")));
app.patch("/api/companies/:id", (c) => handleUpdateCompany(c.req.raw, c.env, c.req.param("id")));
app.delete("/api/companies/:id", (c) => handleDeleteCompany(c.req.raw, c.env, c.req.param("id"), c.executionCtx));

// ─── /api/purchases/request ────────────────────────────────────
app.post("/api/purchases/request", (c) => handlePurchaseRequest(c.req.raw, c.env));

// ─── /api/public/* ─────────────────────────────────────────────
app.get("/api/public/file", (c) => handlePublicLandingFileByHost(c.req.raw, c.env));
app.get("/api/public/:slug/file", (c) => handlePublicLandingFile(c.req.raw, c.env, c.req.param("slug")));
app.get("/api/public/:slug", (c) => handlePublicProfile(c.req.raw, c.env, c.req.param("slug")));

// ─── /api/avatars/:agentId ─────────────────────────────────────
app.get("/api/avatars/:agentId", (c) => handleGetAvatar(c.req.raw, c.env, c.req.param("agentId"), c.executionCtx));

// ─── /api/hosting-proxy/* (dashboard → supervisor hosting) ─────
const hostingProxy = async (c: { req: { raw: Request; url: string; method: string }; env: Env }) => {
  const hostingHost = c.req.raw.headers.get("x-hosting-host");
  if (!hostingHost) {
    return Response.json({ error: "Missing x-hosting-host" }, { status: 400 });
  }
  const supervisorUrl = await sharedSupervisorBaseUrl(c.env);
  if (!supervisorUrl) {
    return Response.json({ error: "Supervisor unavailable" }, { status: 502 });
  }
  const url = new URL(c.req.url);
  const proxyPath = url.pathname.replace("/api/hosting-proxy", "/hosting-proxy") || "/hosting-proxy/";
  try {
    return await fetch(`${supervisorUrl}${proxyPath}${url.search}`, {
      method: c.req.method,
      headers: {
        "x-hosting-host": hostingHost,
        Accept: c.req.raw.headers.get("accept") || "*/*",
      },
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    });
  } catch {
    return Response.json({ error: "Supervisor unreachable" }, { status: 502 });
  }
};
app.all("/api/hosting-proxy/*", (c) => hostingProxy(c));
app.all("/api/hosting-proxy", (c) => hostingProxy(c));

// ─── 404 fallback ──────────────────────────────────────────────
app.notFound((c) =>
  Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(c.env) }),
);

// ─── Error handler ─────────────────────────────────────────────
app.onError((err, c) => {
  console.error("Unhandled error:", err instanceof Error ? err.message : err);
  return Response.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders(c.env) });
});

export default app;
