/**
 * Agent Communication Hierarchy — Task Routing ACL.
 *
 * Defines who can assign tasks to whom, and who each agent reports
 * status back to (done / blocked / failed). Keyed by blueprint_id.
 */

// ---------------------------------------------------------------------------
// Assignment table: who can create tasks for whom
// ---------------------------------------------------------------------------

/** Maps an assigner's blueprint_id → list of assignee blueprint_ids they can target. */
export const ASSIGNMENT_TABLE: Record<string, readonly string[]> = {
  ceo: ["cto", "cmo", "frontend-dev", "backend-dev", "qa-tester", "seo-specialist"],
  cto: ["frontend-dev", "backend-dev", "qa-tester"],
  cmo: ["seo-specialist"],
};

// ---------------------------------------------------------------------------
// Reporting table: who each agent reports status back to
// ---------------------------------------------------------------------------

/** Maps an agent's blueprint_id → the blueprint_id they report to. */
export const REPORTS_TO_TABLE: Record<string, string> = {
  cto: "ceo",
  cmo: "ceo",
  "frontend-dev": "cto",
  "backend-dev": "cto",
  "qa-tester": "cto",
  "seo-specialist": "cmo",
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Check whether `assigner_blueprint` is allowed to assign tasks to `assignee_blueprint`.
 *
 * Returns true if the assignment is in the ASSIGNMENT_TABLE.
 * Agents not listed as assigners (e.g. cmo, frontend-dev) cannot assign to anyone.
 */
export function canAssignTo(
  assignerBlueprint: string,
  assigneeBlueprint: string,
): boolean {
  const allowed = ASSIGNMENT_TABLE[assignerBlueprint];
  if (!allowed) return false;
  return allowed.includes(assigneeBlueprint);
}

/**
 * Get the blueprint_id of the agent that `agentBlueprint` should report
 * status updates to (done, blocked, failed).
 *
 * Returns undefined for agents not in the table (e.g. CEO reports to founder
 * via a different mechanism — user_message events).
 */
export function getReportTarget(agentBlueprint: string): string | undefined {
  return REPORTS_TO_TABLE[agentBlueprint];
}
