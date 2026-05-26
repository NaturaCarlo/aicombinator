import type { Env } from "../types.js";
import { generateId } from "../provisioning/config-builder.js";

/**
 * Log an activity to the activity_log table with full actor/entity tracking.
 */
export async function logActivity(
  env: Env,
  params: {
    companyId: string;
    actorType: "user" | "agent" | "system";
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    details?: Record<string, unknown>;
    agentId?: string;
    runId?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO activity_log
       (id, company_id, type, summary, details, actor_type, actor_id, action, entity_type, entity_id, agent_id, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      generateId(),
      params.companyId,
      params.action,
      params.summary,
      params.details ? JSON.stringify(params.details) : null,
      params.actorType,
      params.actorId,
      params.action,
      params.entityType,
      params.entityId,
      params.agentId || null,
      params.runId || null,
    )
    .run();
}
