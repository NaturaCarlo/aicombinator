import type { Env } from "../types.js";
import { generateId } from "../provisioning/config-builder.js";

/**
 * Check if a company is within its monthly budget.
 */
export async function checkCompanyBudget(
  env: Env,
  companyId: string,
): Promise<{
  withinBudget: boolean;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
}> {
  const row = await env.DB.prepare(
    `SELECT budget_monthly_cents, spent_monthly_cents FROM companies WHERE id = ?`,
  )
    .bind(companyId)
    .first<{ budget_monthly_cents: number; spent_monthly_cents: number }>();

  if (!row) {
    return { withinBudget: false, budgetMonthlyCents: 0, spentMonthlyCents: 0 };
  }

  // budget_monthly_cents of 0 means unlimited
  const withinBudget =
    row.budget_monthly_cents === 0 ||
    row.spent_monthly_cents < row.budget_monthly_cents;

  return {
    withinBudget,
    budgetMonthlyCents: row.budget_monthly_cents,
    spentMonthlyCents: row.spent_monthly_cents,
  };
}

/**
 * Record a cost event and update the company's spent total.
 */
export async function recordCostEvent(
  env: Env,
  params: {
    companyId: string;
    agentId?: string | null;
    issueId?: string;
    projectId?: string;
    billingCode?: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  },
): Promise<{ budgetExceeded: boolean }> {
  const id = generateId();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cost_events
         (id, company_id, agent_id, issue_id, project_id, billing_code, provider, model, input_tokens, output_tokens, cost_cents, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind(
      id,
      params.companyId,
      params.agentId || null,
      params.issueId || null,
      params.projectId || null,
      params.billingCode || null,
      params.provider,
      params.model,
      params.inputTokens,
      params.outputTokens,
      params.costCents,
    ),
    env.DB.prepare(
      `UPDATE companies
       SET spent_monthly_cents = spent_monthly_cents + ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(params.costCents, params.companyId),
  ]);

  const budget = await checkCompanyBudget(env, params.companyId);
  return { budgetExceeded: !budget.withinBudget };
}
