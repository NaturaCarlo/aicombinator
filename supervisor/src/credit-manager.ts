import { SupervisorDb, isoNow } from "./db.js";
import type {
  AgentRow,
  CompanyCreditReservation,
  CompanyRow,
  ModelTier,
  TokenUsage,
  TurnLimits,
} from "./types.js";

export interface CreditDeductionContext {
  company_id?: string | null;
  agent_id?: string | null;
  model_tier?: string | null;
  description?: string | null;
}

export interface CreditBalanceProvider {
  (user_id: string): Promise<number>;
}

/**
 * Standard Token model multipliers (Factory pricing).
 * Formula: standard_tokens = raw_tokens * multiplier
 * Cached tokens: raw_tokens * multiplier * 0.1
 */
export const MODEL_MULTIPLIERS: Record<ModelTier, number> = {
  // 15 primary models
  "minimax-m2.5": 0.12,
  "gemini-3-flash": 0.2,
  "glm-4.7": 0.25,
  "kimi-k2.5": 0.25,
  "haiku-4-5": 0.4,
  "glm-5": 0.4,
  "gpt-5.2": 0.7,
  "gpt-5.2-codex": 0.7,
  "gpt-5.3-codex": 0.7,
  "gemini-3.1-pro": 0.8,
  "gpt-5.4": 1.0,
  "sonnet-4-5": 1.2,
  "sonnet-4-6": 1.2,
  "opus-4-5": 2.0,
  "opus-4-6": 2.0,
  // Legacy tier names (backward compatibility)
  haiku: 0.4,
  sonnet: 1.2,
  opus: 2.0,
  "gpt4o-mini": 0.1,
};

export function calculate_turn_credits(model_tier: ModelTier, token_usage: TokenUsage): number {
  const multiplier = MODEL_MULTIPLIERS[model_tier] ?? MODEL_MULTIPLIERS.sonnet;
  const full_rate_tokens = token_usage.inputTokens + token_usage.outputTokens;
  const cached_tokens = token_usage.cacheReadInputTokens ?? 0;
  const standard_tokens = (full_rate_tokens * multiplier) + (cached_tokens * multiplier * 0.1);
  return Math.max(1, Math.ceil(standard_tokens));
}

export function calculate_turn_credit_reservation(
  model_tier: ModelTier,
  turn_limits: Pick<TurnLimits, "maxCreditsPerTurn" | "maxTokensInput" | "maxTokensOutput">,
): number {
  const token_ceiling = calculate_turn_credits(model_tier, {
    inputTokens: turn_limits.maxTokensInput,
    outputTokens: turn_limits.maxTokensOutput,
    cacheReadInputTokens: 0,
  });
  return Math.max(1, Math.ceil(Math.min(turn_limits.maxCreditsPerTurn, token_ceiling)));
}

export function fit_turn_limits_to_available_credits(
  model_tier: ModelTier,
  turn_limits: TurnLimits,
  available_credits: number,
): TurnLimits {
  const allowed_credits = Math.max(1, Math.floor(available_credits));
  const original_reservation = calculate_turn_credit_reservation(model_tier, turn_limits);
  if (original_reservation <= allowed_credits) {
    return turn_limits;
  }

  const base_token_ceiling = calculate_turn_credits(model_tier, {
    inputTokens: turn_limits.maxTokensInput,
    outputTokens: turn_limits.maxTokensOutput,
    cacheReadInputTokens: 0,
  });

  let fitted: TurnLimits = {
    ...turn_limits,
    maxCreditsPerTurn: Math.min(turn_limits.maxCreditsPerTurn, allowed_credits),
  };

  if (base_token_ceiling <= 0) {
    return fitted;
  }

  let scale = Math.min(1, Math.max(0.02, (allowed_credits - 0.5) / base_token_ceiling));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    fitted = {
      ...fitted,
      maxTokensInput: Math.max(2_000, Math.floor(turn_limits.maxTokensInput * scale)),
      maxTokensOutput: Math.max(1_000, Math.floor(turn_limits.maxTokensOutput * scale)),
    };
    const reservation = calculate_turn_credit_reservation(model_tier, fitted);
    if (reservation <= allowed_credits) {
      return fitted;
    }
    scale *= Math.max(0.1, (allowed_credits - 0.5) / reservation);
  }

  return fitted;
}

export type PauseCompanyCallback = (company_id: string) => void;

export class CreditManager {
  private on_pause_company?: PauseCompanyCallback;

  constructor(
    private readonly db: SupervisorDb,
    private readonly fetch_remote_balance?: CreditBalanceProvider,
  ) {}

  set_pause_callback(cb: PauseCompanyCallback): void {
    this.on_pause_company = cb;
  }

  get_balance(user_id: string): number {
    const row = this.get_balance_row(user_id);
    return Math.max(0, (row?.balance ?? 0) - this.get_total_reserved_balance(user_id));
  }

  get_total_balance(user_id: string): number {
    return this.get_balance_row(user_id)?.balance ?? 0;
  }

  get_reserved_balance(user_id: string): number {
    return this.get_total_reserved_balance(user_id);
  }

  get_company_reserved_balance(user_id: string, company_id: string): number {
    return this.get_company_reserved_balance_internal(user_id, company_id);
  }

  list_company_reservations(user_id: string): CompanyCreditReservation[] {
    return this.db.all<CompanyCreditReservation>(
      `
        SELECT
          cr.company_id,
          COALESCE(c.name, cr.company_id) AS company_name,
          COALESCE(c.state, 'failed') AS company_state,
          cr.reserved_balance
        FROM credit_reservations cr
        LEFT JOIN companies c ON c.id = cr.company_id
        WHERE cr.user_id = ?
          AND cr.reserved_balance > 0
        ORDER BY cr.reserved_balance DESC, company_name ASC
      `,
      [user_id],
    );
  }

  reserve_credits(user_id: string, amount: number, company_id?: string | null): boolean {
    if (amount <= 0) {
      return true;
    }

    const tx = this.db.transaction(() => {
      const row = this.get_balance_row(user_id);
      const balance = row?.balance ?? 0;
      const reserved = this.get_total_reserved_balance(user_id);
      const available = Math.max(0, balance - reserved);
      if (available < amount) {
        return false;
      }

      if (company_id) {
        const active_company_count = this.get_active_company_count(user_id);
        if (active_company_count > 1) {
          const company_reserved = this.get_company_reserved_balance_internal(user_id, company_id);
          const max_per_company = Math.max(1, Math.floor(balance / 2));
          if (company_reserved + amount > max_per_company) {
            return false;
          }
        }

        this.db.run(
          `
            INSERT INTO credit_reservations (user_id, company_id, reserved_balance, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, company_id) DO UPDATE SET
              reserved_balance = credit_reservations.reserved_balance + excluded.reserved_balance,
              updated_at = excluded.updated_at
          `,
          [user_id, company_id, amount, isoNow()],
        );
      }

      this.sync_reserved_balance(user_id);
      return true;
    });

    return tx();
  }

  release_reserved_credits(user_id: string, amount: number, company_id?: string | null): void {
    if (amount <= 0) return;
    const tx = this.db.transaction(() => {
      if (company_id) {
        const company_reserved = this.get_company_reserved_balance_internal(user_id, company_id);
        const next_company_reserved = Math.max(0, company_reserved - amount);
        if (next_company_reserved <= 0) {
          this.db.run(`DELETE FROM credit_reservations WHERE user_id = ? AND company_id = ?`, [user_id, company_id]);
        } else {
          this.db.run(
            `UPDATE credit_reservations SET reserved_balance = ?, updated_at = ? WHERE user_id = ? AND company_id = ?`,
            [next_company_reserved, isoNow(), user_id, company_id],
          );
        }
      }
      this.sync_reserved_balance(user_id);
    });
    tx();
  }

  release_all_reserved(user_id: string): void {
    this.db.run(`DELETE FROM credit_reservations WHERE user_id = ?`, [user_id]);
    this.db.run(
      `UPDATE credit_balances SET reserved_balance = 0, last_synced_at = ? WHERE user_id = ?`,
      [isoNow(), user_id],
    );
  }

  settle_reserved_credits(
    user_id: string,
    reserved_amount: number,
    actual_amount: number,
    context: CreditDeductionContext = {},
  ): number {
    const tx = this.db.transaction(() => {
      const row = this.get_balance_row(user_id);
      const current_balance = row?.balance ?? 0;
      const current_reserved = this.get_total_reserved_balance(user_id);
      const company_reserved = context.company_id
        ? this.get_company_reserved_balance_internal(user_id, context.company_id)
        : Math.max(0, reserved_amount);

      // Cap actual deduction at the reserved amount to prevent stealing from
      // other in-flight agents' available pool. Log if actual exceeds reserved.
      const capped_actual = Math.min(Math.max(0, actual_amount), Math.max(0, reserved_amount));
      if (actual_amount > reserved_amount) {
        console.warn(
          `[credits] Agent overspent reservation for user ${user_id}: actual=${actual_amount}, reserved=${reserved_amount}, capping to ${capped_actual}`,
        );
      }

      const actual_deduction = Math.min(capped_actual, current_balance);
      const release_amount = Math.min(Math.max(0, reserved_amount), company_reserved);
      const released_reserved = Math.max(0, current_reserved - release_amount);
      const next_balance = current_balance - actual_deduction;

      if (context.company_id) {
        const next_company_reserved = Math.max(0, company_reserved - release_amount);
        if (next_company_reserved <= 0) {
          this.db.run(`DELETE FROM credit_reservations WHERE user_id = ? AND company_id = ?`, [user_id, context.company_id]);
        } else {
          this.db.run(
            `UPDATE credit_reservations SET reserved_balance = ?, updated_at = ? WHERE user_id = ? AND company_id = ?`,
            [next_company_reserved, isoNow(), user_id, context.company_id],
          );
        }
      }

      this.db.run(
        `
          INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
          VALUES (?, ?, 0, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            balance = excluded.balance,
            last_synced_at = excluded.last_synced_at
        `,
        [user_id, next_balance, isoNow()],
      );
      this.sync_reserved_balance(user_id);

      if (actual_deduction > 0) {
        this.db.enqueue_sync("credit_deduction", user_id, "upsert", {
          amount: actual_deduction,
          company_id: context.company_id ?? null,
          agent_id: context.agent_id ?? null,
          model_tier: context.model_tier ?? null,
          description: context.description ?? "Supervisor turn deduction",
        });
      }

      if (next_balance <= 0) {
        this.pause_all_companies(user_id);
      }

      return actual_deduction;
    });

    return tx();
  }

  async init_company_credits(_company_id: string, user_id: string): Promise<void> {
    const remote_balance = this.fetch_remote_balance
      ? await this.fetch_remote_balance(user_id)
      : this.get_balance(user_id);

    // Account for un-synced local deductions that haven't been pushed to D1 yet.
    // Without this, a restart would "refund" credits that were spent locally but not synced.
    const pending_deductions = this.db.all<{ payload: string }>(
      `SELECT payload FROM sync_queue WHERE table_name = 'credit_deduction' AND record_id = ?`,
      [user_id],
    );
    const pending_total = pending_deductions.reduce((sum, row) => {
      try {
        const p = JSON.parse(row.payload) as { amount?: number };
        return sum + (p.amount ?? 0);
      } catch {
        return sum;
      }
    }, 0);
    const balance = Math.max(0, remote_balance - pending_total);

    this.db.run(
      `
        INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          balance = excluded.balance,
          reserved_balance = MIN(?, excluded.balance),
          last_synced_at = excluded.last_synced_at
      `,
      [user_id, balance, isoNow(), this.get_total_reserved_balance(user_id)],
    );
  }

  deduct_credits(user_id: string, amount: number, context: CreditDeductionContext = {}): number {
    const tx = this.db.transaction(() => {
      const row = this.get_balance_row(user_id);
      const current = row?.balance ?? 0;
      const reserved = this.get_total_reserved_balance(user_id);

      // Clamp: never go below 0
      const actual_deduction = Math.min(amount, Math.max(0, current));
      const nextBalance = current - actual_deduction;

      this.db.run(
        `
          INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
          VALUES (?, ?, 0, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            balance = excluded.balance,
            last_synced_at = excluded.last_synced_at
        `,
        [user_id, nextBalance, isoNow()],
      );
      this.sync_reserved_balance(user_id);

      // Only enqueue sync for the actual amount deducted (may be less than requested)
      if (actual_deduction > 0) {
        this.db.enqueue_sync("credit_deduction", user_id, "upsert", {
          amount: actual_deduction,
          company_id: context.company_id ?? null,
          agent_id: context.agent_id ?? null,
          model_tier: context.model_tier ?? null,
          description: context.description ?? "Supervisor turn deduction",
        });
      }

      if (nextBalance <= 0) {
        this.pause_all_companies(user_id);
      }

      return nextBalance;
    });

    return tx();
  }

  pause_all_companies(user_id: string): void {
    const companies = this.db.all<Pick<CompanyRow, "id">>(
      `SELECT id FROM companies WHERE user_id = ? AND state IN ('planning', 'running')`,
      [user_id],
    );

    // If the scheduler registered a pause callback, use it — it properly aborts
    // working agents and handles all status transitions
    if (this.on_pause_company) {
      for (const company of companies) {
        try {
          this.on_pause_company(company.id);
        } catch (err) {
          console.error(
            `[credits] Failed to pause company ${company.id} via callback:`,
            err instanceof Error ? err.message : err,
          );
          // Fallback: at least mark as paused in DB
          try {
            this.pause_company_db_only(company);
          } catch (dbErr) {
            console.error(
              `[credits] DB fallback pause also failed for company ${company.id}:`,
              dbErr instanceof Error ? dbErr.message : dbErr,
            );
          }
        }
      }
      return;
    }

    // Fallback: direct DB updates (no runner access to abort working agents)
    const tx = this.db.transaction(() => {
      for (const company of companies) {
        this.pause_company_db_only(company);
      }
    });

    tx();
  }

  private pause_company_db_only(company: Pick<CompanyRow, "id">): void {
    this.db.run(`UPDATE companies SET state = 'paused', updated_at = ? WHERE id = ?`, [
      isoNow(),
      company.id,
    ]);
    // Pause ALL non-terminal agents (not just idle — working ones too)
    this.db.run(
      `
        UPDATE agents
        SET status = 'paused'
        WHERE company_id = ?
          AND status NOT IN ('terminated', 'error')
      `,
      [company.id],
    );
    this.db.enqueue_sync("companies", company.id, "upsert", { state: "paused" });
    const pausedAgents = this.db.all<Pick<AgentRow, "id">>(
      `SELECT id FROM agents WHERE company_id = ? AND status = 'paused'`,
      [company.id],
    );
    for (const agent of pausedAgents) {
      this.db.enqueue_sync("agents", agent.id, "upsert", { status: "paused" });
    }
  }

  resume_paused_companies(user_id: string): string[] {
    const companies = this.db.all<Pick<CompanyRow, "id">>(
      `SELECT id FROM companies WHERE user_id = ? AND state = 'paused'`,
      [user_id],
    );

    const tx = this.db.transaction(() => {
      for (const company of companies) {
        const milestone_count = this.db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM milestones WHERE company_id = ?`,
          [company.id],
        )?.count ?? 0;
        const task_count = this.db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM tasks WHERE company_id = ?`,
          [company.id],
        )?.count ?? 0;
        const resumed_state = milestone_count === 0 && task_count === 0 ? "planning" : "running";

        this.db.run(`UPDATE companies SET state = ?, updated_at = ? WHERE id = ?`, [
          resumed_state,
          isoNow(),
          company.id,
        ]);
        this.db.run(
          `
            UPDATE agents
            SET status = 'idle'
            WHERE company_id = ?
              AND status = 'paused'
          `,
          [company.id],
        );
        this.db.enqueue_sync("companies", company.id, "upsert", { state: resumed_state });
        // Sync agent status transitions to D1
        const resumedAgents = this.db.all<Pick<AgentRow, "id">>(
          `SELECT id FROM agents WHERE company_id = ? AND status = 'idle'`,
          [company.id],
        );
        for (const agent of resumedAgents) {
          this.db.enqueue_sync("agents", agent.id, "upsert", { status: "idle" });
        }
      }
    });

    tx();
    return companies.map((company) => company.id);
  }

  apply_credit_purchase(user_id: string, amount: number): string[] {
    const tx = this.db.transaction(() => {
      const current = this.get_total_balance(user_id);
      const next_balance = current + amount;
      this.db.run(
        `
          INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
          VALUES (?, ?, 0, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            balance = excluded.balance,
            reserved_balance = MIN(?, excluded.balance),
            last_synced_at = excluded.last_synced_at
        `,
        [user_id, next_balance, isoNow(), this.get_total_reserved_balance(user_id)],
      );
    });
    tx();
    return this.resume_paused_companies(user_id);
  }

  private get_balance_row(user_id: string): { balance: number; reserved_balance: number } | undefined {
    return this.db.get<{ balance: number; reserved_balance: number }>(
      `SELECT balance, reserved_balance FROM credit_balances WHERE user_id = ?`,
      [user_id],
    );
  }

  private get_total_reserved_balance(user_id: string): number {
    return this.db.get<{ reserved: number }>(
      `SELECT COALESCE(SUM(reserved_balance), 0) AS reserved FROM credit_reservations WHERE user_id = ?`,
      [user_id],
    )?.reserved ?? 0;
  }

  private get_company_reserved_balance_internal(user_id: string, company_id: string): number {
    return this.db.get<{ reserved_balance: number }>(
      `SELECT reserved_balance FROM credit_reservations WHERE user_id = ? AND company_id = ?`,
      [user_id, company_id],
    )?.reserved_balance ?? 0;
  }

  private get_active_company_count(user_id: string): number {
    return this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM companies WHERE user_id = ? AND state IN ('planning', 'running')`,
      [user_id],
    )?.count ?? 0;
  }

  private sync_reserved_balance(user_id: string): void {
    const reserved = this.get_total_reserved_balance(user_id);
    this.db.run(
      `UPDATE credit_balances SET reserved_balance = ?, last_synced_at = ? WHERE user_id = ?`,
      [reserved, isoNow(), user_id],
    );
  }
}
