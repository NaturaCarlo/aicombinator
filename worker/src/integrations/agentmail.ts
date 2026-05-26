import type { Env } from "../types.js";

const AGENTMAIL_API_BASE = "https://api.agentmail.to/v0";
const WEBHOOK_CLIENT_ID = "aicombinator-founder-email-webhook";
const WEBHOOK_CACHE_KEY = "agentmail:webhook:founder-email";
const INBOX_OWNER_PREFIX = "agentmail:inbox-owner:";
const THREAD_OWNER_PREFIX = "agentmail:thread-owner:";

interface AgentMailWebhookRecord {
  webhook_id: string;
  secret: string;
  url: string;
}

interface AgentMailSendResponse {
  message_id: string;
  thread_id: string;
}

export interface EnsureAgentMailInboxInput {
  emailAddress: string;
  displayName: string;
  clientId?: string;
  requireExactAddress?: boolean;
}

export interface AgentMailInboxOwner {
  companyId: string;
  agentId: string;
  aliasEmail: string;
}

export interface AgentMailDnsRecord {
  type: string;
  host?: string | null;
  name?: string | null;
  value?: string | null;
  content?: string | null;
  priority?: number | null;
  ttl?: number | null;
}

export interface AgentMailDomainRecord {
  id: string;
  domain: string;
  status: string;
  dns_records?: AgentMailDnsRecord[];
  verification_records?: AgentMailDnsRecord[];
}

export interface SendAgentMailInput {
  inboxId: string;
  to?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  replyTo?: string | string[];
  replyToMessageId?: string | null;
  headers?: Record<string, string>;
}

export function extractEmailAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const angleMatch = value.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (angleMatch?.[1]) {
    return angleMatch[1].trim().toLowerCase();
  }

  const directMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return directMatch?.[0]?.trim().toLowerCase() ?? null;
}

export async function getAgentmailWebhookSecret(env: Env): Promise<string | null> {
  const cached = await env.AUTOMATON_KV.get(WEBHOOK_CACHE_KEY, "json") as AgentMailWebhookRecord | null;
  if (cached?.secret) {
    return cached.secret;
  }

  if (!env.AGENTMAIL_API_KEY) {
    return null;
  }

  const created = await ensureAgentmailWebhook(env);
  return created.secret;
}

export async function ensureAgentmailWebhook(env: Env): Promise<AgentMailWebhookRecord> {
  if (!env.AGENTMAIL_API_KEY) {
    throw new Error("AGENTMAIL_API_KEY not configured");
  }

  const webhook = await agentmailRequest<AgentMailWebhookRecord>(
    env,
    "POST",
    "/webhooks",
    {
      url: `${env.WORKER_API_URL}/api/webhooks/agentmail`,
      event_types: ["message.received"],
      client_id: WEBHOOK_CLIENT_ID,
    },
  );

  await env.AUTOMATON_KV.put(
    WEBHOOK_CACHE_KEY,
    JSON.stringify({
      webhook_id: webhook.webhook_id,
      secret: webhook.secret,
      url: webhook.url,
    }),
  );

  return webhook;
}

export async function ensureAgentmailInbox(
  env: Env,
  input: EnsureAgentMailInboxInput,
): Promise<{ inbox_id: string; shared?: boolean }> {
  if (!env.AGENTMAIL_API_KEY) {
    throw new Error("AGENTMAIL_API_KEY not configured");
  }

  const parts = splitEmailAddress(input.emailAddress);
  await ensureAgentmailWebhook(env);

  try {
    return await createInbox(env, {
      username: parts.username,
      domain: parts.domain,
      display_name: input.displayName,
      client_id: input.clientId || buildClientId(input.emailAddress),
    });
  } catch (err) {
    if (input.requireExactAddress) {
      throw new Error(
        `Exact AgentMail alias ${input.emailAddress} is unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!isAgentmailDomainMissingError(err)) {
      throw err;
    }

    try {
      return await createInbox(env, {
        username: buildFallbackInboxUsername(input.emailAddress),
        display_name: input.displayName,
        client_id: `${buildClientId(input.emailAddress)}-fallback`,
      });
    } catch (fallbackErr) {
      if (input.requireExactAddress) {
        throw new Error(
          `Exact AgentMail alias ${input.emailAddress} is unavailable: ${
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
          }`,
        );
      }

      if (!isInboxLimitExceededError(fallbackErr)) {
        throw fallbackErr;
      }

      return {
        inbox_id: await resolveSharedTransportInbox(env),
        shared: true,
      };
    }
  }
}

export async function rememberAgentmailInboxOwner(
  env: Env,
  inboxId: string,
  owner: AgentMailInboxOwner,
): Promise<void> {
  await env.AUTOMATON_KV.put(
    `${INBOX_OWNER_PREFIX}${inboxId.trim().toLowerCase()}`,
    JSON.stringify(owner),
  );
}

export async function getAgentmailInboxOwner(
  env: Env,
  inboxId: string,
): Promise<AgentMailInboxOwner | null> {
  return env.AUTOMATON_KV.get(
    `${INBOX_OWNER_PREFIX}${inboxId.trim().toLowerCase()}`,
    "json",
  ) as Promise<AgentMailInboxOwner | null>;
}

export async function rememberAgentmailThreadOwner(
  env: Env,
  threadId: string,
  owner: AgentMailInboxOwner,
): Promise<void> {
  await env.AUTOMATON_KV.put(
    `${THREAD_OWNER_PREFIX}${threadId.trim()}`,
    JSON.stringify(owner),
  );
}

export async function getAgentmailThreadOwner(
  env: Env,
  threadId: string,
): Promise<AgentMailInboxOwner | null> {
  return env.AUTOMATON_KV.get(
    `${THREAD_OWNER_PREFIX}${threadId.trim()}`,
    "json",
  ) as Promise<AgentMailInboxOwner | null>;
}

export async function sendAgentmailMessage(
  env: Env,
  input: SendAgentMailInput,
): Promise<AgentMailSendResponse> {
  if (!env.AGENTMAIL_API_KEY) {
    throw new Error("AGENTMAIL_API_KEY not configured");
  }

  if (input.replyToMessageId) {
    const replyPayload = {
      ...(input.text ? { text: input.text } : {}),
      ...(input.html ? { html: input.html } : {}),
      ...(input.replyTo !== undefined ? { reply_to: normalizeEmailList(input.replyTo) } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
    };
    return agentmailRequest<AgentMailSendResponse>(
      env,
      "POST",
      `/inboxes/${encodeURIComponent(input.inboxId)}/messages/${encodeURIComponent(input.replyToMessageId)}/reply-all`,
      replyPayload,
    );
  }

  const payload = {
    ...(input.to !== undefined ? { to: normalizeEmailList(input.to) } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.html ? { html: input.html } : {}),
    ...(input.replyTo !== undefined ? { reply_to: normalizeEmailList(input.replyTo) } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
  };

  return agentmailRequest<AgentMailSendResponse>(
    env,
    "POST",
    `/inboxes/${encodeURIComponent(input.inboxId)}/messages/send`,
    payload,
  );
}

function splitEmailAddress(emailAddress: string): { username: string; domain: string } {
  const normalized = emailAddress.trim().toLowerCase();
  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    throw new Error(`Invalid email address: ${emailAddress}`);
  }

  return {
    username: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
  };
}

function normalizeEmailList(value: string | string[]): string | string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => extractEmailAddress(entry) || entry.trim())
      .filter(Boolean);
  }

  return extractEmailAddress(value) || value.trim();
}

async function createInbox(
  env: Env,
  body: {
    username: string;
    domain?: string;
    display_name: string;
    client_id: string;
  },
): Promise<{ inbox_id: string }> {
  return agentmailRequest<{ inbox_id: string }>(
    env,
    "POST",
    "/inboxes",
    body,
  );
}

function isAgentmailDomainMissingError(err: unknown): boolean {
  return err instanceof Error
    && err.message.includes("Domain not found");
}

function isInboxLimitExceededError(err: unknown): boolean {
  return err instanceof Error
    && err.message.includes("Inbox limit exceeded");
}

function buildClientId(emailAddress: string): string {
  return `aicombinator-inbox-${sanitizeAgentmailToken(emailAddress)}`;
}

function buildFallbackInboxUsername(emailAddress: string): string {
  return sanitizeAgentmailToken(emailAddress).slice(0, 48) || "aicombinator";
}

function sanitizeAgentmailToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function resolveSharedTransportInbox(env: Env): Promise<string> {
  const data = await agentmailRequest<{ inboxes?: Array<{ inbox_id: string }> }>(
    env,
    "GET",
    "/inboxes?limit=1",
  );
  const inboxId = data.inboxes?.[0]?.inbox_id;
  if (!inboxId) {
    throw new Error("AgentMail inbox limit exceeded and no shared inbox is available");
  }
  return inboxId;
}

async function agentmailRequest<T>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${AGENTMAIL_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.AGENTMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`AgentMail ${method} ${path} failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<T>;
}

export async function ensureAgentmailPod(
  env: Env,
  clientId: string,
  name: string,
): Promise<{ pod_id: string }> {
  return agentmailRequest<{ pod_id: string }>(
    env,
    "POST",
    "/pods",
    {
      client_id: clientId,
      name,
    },
  );
}

export async function ensureAgentmailDomain(
  env: Env,
  podId: string,
  domain: string,
): Promise<AgentMailDomainRecord> {
  return agentmailRequest<AgentMailDomainRecord>(
    env,
    "POST",
    `/pods/${encodeURIComponent(podId)}/domains`,
    {
      domain,
    },
  );
}

export async function getAgentmailDomain(
  env: Env,
  podId: string,
  domainId: string,
): Promise<AgentMailDomainRecord> {
  return agentmailRequest<AgentMailDomainRecord>(
    env,
    "GET",
    `/pods/${encodeURIComponent(podId)}/domains/${encodeURIComponent(domainId)}`,
  );
}

export async function createAgentmailPodInbox(
  env: Env,
  input: {
    podId: string;
    username: string;
    domain: string;
    displayName: string;
    clientId: string;
  },
): Promise<{ inbox_id: string }> {
  return agentmailRequest<{ inbox_id: string }>(
    env,
    "POST",
    `/pods/${encodeURIComponent(input.podId)}/inboxes`,
    {
      username: input.username,
      domain: input.domain,
      display_name: input.displayName,
      client_id: input.clientId,
    },
  );
}
