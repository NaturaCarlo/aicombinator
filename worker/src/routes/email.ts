import type { Env } from "../types.js";
import { corsHeaders } from "../middleware/cors.js";
import { logActivity } from "../utils/activity.js";
import { generateId } from "../provisioning/config-builder.js";
import { verifySvixSignature } from "../utils/svix.js";
import {
  ensureAgentmailInbox,
  extractEmailAddress,
  getAgentmailInboxOwner,
  getAgentmailThreadOwner,
  getAgentmailWebhookSecret,
  rememberAgentmailInboxOwner,
  rememberAgentmailThreadOwner,
  sendAgentmailMessage,
} from "../integrations/agentmail.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";
import { isCompatibleInternalContractVersion } from "../utils/internal-contract.js";

function verifySupervisorKey(request: Request, env: Env): boolean {
  const contractVersion = request.headers.get("X-AIC-Contract-Version");
  if (!isCompatibleInternalContractVersion(contractVersion)) {
    return false;
  }
  const key = request.headers.get("X-Supervisor-Key");
  return !!key && key === env.SUPERVISOR_API_KEY;
}

interface AgentMailMessageReceivedEvent {
  type: "event";
  event_type: "message.received";
  event_id: string;
  message: {
    inbox_id: string;
    message_id: string;
    thread_id: string;
    from: string;
    to?: string[] | null;
    cc?: string[] | null;
    bcc?: string[] | null;
    subject?: string | null;
    text?: string | null;
    html?: string | null;
    extracted_text?: string | null;
    extracted_html?: string | null;
    preview?: string | null;
  };
}

export async function handleAgentmailWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return Response.json(
      { error: "Missing Svix headers" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const body = await request.text();
  const signingSecret = await getAgentmailWebhookSecret(env);
  if (!signingSecret) {
    return Response.json(
      { error: "AgentMail webhook secret is not configured" },
      { status: 503, headers: corsHeaders(env) },
    );
  }

  const ts = Number.parseInt(svixTimestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) {
    return Response.json(
      { error: "Webhook timestamp too old" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const isValid = await verifySvixSignature(
    body,
    svixId,
    svixTimestamp,
    svixSignature,
    signingSecret,
  );
  if (!isValid) {
    return Response.json(
      { error: "Invalid webhook signature" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const dedupeKey = `agentmail:webhook:event:${svixId}`;
  const alreadyProcessed = await env.AUTOMATON_KV.get(dedupeKey);
  if (alreadyProcessed) {
    return Response.json({ received: true, duplicate: true }, { headers: corsHeaders(env) });
  }
  await env.AUTOMATON_KV.put(dedupeKey, "1", { expirationTtl: 86_400 });

  const event = JSON.parse(body) as Partial<AgentMailMessageReceivedEvent>;
  if (event.event_type !== "message.received" || !event.message?.inbox_id) {
    return Response.json({ received: true, ignored: true }, { headers: corsHeaders(env) });
  }

  const process = processInboundAgentmailEvent(event as AgentMailMessageReceivedEvent, env);
  if (ctx) {
    ctx.waitUntil(process);
  } else {
    void process;
  }

  return Response.json({ received: true }, { headers: corsHeaders(env) });
}

export async function handleSupervisorSendFounderEmail(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  try {
    if (!verifySupervisorKey(request, env)) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401, headers: corsHeaders(env) },
      );
    }

    const body = (await request.json()) as {
      fromAgentId?: string;
      subject?: string;
      text?: string;
      html?: string | null;
      replyToMessageId?: string | null;
      category?: string | null;
    };

    if (!body.fromAgentId || !body.subject?.trim() || !body.text?.trim()) {
      return Response.json(
        { error: "fromAgentId, subject, and text are required" },
        { status: 400, headers: corsHeaders(env) },
      );
    }

    const sender = await env.DB.prepare(
      `SELECT a.id, a.name, a.email_address, c.name AS company_name, c.user_id
       FROM agents a
       JOIN companies c ON c.id = a.company_id
       WHERE a.id = ?
         AND a.company_id = ?
       LIMIT 1`,
    ).bind(body.fromAgentId, companyId).first<{
      id: string;
      name: string;
      email_address: string | null;
      company_name: string;
      user_id: string;
    }>();

    if (!sender?.email_address) {
      return Response.json(
        { error: "Sender agent email address not found" },
        { status: 404, headers: corsHeaders(env) },
      );
    }

    const founder = await resolveFounderContact(env, sender.user_id);
    if (!founder?.email) {
      return Response.json(
        { error: "Founder email is not available" },
        { status: 404, headers: corsHeaders(env) },
      );
    }

    const inbox = await ensureAgentmailInbox(env, {
      emailAddress: sender.email_address,
      displayName: sender.name,
      requireExactAddress: true,
    });
    if (!inbox.shared) {
      await rememberAgentmailInboxOwner(env, inbox.inbox_id, {
        companyId,
        agentId: sender.id,
        aliasEmail: sender.email_address,
      });
    }

    let sendResult;
    try {
      sendResult = await sendAgentmailMessage(env, {
        inboxId: inbox.inbox_id,
        to: founder.email,
        subject: body.subject.trim(),
        text: body.text.trim(),
        html: body.html || undefined,
        replyToMessageId: body.replyToMessageId || undefined,
      });
    } catch (err) {
      if (!body.replyToMessageId || !isAgentmailMessageNotFoundError(err)) {
        throw err;
      }

      console.warn(
        `[agentmail] Reply target ${body.replyToMessageId} was not found for ${sender.email_address}; falling back to a fresh founder email`,
      );
      sendResult = await sendAgentmailMessage(env, {
        inboxId: inbox.inbox_id,
        to: founder.email,
        subject: body.subject.trim(),
        text: body.text.trim(),
        html: body.html || undefined,
      });
    }

    await logActivity(env, {
      companyId,
      actorType: "agent",
      actorId: sender.id,
      action: "email.sent",
      entityType: "email",
      entityId: sendResult.message_id,
      summary: `${sender.name} emailed the founder: ${body.subject.trim()}`,
      details: {
        category: body.category || "manual",
        to: founder.email,
        threadId: sendResult.thread_id,
      },
      agentId: sender.id,
    });

    await rememberAgentmailThreadOwner(env, sendResult.thread_id, {
      companyId,
      agentId: sender.id,
      aliasEmail: sender.email_address,
    });

    return Response.json(
      {
        messageId: sendResult.message_id,
        threadId: sendResult.thread_id,
        recipient: founder.email,
      },
      { headers: corsHeaders(env) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[agentmail] Failed to send founder email for company ${companyId}: ${message}`,
    );
    return Response.json(
      { error: message },
      { status: 502, headers: corsHeaders(env) },
    );
  }
}

async function processInboundAgentmailEvent(
  event: AgentMailMessageReceivedEvent,
  env: Env,
): Promise<void> {
  const inboxId = event.message.inbox_id.trim().toLowerCase();
  const recipientAgent = await env.DB.prepare(
    `SELECT a.id, a.company_id, a.name, a.role, c.user_id, c.name AS company_name
     FROM agents a
     JOIN companies c ON c.id = a.company_id
     WHERE lower(a.email_address) = ?
     LIMIT 1`,
  ).bind(inboxId).first<{
    id: string;
    company_id: string;
    name: string;
    role: string;
    user_id: string;
    company_name: string;
  }>();

  if (!recipientAgent) {
    const owner = await getAgentmailInboxOwner(env, inboxId);
    const threadOwner = event.message.thread_id
      ? await getAgentmailThreadOwner(env, event.message.thread_id)
      : null;
    const resolvedOwner = owner || threadOwner;
    if (!resolvedOwner) {
      console.warn(`[agentmail] No agent mapped to inbox ${inboxId}`);
      return;
    }

    const fallbackAgent = await env.DB.prepare(
      `SELECT a.id, a.company_id, a.name, a.role, c.user_id, c.name AS company_name
       FROM agents a
       JOIN companies c ON c.id = a.company_id
       WHERE a.id = ?
         AND a.company_id = ?
       LIMIT 1`,
    ).bind(resolvedOwner.agentId, resolvedOwner.companyId).first<{
      id: string;
      company_id: string;
      name: string;
      role: string;
      user_id: string;
      company_name: string;
    }>();

    if (!fallbackAgent) {
      console.warn(`[agentmail] Inbox owner mapping is stale for ${inboxId}`);
      return;
    }

    return processInboundAgentmailEvent(
      {
        ...event,
        message: {
          ...event.message,
          inbox_id: resolvedOwner.aliasEmail,
        },
      },
      env,
    );
  }

  const founder = await resolveFounderContact(env, recipientAgent.user_id);
  const senderEmail = extractEmailAddress(event.message.from);
  const founderEmail = founder?.email ? founder.email.trim().toLowerCase() : null;
  const isFounderSender = !!senderEmail && !!founderEmail && senderEmail === founderEmail;

  const supervisorPayload = {
    type: "email_received",
    companyId: recipientAgent.company_id,
    agentId: recipientAgent.id,
    payload: {
      from: senderEmail || event.message.from,
      subject: event.message.subject || "(no subject)",
      body:
        event.message.extracted_text
        || event.message.text
        || event.message.preview
        || "",
      html: event.message.extracted_html || event.message.html || null,
      inboxId,
      messageId: event.message.message_id,
      threadId: event.message.thread_id,
      founderEmail,
      founderName: founder?.name || null,
      isFounderSender,
    },
  };

  try {
    const supervisorRes = await fetchFromCompanySupervisor(
      env,
      recipientAgent.company_id,
      "/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
        body: JSON.stringify(supervisorPayload),
      },
    );

    if (!supervisorRes) {
      throw new Error("Supervisor not configured");
    }

    if (!supervisorRes.ok) {
      const text = await supervisorRes.text().catch(() => "");
      throw new Error(`Supervisor rejected inbound email: ${supervisorRes.status} ${text}`);
    }

    await logActivity(env, {
      companyId: recipientAgent.company_id,
      actorType: "system",
      actorId: "agentmail",
      action: "email.received",
      entityType: "email",
      entityId: event.message.message_id || generateId(),
      summary: `${recipientAgent.name} received an email${senderEmail ? ` from ${senderEmail}` : ""}`,
      details: {
        inboxId,
        threadId: event.message.thread_id,
        subject: event.message.subject || "(no subject)",
        isFounderSender,
      },
      agentId: recipientAgent.id,
    });
  } catch (err) {
    console.error(
      `[agentmail] Failed to forward inbound message ${event.message.message_id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function resolveFounderContact(
  env: Env,
  userId: string,
): Promise<{ email: string | null; name: string | null }> {
  const stored = await env.DB.prepare(
    `SELECT email, name
     FROM users
     WHERE id = ?
     LIMIT 1`,
  ).bind(userId).first<{ email: string | null; name: string | null }>();

  if (stored?.email && !stored.email.endsWith("@clerk")) {
    return stored;
  }

  if (!env.CLERK_SECRET_KEY) {
    return {
      email: stored?.email || null,
      name: stored?.name || null,
    };
  }

  try {
    const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: {
        Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return {
        email: stored?.email || null,
        name: stored?.name || null,
      };
    }

    const user = await response.json() as {
      email_addresses?: Array<{ email_address?: string }>;
      first_name?: string | null;
      last_name?: string | null;
      image_url?: string | null;
    };

    const email = user.email_addresses?.[0]?.email_address?.trim() || null;
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || stored?.name || null;

    if (email) {
      await env.DB.prepare(
        `UPDATE users
         SET email = ?, name = ?, image_url = COALESCE(?, image_url), updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(email, name, user.image_url || null, userId).run();
      return { email, name };
    }
  } catch (err) {
    console.error(
      `[agentmail] Failed to hydrate founder contact for ${userId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return {
    email: stored?.email || null,
    name: stored?.name || null,
  };
}

function isAgentmailMessageNotFoundError(err: unknown): boolean {
  return err instanceof Error
    && err.message.includes("/reply-all failed: 404")
    && err.message.includes("Message not found");
}
