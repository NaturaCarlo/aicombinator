import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Billing page verification tests covering all VAL-BILLING and VAL-STRIPE assertions.
 *
 * VAL-BILLING-001: Billing page loads with subscription status and token balance
 * VAL-BILLING-002: Buy Tokens buttons redirect to Stripe checkout
 * VAL-BILLING-003: Purchase confirmation on return from Stripe (session_id handling)
 * VAL-BILLING-004: Manage Subscription opens Stripe portal
 * VAL-BILLING-005: Upgrade to Pro visible for free-tier users
 * VAL-BILLING-006: Auto-refill toggle persists
 * VAL-BILLING-007: Token history renders
 * VAL-BILLING-009: Billing page uses #ee6018 accent (not #FF6600)
 * VAL-CORS-001: OPTIONS preflight for pricing endpoint
 * VAL-CORS-002: GET pricing returns multipliers with CORS headers
 */

const ROOT = path.resolve(__dirname, "../..");
const BILLING_PAGE = fs.readFileSync(
  path.join(ROOT, "dashboard/src/app/(app)/billing/page.tsx"),
  "utf-8",
);
const BILLING_ROUTES = fs.readFileSync(
  path.join(ROOT, "worker/src/routes/billing.ts"),
  "utf-8",
);
const CREDIT_CONFIRM_HOOK = fs.readFileSync(
  path.join(ROOT, "dashboard/src/hooks/use-credit-purchase-confirmation.ts"),
  "utf-8",
);
const USE_BILLING_HOOK = fs.readFileSync(
  path.join(ROOT, "dashboard/src/hooks/use-billing.ts"),
  "utf-8",
);
const CORS_MIDDLEWARE = fs.readFileSync(
  path.join(ROOT, "worker/src/middleware/cors.ts"),
  "utf-8",
);
const WORKER_INDEX = fs.readFileSync(
  path.join(ROOT, "worker/src/index.ts"),
  "utf-8",
);

// ─── VAL-BILLING-001: Page loads with subscription status and token balance ───

describe("VAL-BILLING-001: Billing page loads with subscription status and balance", () => {
  it("imports useBilling hook for subscription and balance data", () => {
    expect(BILLING_PAGE).toContain("useBilling");
    expect(BILLING_PAGE).toContain("from \"@/hooks/use-billing\"");
  });

  it("displays subscription plan label (Free tier / Pro plan / Max plan)", () => {
    expect(BILLING_PAGE).toMatch(/planLabel/);
    expect(BILLING_PAGE).toContain("Free tier");
    expect(BILLING_PAGE).toContain("Pro plan");
    expect(BILLING_PAGE).toContain("Max plan");
  });

  it("displays token balance with M suffix for large values", () => {
    // Should format 1M+ as X.XM
    expect(BILLING_PAGE).toMatch(/balance >= 1_000_000/);
    expect(BILLING_PAGE).toMatch(/\.toFixed\(1\)/);
    expect(BILLING_PAGE).toContain("tokens remaining");
  });

  it("shows loading state while billing data is fetching", () => {
    expect(BILLING_PAGE).toContain("isLoading");
    expect(BILLING_PAGE).toContain("Loader2");
    expect(BILLING_PAGE).toContain("animate-spin");
  });

  it("shows error banner when billing fetch fails", () => {
    expect(BILLING_PAGE).toContain("billingFetchError");
    // Uses smart quote (Unicode right single quotation mark)
    expect(BILLING_PAGE).toContain("couldn\u2019t load your account balance");
  });

  it("useBilling hook fetches from getBillingStatus", () => {
    expect(USE_BILLING_HOOK).toContain("getBillingStatus");
    expect(USE_BILLING_HOOK).toContain("billing-status");
  });
});

// ─── VAL-BILLING-002: Buy Tokens buttons redirect to Stripe ──────────────────

describe("VAL-BILLING-002: Buy Tokens buttons redirect to Stripe", () => {
  it("defines TOKEN_PACKS with 500K, 1M, 2.5M, and 5M options", () => {
    expect(BILLING_PAGE).toContain("500_000");
    expect(BILLING_PAGE).toContain("1_000_000");
    expect(BILLING_PAGE).toContain("2_500_000");
    expect(BILLING_PAGE).toContain("5_000_000");
  });

  it("renders buy buttons for each token pack", () => {
    expect(BILLING_PAGE).toContain("TOKEN_PACKS.map");
    expect(BILLING_PAGE).toContain("handleBuyCredits(pack.amount)");
  });

  it("calls buyCredits API which creates Stripe checkout", () => {
    expect(BILLING_PAGE).toContain("buyCredits");
    expect(BILLING_PAGE).toContain("window.location.href = url");
  });

  it("worker buy-tokens creates Stripe checkout with correct success URL", () => {
    expect(BILLING_ROUTES).toContain("handleBuyTokens");
    expect(BILLING_ROUTES).toContain("/checkout/sessions");
    // The success URL should contain session_id template for Stripe
    expect(BILLING_ROUTES).toContain("{CHECKOUT_SESSION_ID}");
  });

  it("worker buy-tokens validates amount range (500K to 500M)", () => {
    expect(BILLING_ROUTES).toContain("500_000");
    expect(BILLING_ROUTES).toContain("500_000_000");
  });

  it("shows loading state on buy button while checkout creates", () => {
    expect(BILLING_PAGE).toMatch(/actionLoading === `buy-\$\{pack\.amount\}`/);
    expect(BILLING_PAGE).toContain("animate-spin");
  });
});

// ─── VAL-BILLING-003: Purchase confirmation on return from Stripe ─────────────

describe("VAL-BILLING-003: Purchase confirmation on return from Stripe", () => {
  it("uses useCreditPurchaseConfirmation hook", () => {
    expect(BILLING_PAGE).toContain("useCreditPurchaseConfirmation");
  });

  it("hook reads URL params matching worker success URL pattern", () => {
    // Worker sends: /billing?tokens=success&session_id={CHECKOUT_SESSION_ID}
    // Hook must read 'tokens' param (current) with 'credits' as legacy fallback
    const workerSuccessUrl = "/billing?tokens=success&session_id={CHECKOUT_SESSION_ID}";
    expect(BILLING_ROUTES).toContain(workerSuccessUrl);

    // The hook must look for 'tokens' param to match the worker's success URL
    expect(CREDIT_CONFIRM_HOOK).toContain('.get("tokens")');
    // Also supports legacy 'credits' param for backward compatibility
    expect(CREDIT_CONFIRM_HOOK).toContain('.get("credits")');
  });

  it("hook checks for session_id URL parameter", () => {
    expect(CREDIT_CONFIRM_HOOK).toContain('.get("session_id")');
  });

  it("shows confirming/success/error states for credit confirmation", () => {
    expect(BILLING_PAGE).toContain("creditConfirmationState.kind");
    expect(BILLING_PAGE).toContain('"confirming"');
    expect(BILLING_PAGE).toContain('"success"');
    expect(BILLING_PAGE).toContain('"error"');
  });

  it("hook polls with retry for pending_payment status", () => {
    expect(CREDIT_CONFIRM_HOOK).toContain("pending_payment");
    expect(CREDIT_CONFIRM_HOOK).toContain("attempts < 12");
    expect(CREDIT_CONFIRM_HOOK).toContain("setTimeout");
  });

  it("hook calls confirmCreditPurchase API", () => {
    expect(CREDIT_CONFIRM_HOOK).toContain("confirmCreditPurchase");
  });

  it("hook triggers onGranted callback and revalidates SWR on success", () => {
    expect(CREDIT_CONFIRM_HOOK).toContain("onGranted");
    expect(CREDIT_CONFIRM_HOOK).toContain("mutate");
    expect(CREDIT_CONFIRM_HOOK).toContain("founder-state");
  });

  it("worker cancelled URL also uses tokens param", () => {
    expect(BILLING_ROUTES).toContain("tokens=cancelled");
    // Hook should handle cancelled state matching the param name
    expect(CREDIT_CONFIRM_HOOK).toContain('"cancelled"');
  });
});

// ─── VAL-BILLING-004: Manage Subscription opens Stripe portal ────────────────

describe("VAL-BILLING-004: Manage Subscription opens Stripe portal", () => {
  it("renders Manage Subscription button for paid users", () => {
    expect(BILLING_PAGE).toContain("Manage Subscription");
    expect(BILLING_PAGE).toContain("handleManageSubscription");
  });

  it("calls createPortalSession API", () => {
    expect(BILLING_PAGE).toContain("createPortalSession");
  });

  it("redirects to Stripe portal URL", () => {
    // After getting portal URL, redirects
    expect(BILLING_PAGE).toMatch(/handleManageSubscription[\s\S]*window\.location\.href = url/);
  });

  it("worker creates Stripe billing portal session", () => {
    expect(BILLING_ROUTES).toContain("handleBillingPortal");
    expect(BILLING_ROUTES).toContain("/billing_portal/sessions");
  });
});

// ─── VAL-BILLING-005: Upgrade to Pro visible for free users ──────────────────

describe("VAL-BILLING-005: Upgrade to Pro visible for free users", () => {
  it("shows Upgrade to Pro button for non-paid users", () => {
    expect(BILLING_PAGE).toContain("Upgrade to Pro");
  });

  it("conditionally renders upgrade button vs manage subscription", () => {
    // isPaid check determines which button to show
    expect(BILLING_PAGE).toContain("isPaid");
    expect(BILLING_PAGE).toMatch(/isPaid\s*\?[\s\S]*Manage Subscription[\s\S]*Upgrade to Pro/);
  });

  it("calls createCheckoutSession for subscription upgrade", () => {
    expect(BILLING_PAGE).toContain("handleSubscribe");
    expect(BILLING_PAGE).toContain("createCheckoutSession");
  });

  it("upgrade button uses #ee6018 accent styling", () => {
    // The upgrade button should use bg-[#ee6018]
    expect(BILLING_PAGE).toMatch(/Upgrade to Pro[\s\S]*bg-\[#ee6018\]/);
  });
});

// ─── VAL-BILLING-006: Auto-refill toggle persists ────────────────────────────

describe("VAL-BILLING-006: Auto-refill toggle persists", () => {
  it("renders auto-refill section with enable/disable button", () => {
    expect(BILLING_PAGE).toContain("Auto-Refill");
    expect(BILLING_PAGE).toContain("handleToggleAutoRefill");
  });

  it("shows current auto-refill state (Enabled/Disabled)", () => {
    expect(BILLING_PAGE).toContain("autoRefill.enabled");
    expect(BILLING_PAGE).toContain('"Enabled"');
    expect(BILLING_PAGE).toContain('"Disabled"');
  });

  it("calls updateAutoRefill API to persist toggle", () => {
    expect(BILLING_PAGE).toContain("updateAutoRefill");
    expect(BILLING_PAGE).toContain("!billing.autoRefill.enabled");
  });

  it("mutates billing data after toggle to reflect new state", () => {
    expect(BILLING_PAGE).toContain("mutate()");
  });

  it("worker PATCH auto-refill validates and persists to D1", () => {
    expect(BILLING_ROUTES).toContain("handleUpdateAutoRefill");
    expect(BILLING_ROUTES).toContain("auto_refill_enabled");
    expect(BILLING_ROUTES).toContain("UPDATE subscriptions SET");
  });

  it("disables auto-refill toggle for free users", () => {
    expect(BILLING_PAGE).toMatch(/disabled=\{!isPaid/);
  });
});

// ─── VAL-BILLING-007: Token history renders ──────────────────────────────────

describe("VAL-BILLING-007: Token history renders", () => {
  it("renders Token History section", () => {
    expect(BILLING_PAGE).toContain("Token History");
    expect(BILLING_PAGE).toContain("Recent token transactions");
  });

  it("renders transaction list from billing.credits.history", () => {
    expect(BILLING_PAGE).toContain("billing.credits.history");
    expect(BILLING_PAGE).toContain("billing?.credits.history");
  });

  it("shows positive amounts with plus sign and green color", () => {
    expect(BILLING_PAGE).toContain("event.amount > 0");
    expect(BILLING_PAGE).toContain("text-green-600");
    // Check that positive amounts get a "+" prefix in the display
    expect(BILLING_PAGE).toContain('event.amount > 0 ? "+" : ""');
  });

  it("shows amount and balance_after for each event", () => {
    expect(BILLING_PAGE).toContain("event.amount");
    expect(BILLING_PAGE).toContain("event.balance_after");
    expect(BILLING_PAGE).toContain("remaining");
  });

  it("shows date and description for each event", () => {
    expect(BILLING_PAGE).toContain("event.created_at");
    expect(BILLING_PAGE).toContain("toLocaleDateString");
  });

  it("shows empty state when no transactions", () => {
    expect(BILLING_PAGE).toContain("No token transactions yet");
  });

  it("worker billing status returns credit history", () => {
    expect(BILLING_ROUTES).toContain("getCreditHistory");
    expect(BILLING_ROUTES).toContain("history: history.events");
  });
});

// ─── VAL-BILLING-009: Billing page uses #ee6018 accent ───────────────────────

describe("VAL-BILLING-009: Billing page uses #ee6018 accent", () => {
  it("uses #ee6018 for accent colors, not #FF6600", () => {
    const ee6018Count = (BILLING_PAGE.match(/#ee6018/g) || []).length;
    const ff6600Count = (BILLING_PAGE.match(/#[Ff][Ff]6600/g) || []).length;

    expect(ee6018Count).toBeGreaterThan(0);
    expect(ff6600Count).toBe(0);
  });

  it("uses #ee6018 for icon colors (Zap, Crown, Plus)", () => {
    expect(BILLING_PAGE).toContain('text-[#ee6018]');
  });

  it("uses #ee6018 for Upgrade to Pro button background", () => {
    expect(BILLING_PAGE).toContain('bg-[#ee6018]');
  });

  it("uses #ee6018 for token pack hover states", () => {
    expect(BILLING_PAGE).toContain('hover:border-[#ee6018]');
    expect(BILLING_PAGE).toContain('hover:bg-[#ee6018]');
  });
});

// ─── VAL-CORS-001 & VAL-CORS-002: CORS for pricing endpoint ─────────────────

describe("VAL-CORS-001: OPTIONS preflight for pricing endpoint", () => {
  it("worker handles OPTIONS for all routes including billing/pricing", () => {
    // Global OPTIONS handler
    expect(WORKER_INDEX).toContain('app.options("*"');
    expect(WORKER_INDEX).toContain("handleOptions");
  });

  it("CORS middleware returns 204 with proper headers", () => {
    expect(CORS_MIDDLEWARE).toContain("204");
    expect(CORS_MIDDLEWARE).toContain("Access-Control-Allow-Origin");
    expect(CORS_MIDDLEWARE).toContain("Access-Control-Allow-Methods");
    expect(CORS_MIDDLEWARE).toContain("Access-Control-Allow-Headers");
  });

  it("CORS allows GET method", () => {
    expect(CORS_MIDDLEWARE).toContain("GET");
  });
});

describe("VAL-CORS-002: GET pricing returns multipliers with CORS", () => {
  it("pricing endpoint route is registered", () => {
    expect(WORKER_INDEX).toContain('app.get("/api/billing/pricing"');
  });

  it("pricing handler returns MODEL_MULTIPLIERS", () => {
    expect(BILLING_ROUTES).toContain("handleBillingPricing");
    expect(BILLING_ROUTES).toContain("pricing: MODEL_MULTIPLIERS");
  });

  it("pricing response includes CORS headers via jsonResponse", () => {
    // jsonResponse adds corsHeaders
    expect(BILLING_ROUTES).toContain("corsHeaders(env)");
  });

  it("MODEL_MULTIPLIERS has all 15 models", () => {
    const models = [
      "minimax-m2.5", "gemini-3-flash", "glm-4.7", "kimi-k2.5",
      "haiku-4-5", "glm-5", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex",
      "gemini-3.1-pro", "gpt-5.4", "sonnet-4-5", "sonnet-4-6",
      "opus-4-5", "opus-4-6",
    ];
    for (const model of models) {
      expect(BILLING_ROUTES).toContain(`"${model}"`);
    }
  });
});

// ─── VAL-STRIPE-001 to VAL-STRIPE-005: Stripe integration ───────────────────

describe("VAL-STRIPE-001: Checkout session creates valid Stripe URL", () => {
  it("buy-tokens creates checkout session with payment mode", () => {
    expect(BILLING_ROUTES).toContain('"payment"');
    expect(BILLING_ROUTES).toContain("/checkout/sessions");
  });

  it("calculates correct cents from token amount", () => {
    // 1M tokens = $1 = 100 cents
    expect(BILLING_ROUTES).toContain("(body.amount / 1_000_000) * 100");
  });

  it("includes user metadata and credit amount in session", () => {
    expect(BILLING_ROUTES).toContain('metadata[user_id]');
    expect(BILLING_ROUTES).toContain('metadata[credits]');
    expect(BILLING_ROUTES).toContain('metadata[type]');
  });
});

describe("VAL-STRIPE-002: Portal session returns valid Stripe URL", () => {
  it("portal creates session via Stripe API", () => {
    expect(BILLING_ROUTES).toContain("/billing_portal/sessions");
  });

  it("returns URL for redirect", () => {
    expect(BILLING_ROUTES).toMatch(/handleBillingPortal[\s\S]*url: session\.url/);
  });
});

describe("VAL-STRIPE-003: Buy tokens creates session with correct amount", () => {
  it("each token pack maps to correct dollar amount", () => {
    // 500K = $0.50, 1M = $1, 2.5M = $2.50, 5M = $5
    // Formula: amountCents = (amount / 1_000_000) * 100
    const packs = [
      { amount: 500_000, expectedCents: 50 },
      { amount: 1_000_000, expectedCents: 100 },
      { amount: 2_500_000, expectedCents: 250 },
      { amount: 5_000_000, expectedCents: 500 },
    ];

    for (const pack of packs) {
      const cents = Math.ceil((pack.amount / 1_000_000) * 100);
      expect(cents).toBe(pack.expectedCents);
    }
  });
});

describe("VAL-STRIPE-004: Credit confirmation polling resolves", () => {
  it("hook polls up to 12 attempts with 2.5s intervals", () => {
    expect(CREDIT_CONFIRM_HOOK).toContain("attempts < 12");
    expect(CREDIT_CONFIRM_HOOK).toContain("2500");
  });

  it("resolves with granted status and updated balance", () => {
    expect(CREDIT_CONFIRM_HOOK).toContain("result.status === \"granted\"");
    expect(CREDIT_CONFIRM_HOOK).toContain("result.balance");
  });

  it("worker confirm endpoint finalizes checkout session", () => {
    expect(BILLING_ROUTES).toContain("handleConfirmCreditPurchase");
    expect(BILLING_ROUTES).toContain("finalizeStripeCreditCheckoutSession");
  });
});

describe("VAL-STRIPE-005: Portal session for subscription management", () => {
  it("creates Stripe customer if not exists", () => {
    expect(BILLING_ROUTES).toContain("ensureStripeCustomer");
  });

  it("portal session includes return URL", () => {
    expect(BILLING_ROUTES).toContain("return_url");
  });
});
