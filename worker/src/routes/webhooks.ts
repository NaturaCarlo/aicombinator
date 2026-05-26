import type { Env } from "../types.js";
import { corsHeaders } from "../middleware/cors.js";
import { generateId } from "../provisioning/config-builder.js";
import { fetchLiveSupervisorAgents } from "../utils/live-runtime.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";
import { enrichUserProfile } from "../enrichment/profile-enrichment.js";
import { grantCredits, getBalance } from "../utils/credits.js";
import { verifySvixSignature } from "../utils/svix.js";

/**
 * POST /api/webhooks/clerk — Clerk user sync webhook.
 *
 * Handles user.created and user.updated events to keep the users
 * table in D1 in sync with Clerk.
 */
export async function handleClerkWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  // Verify webhook signature
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

  // Verify Svix webhook signature
  const ts = parseInt(svixTimestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) {
    return Response.json(
      { error: "Webhook timestamp too old" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  if (!env.CLERK_WEBHOOK_SECRET) {
    return Response.json(
      { error: "Webhook secret not configured" },
      { status: 500, headers: corsHeaders(env) },
    );
  }

  const isValid = await verifySvixSignature(
    body,
    svixId,
    svixTimestamp,
    svixSignature,
    env.CLERK_WEBHOOK_SECRET,
  );
  if (!isValid) {
    return Response.json(
      { error: "Invalid webhook signature" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const event = JSON.parse(body) as {
    type: string;
    data: {
      id: string;
      email_addresses: { email_address: string }[];
      external_accounts?: {
        provider: string;
        username?: string;
        first_name?: string;
        last_name?: string;
        image_url?: string;
        avatar_url?: string;
        public_metadata?: Record<string, any>;
      }[];
      first_name?: string;
      last_name?: string;
      image_url?: string;
    };
  };

  if (event.type === "user.created" || event.type === "user.updated") {
    const user = event.data;
    const email = user.email_addresses?.[0]?.email_address;
    if (!email) {
      return Response.json({ received: true }, { headers: corsHeaders(env) });
    }

    const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || null;

    await env.DB.prepare(
      `INSERT INTO users (id, email, name, image_url)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         image_url = excluded.image_url,
         updated_at = datetime('now')`,
    )
      .bind(user.id, email, name, user.image_url || null)
      .run();

    // Grant welcome credits if user has no balance yet (new to D1).
    // This handles both user.created AND user.updated where the user
    // exists in Clerk but was wiped from D1.
    const existingBalance = await getBalance(env, user.id);
    if (existingBalance === 0) {
      const hasAnyEvent = await env.DB.prepare(
        `SELECT 1 FROM credit_events WHERE user_id = ? LIMIT 1`,
      ).bind(user.id).first();

      if (!hasAnyEvent) {
        await grantCredits(env, user.id, 1000, "grant", "Free tier welcome credits");

        // Kick off async profile enrichment from X/Twitter data
        if (env.GEMINI_API_KEY && ctx) {
          ctx.waitUntil(
            enrichUserProfile(user.id, user, env).catch((err) =>
              console.error(`Profile enrichment failed for ${user.id}:`, err),
            ),
          );
        }
      }
    }
  }

  if (event.type === "user.deleted") {
    await deleteUserData(event.data.id, env);
  }

  return Response.json({ received: true }, { headers: corsHeaders(env) });
}

export async function handleGetCeoChatHistory(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireCompanyOwnerAccess(request, env, companyId);
  if (auth instanceof Response) {
    return auth;
  }

  const entries = await loadFounderConversationHistory(env, companyId);

  return Response.json({ entries }, { headers: corsHeaders(env) });
}

type FounderHistoryEntry =
  | {
    id: string;
    entryType: "founder_chat";
    founderMessage: string;
    ceoReply: string | null;
    status: "pending" | "complete" | "error";
    error: string | null;
    createdAt: string;
  }
  | {
    id: string;
    entryType: "ceo_notice";
    founderMessage: null;
    ceoReply: string;
    status: "complete";
    error: null;
    createdAt: string;
  };

async function loadFounderConversationHistory(
  env: Env,
  companyId: string,
): Promise<FounderHistoryEntry[]> {
  const entries: FounderHistoryEntry[] = [];
  const seen = new Set<string>();

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, kind, founder_message, ceo_reply, status, error, created_at
       FROM founder_conversations
       WHERE company_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
    ).bind(companyId).all<{
      id: string;
      kind: string;
      founder_message: string | null;
      ceo_reply: string | null;
      status: "pending" | "complete" | "error" | null;
      error: string | null;
      created_at: string;
    }>();

    for (const row of results ?? []) {
      if (row.kind === "founder_chat" && row.founder_message?.trim()) {
        entries.push({
          id: row.id,
          entryType: "founder_chat",
          founderMessage: row.founder_message.trim(),
          ceoReply: row.ceo_reply?.trim() || null,
          status: row.status || "complete",
          error: row.error || null,
          createdAt: row.created_at,
        });
        seen.add(row.id);
        continue;
      }

      if (row.kind === "ceo_notice" && row.ceo_reply?.trim()) {
        entries.push({
          id: row.id,
          entryType: "ceo_notice",
          founderMessage: null,
          ceoReply: row.ceo_reply.trim(),
          status: "complete",
          error: null,
          createdAt: row.created_at,
        });
        seen.add(row.id);
      }
    }
  } catch {
    // Older DBs may not have the table yet; fall through to activity_log.
  }

  const { results: legacyRows } = await env.DB.prepare(
    `SELECT id, type, details, created_at
     FROM activity_log
     WHERE company_id = ?
       AND type IN ('founder_chat', 'ceo_message')
     ORDER BY created_at DESC
     LIMIT 100`,
  ).bind(companyId).all<{ id: string; type: string; details: string | null; created_at: string }>();

  for (const row of legacyRows ?? []) {
    if (seen.has(row.id)) {
      continue;
    }

    if (row.type === "founder_chat") {
      const details = row.details ? JSON.parse(row.details) as {
        message?: string;
        reply?: string | null;
        status?: "pending" | "complete" | "error";
        error?: string | null;
      } : {};
      if (!details.message) {
        continue;
      }
      entries.push({
        id: row.id,
        entryType: "founder_chat",
        founderMessage: details.message,
        ceoReply: details.reply || null,
        status: details.status || "complete",
        error: details.error || null,
        createdAt: row.created_at,
      });
      continue;
    }

    const details = row.details ? JSON.parse(row.details) as { content?: string } : {};
    if (!details.content?.trim()) {
      continue;
    }
    entries.push({
      id: row.id,
      entryType: "ceo_notice",
      founderMessage: null,
      ceoReply: details.content.trim(),
      status: "complete",
      error: null,
      createdAt: row.created_at,
    });
  }

  return entries
    .filter((entry) => entry.entryType === "ceo_notice" || Boolean(entry.founderMessage))
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

/**
 * POST /api/companies/:id/chat — Synchronous chat with the CEO agent.
 * Returns an immediate response from the CEO using the same LLM and context.
 */
export async function handleChatWithCeo(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireCompanyOwnerAccess(request, env, companyId);
  if (auth instanceof Response) {
    return auth;
  }

  const { userId } = auth;

  console.log(`[chat] userId=${userId} companyId=${companyId}`);

  const body = (await request.json()) as { message: string };
  if (!body.message) {
    console.error("[chat] No message in body");
    return Response.json(
      { error: "Message is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  // Find the CEO agent for this company
  const ceoAgent = await resolveCeoAgent(env, companyId);

  if (!ceoAgent) {
    console.error(`[chat] No CEO agent for company=${companyId}`);
    return Response.json(
      { error: "No CEO agent found for this company" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  console.log(`[chat] Proxying to supervisor: ceoAgent=${ceoAgent.id}`);
  const founderChatLogId = generateId();

  await env.DB.prepare(
    `INSERT INTO founder_conversations (id, company_id, kind, founder_message, ceo_reply, status, created_at, updated_at)
     VALUES (?, ?, 'founder_chat', ?, NULL, 'pending', datetime('now'), datetime('now'))`,
  ).bind(
    founderChatLogId,
    companyId,
    body.message,
  ).run();

  // Proxy to supervisor — supervisor builds its own state via gather_ceo_context
  try {
    const supRes = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
        body: JSON.stringify({
          text: body.message,
          founder_state: null,
        }),
      },
    );

    if (!supRes) {
      throw new Error("Supervisor not configured");
    }

    if (!supRes.ok) {
      const err = await supRes.text();
      await updateFounderChatLog(env, founderChatLogId, {
        message: body.message,
        reply: null,
        status: "error",
        error: err,
      });
      return Response.json(
        { error: `Supervisor error: ${err}` },
        { status: supRes.status, headers: corsHeaders(env) },
      );
    }

    const supData = await supRes.json() as { reply?: string };
    const normalizedReply = typeof supData.reply === "string" ? supData.reply.trim() : "";
    if (!normalizedReply) {
      // Graceful fallback instead of erroring
      console.warn(`[chat] Empty reply from supervisor for company=${companyId}`);
      const fallbackReply = "I'm here — let me know what you'd like to work on next.";
      await updateFounderChatLog(env, founderChatLogId, {
        message: body.message,
        reply: fallbackReply,
        status: "complete",
      });
      return Response.json(
        { reply: fallbackReply, grounded: false },
        { headers: corsHeaders(env) },
      );
    }
    await updateFounderChatLog(env, founderChatLogId, {
      message: body.message,
      reply: normalizedReply,
      status: "complete",
    });

    return Response.json(
      { reply: normalizedReply, grounded: false },
      { headers: corsHeaders(env) },
    );
  } catch (err) {
    console.error("Supervisor proxy error:", err);
    await updateFounderChatLog(env, founderChatLogId, {
      message: body.message,
      reply: null,
      status: "error",
      error: "Failed to reach supervisor",
    });
    return Response.json(
      { error: "Failed to reach supervisor" },
      { status: 502, headers: corsHeaders(env) },
    );
  }
}

export async function handleChatWithCeoStream(
  request: Request,
  env: Env,
  companyId: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const auth = await requireCompanyOwnerAccess(request, env, companyId);
  if (auth instanceof Response) {
    return auth;
  }
  const { userId } = auth;

  const body = (await request.json()) as { message: string };
  if (!body.message) {
    return Response.json(
      { error: "Message is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const ceoAgent = await resolveCeoAgent(env, companyId);

  if (!ceoAgent) {
    return Response.json(
      { error: "No CEO agent found for this company" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const founderChatLogId = generateId();
  const createdAt = new Date().toISOString();

  // Create D1 record BEFORE starting stream
  await env.DB.prepare(
    `INSERT INTO founder_conversations (id, company_id, kind, founder_message, ceo_reply, status, created_at, updated_at)
     VALUES (?, ?, 'founder_chat', ?, NULL, 'pending', ?, ?)`,
  ).bind(
    founderChatLogId,
    companyId,
    body.message,
    createdAt,
    createdAt,
  ).run();

  // Try the real SSE streaming endpoint first
  let supervisorRes: Response;
  try {
    const response = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/message/stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
        body: JSON.stringify({
          text: body.message,
          founder_state: null,
        }),
      },
    );
    if (!response) {
      throw new Error("Supervisor not configured");
    }
    supervisorRes = response;
  } catch (err) {
    // Supervisor unreachable — fall back to sync endpoint
    console.warn(`[chat-stream] SSE stream endpoint failed for company=${companyId}, falling back to sync`);
    return handleChatWithCeoStreamFallback(env, companyId, body.message, founderChatLogId, createdAt, ctx);
  }

  if (!supervisorRes.ok || !supervisorRes.body) {
    // Supervisor returned non-200 — fall back to sync
    console.warn(`[chat-stream] SSE stream endpoint returned ${supervisorRes.status} for company=${companyId}, falling back to sync`);
    return handleChatWithCeoStreamFallback(env, companyId, body.message, founderChatLogId, createdAt, ctx);
  }

  // Pipe the supervisor's SSE stream through to the dashboard with meta prepend
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Write meta event first, then pipe supervisor SSE through
  void (async () => {
    try {
      // Prepend our meta event
      await writer.write(encoder.encode(serializeSseEvent({ type: "meta", chatId: founderChatLogId, createdAt })));

      // Read supervisor SSE stream and pipe through, intercepting done/error events
      const reader = supervisorRes.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullReply = "";
      let gotDone = false;
      let gotError = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // Parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const dataLine = part
            .split("\n")
            .filter((line: string) => line.startsWith("data:"))
            .map((line: string) => line.slice(5).trim())
            .filter(Boolean)
            .join("\n");

          if (!dataLine) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(dataLine) as Record<string, unknown>;
          } catch {
            // Forward raw SSE data as-is
            await writer.write(encoder.encode(`data: ${dataLine}\n\n`));
            continue;
          }

          if (parsed.type === "text_delta" && typeof parsed.text === "string") {
            fullReply += parsed.text;
            // Re-emit as "delta" event for dashboard compatibility
            await writer.write(encoder.encode(serializeSseEvent({ type: "delta", text: parsed.text })));
          } else if (parsed.type === "tool_start") {
            // Pass through tool_start events
            await writer.write(encoder.encode(serializeSseEvent(parsed)));
          } else if (parsed.type === "tool_end") {
            // Pass through tool_end events
            await writer.write(encoder.encode(serializeSseEvent(parsed)));
          } else if (parsed.type === "done") {
            gotDone = true;
            const reply = typeof parsed.reply === "string" ? parsed.reply : fullReply;
            // Update D1 in the background
            ctx?.waitUntil(
              updateFounderChatLog(env, founderChatLogId, {
                message: body.message,
                reply: reply || fullReply,
                status: "complete",
              }),
            );
            await writer.write(encoder.encode(serializeSseEvent({ type: "done", reply: reply || fullReply, grounded: false })));
          } else if (parsed.type === "error") {
            gotError = true;
            ctx?.waitUntil(
              updateFounderChatLog(env, founderChatLogId, {
                message: body.message,
                reply: null,
                status: "error",
                error: String(parsed.error ?? "Supervisor error"),
              }),
            );
            await writer.write(encoder.encode(serializeSseEvent({ type: "error", error: parsed.error })));
          }
        }
      }

      // If stream ended without done/error event, emit done with accumulated text
      if (!gotDone && !gotError) {
        if (fullReply) {
          ctx?.waitUntil(
            updateFounderChatLog(env, founderChatLogId, {
              message: body.message,
              reply: fullReply,
              status: "complete",
            }),
          );
          await writer.write(encoder.encode(serializeSseEvent({ type: "done", reply: fullReply, grounded: false })));
        } else {
          // No text received at all — use fallback
          const fallbackReply = "I'm here — let me know what you'd like to work on next.";
          ctx?.waitUntil(
            updateFounderChatLog(env, founderChatLogId, {
              message: body.message,
              reply: fallbackReply,
              status: "complete",
            }),
          );
          await writer.write(encoder.encode(serializeSseEvent({ type: "delta", text: fallbackReply })));
          await writer.write(encoder.encode(serializeSseEvent({ type: "done", reply: fallbackReply, grounded: false })));
        }
      }
    } catch (err) {
      console.error(`[chat-stream] Error piping supervisor SSE for company=${companyId}:`, err);
      ctx?.waitUntil(
        updateFounderChatLog(env, founderChatLogId, {
          message: body.message,
          reply: null,
          status: "error",
          error: "Stream interrupted",
        }),
      );
      try {
        await writer.write(encoder.encode(serializeSseEvent({ type: "error", error: "Stream interrupted" })));
      } catch {
        // Writer may already be closed
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // Already closed
      }
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(env),
    },
  });
}

/**
 * Fallback: call the sync /message endpoint and convert to fake SSE.
 * Used when the streaming endpoint is unavailable.
 */
async function handleChatWithCeoStreamFallback(
  env: Env,
  companyId: string,
  message: string,
  founderChatLogId: string,
  createdAt: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  let supervisorRes: Response;
  try {
    const response = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
        body: JSON.stringify({
          text: message,
          founder_state: null,
        }),
      },
    );
    if (!response) {
      throw new Error("Supervisor not configured");
    }
    supervisorRes = response;
  } catch (err) {
    await updateFounderChatLog(env, founderChatLogId, {
      message,
      reply: null,
      status: "error",
      error: "Failed to reach supervisor",
    });
    return Response.json(
      { error: "Failed to reach supervisor" },
      { status: 502, headers: corsHeaders(env) },
    );
  }

  if (!supervisorRes.ok) {
    const errorText = await supervisorRes.text().catch(() => "Supervisor failed");
    await updateFounderChatLog(env, founderChatLogId, {
      message,
      reply: null,
      status: "error",
      error: errorText,
    });
    return Response.json(
      { error: errorText || "Supervisor failed" },
      { status: supervisorRes.status || 502, headers: corsHeaders(env) },
    );
  }

  const supData = await supervisorRes.json() as { reply?: string };
  const reply = typeof supData.reply === "string" ? supData.reply.trim() : "";
  if (!reply) {
    console.warn(`[chat-stream] Empty reply from supervisor for company=${companyId}`);
    const fallbackReply = "I'm here — let me know what you'd like to work on next.";
    ctx?.waitUntil(
      updateFounderChatLog(env, founderChatLogId, {
        message,
        reply: fallbackReply,
        status: "complete",
      }),
    );
    const enc = new TextEncoder();
    const fallbackStream = new TransformStream<Uint8Array, Uint8Array>();
    const fw = fallbackStream.writable.getWriter();
    void (async () => {
      await fw.write(enc.encode(serializeSseEvent({ type: "meta", chatId: founderChatLogId, createdAt })));
      await fw.write(enc.encode(serializeSseEvent({ type: "delta", text: fallbackReply })));
      await fw.write(enc.encode(serializeSseEvent({ type: "done", reply: fallbackReply, grounded: false })));
      await fw.close();
    })();
    return new Response(fallbackStream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(env),
      },
    });
  }

  ctx?.waitUntil(
    updateFounderChatLog(env, founderChatLogId, {
      message,
      reply,
      status: "complete",
    }),
  );

  const encoder = new TextEncoder();
  const responseStream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = responseStream.writable.getWriter();

  void (async () => {
    await writer.write(encoder.encode(serializeSseEvent({ type: "meta", chatId: founderChatLogId, createdAt })));
    await writer.write(encoder.encode(serializeSseEvent({ type: "delta", text: reply })));
    await writer.write(encoder.encode(serializeSseEvent({ type: "done", reply, grounded: false })));
    await writer.close();
  })();

  return new Response(responseStream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(env),
    },
  });
}

async function resolveCeoAgent(env: Env, companyId: string): Promise<{ id: string } | null> {
  const dbCeo = await env.DB.prepare(
    `
      SELECT id
      FROM agents
      WHERE company_id = ?
        AND (
          role = 'ceo'
          OR blueprint_id = 'ceo'
          OR lower(COALESCE(title, '')) = 'chief executive officer'
          OR lower(COALESCE(title, '')) = 'ceo'
        )
      ORDER BY
        CASE
          WHEN blueprint_id = 'ceo' THEN 0
          WHEN role = 'ceo' THEN 1
          ELSE 2
        END,
        created_at ASC
      LIMIT 1
    `,
  ).bind(companyId).first<{ id: string }>();
  if (dbCeo) {
    return dbCeo;
  }

  const liveAgents = await fetchLiveSupervisorAgents(env, companyId);
  if (!liveAgents?.length) {
    return null;
  }

  const liveCeo = liveAgents.find((agent) =>
    agent.blueprint_id === "ceo"
    || agent.role === "ceo"
    || String(agent.title ?? "").toLowerCase() === "chief executive officer"
    || String(agent.title ?? "").toLowerCase() === "ceo",
  );

  if (!liveCeo) {
    return null;
  }

  try {
    await env.DB.prepare(
      `
        UPDATE agents
        SET role = CASE WHEN role IS NULL OR role = '' THEN 'ceo' ELSE role END,
            blueprint_id = COALESCE(blueprint_id, 'ceo'),
            title = COALESCE(title, 'CEO'),
            updated_at = datetime('now')
        WHERE id = ?
      `,
    ).bind(liveCeo.id).run();
  } catch {
    // Best-effort D1 hydration only.
  }

  return { id: liveCeo.id };
}

async function requireCompanyOwnerAccess(
  request: Request,
  env: Env,
  companyId: string,
): Promise<{ userId: string } | Response> {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const userId = await import("../middleware/auth.js").then((m) =>
    m.verifyClerkJwt(token, env),
  );
  if (!userId) {
    return Response.json(
      { error: "Invalid token" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const company = await env.DB.prepare(
    `SELECT id FROM companies WHERE id = ? AND user_id = ?`,
  )
    .bind(companyId, userId)
    .first<{ id: string }>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  return { userId };
}

async function updateFounderChatLog(
  env: Env,
  logId: string,
  details: {
    message: string;
    reply: string | null;
    status: "pending" | "complete" | "error";
    error?: string;
    grounded?: boolean;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE founder_conversations
     SET founder_message = ?,
         ceo_reply = ?,
         status = ?,
         error = ?,
         grounded = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(
    details.message,
    details.reply,
    details.status,
    details.error ?? null,
    details.grounded ? 1 : 0,
    logId,
  ).run();
}


function serializeSseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function consumeFounderChatStream(
  stream: ReadableStream<Uint8Array>,
): Promise<
  | { status: "complete"; reply: string }
  | { status: "error"; reply: string | null; error: string }
> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let reply = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      const parsed = extractSsePayloads(buffer);
      buffer = parsed.rest;

      for (const payload of parsed.payloads) {
        if (!payload || typeof payload !== "object") continue;

        if (payload.type === "delta" && typeof payload.text === "string") {
          reply += payload.text;
          continue;
        }

        if (payload.type === "done") {
          const finalReply =
            typeof payload.reply === "string" && payload.reply.trim()
              ? payload.reply
              : reply.trim();
          if (finalReply) {
            return { status: "complete", reply: finalReply };
          }
          return {
            status: "error",
            reply: null,
            error: "Founder chat finished without a reply",
          };
        }

        if (payload.type === "error") {
          return {
            status: "error",
            reply: reply.trim() || null,
            error:
              typeof payload.error === "string" && payload.error.trim()
                ? payload.error
                : "Founder chat stream failed",
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (reply.trim()) {
    return { status: "complete", reply: reply.trim() };
  }

  return {
    status: "error",
    reply: null,
    error: "Founder chat stream ended without a reply",
  };
}

function extractSsePayloads(buffer: string): {
  payloads: Array<Record<string, unknown>>;
  rest: string;
} {
  const payloads: Array<Record<string, unknown>> = [];
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? "";

  for (const chunk of chunks) {
    const dataLines = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    if (dataLines.length === 0) continue;

    try {
      payloads.push(JSON.parse(dataLines.join("\n")) as Record<string, unknown>);
    } catch {
      // Ignore malformed stream payloads and keep reading.
    }
  }

  return { payloads, rest };
}

// ─── User Account Deletion ────────────────────────────────────

/**
 * Delete all data associated with a Clerk user.
 *
 * Order matters due to foreign key constraints:
 *   1. Cancel active Stripe cards
 *   2. Delete child records (topups, purchase_requests, activity_log, payments, virtual_cards)
 *   3. Delete companies
 *   4. Delete applications
 *   5. Delete user
 */
async function deleteUserData(userId: string, env: Env): Promise<void> {
  // Find all companies owned by this user
  const companies = await env.DB.prepare(
    `SELECT id FROM companies WHERE user_id = ?`,
  )
    .bind(userId)
    .all<{ id: string }>();

  const companyIds = companies.results?.map((c) => c.id) || [];

  if (companyIds.length > 0) {
    // Cancel any active Stripe cards
    const activeCards = await env.DB.prepare(
      `SELECT provider_card_id FROM virtual_cards
       WHERE company_id IN (${companyIds.map(() => "?").join(",")})
       AND status = 'active'`,
    )
      .bind(...companyIds)
      .all<{ provider_card_id: string }>();

    if (activeCards.results && activeCards.results.length > 0 && env.STRIPE_SECRET_KEY) {
      const { StripeClient } = await import("../integrations/stripe.js");
      const stripe = new StripeClient(env);
      for (const card of activeCards.results) {
        try {
          await stripe.cancelCard(card.provider_card_id);
        } catch {
          // Best-effort — card may already be cancelled
        }
      }
    }

    // Delete all company-level records using the shared helper
    const { deleteCompanyRecords } = await import("./company.js");
    for (const companyId of companyIds) {
      await deleteCompanyRecords(env, companyId);
    }
  }

  // Delete user-level records (not tied to a company_id)
  const USER_DELETE_TABLES: Array<{ table: string; column: string }> = [
    { table: "credit_events", column: "user_id" },
    { table: "credit_balances", column: "user_id" },
    { table: "subscriptions", column: "user_id" },
    { table: "stripe_credit_checkout_sessions", column: "user_id" },
    { table: "stripe_credit_grant_receipts", column: "user_id" },
    { table: "user_profiles", column: "user_id" },
    { table: "applications", column: "user_id" },
    { table: "users", column: "id" },
  ];

  const { results: tableRows } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).all<{ name: string }>();
  const existingTables = new Set((tableRows ?? []).map((r) => r.name));

  const userStatements = USER_DELETE_TABLES
    .filter(({ table }) => existingTables.has(table))
    .map(({ table, column }) =>
      env.DB.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(userId),
    );

  if (userStatements.length > 0) {
    await env.DB.batch(userStatements);
  }
}
