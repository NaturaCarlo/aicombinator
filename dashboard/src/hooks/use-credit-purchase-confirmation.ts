"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { confirmCreditPurchase } from "@/lib/api";

export type CreditConfirmationState = {
  kind: "idle" | "confirming" | "success" | "error";
  message: string | null;
};

export function useCreditPurchaseConfirmation({
  successPath,
  onGranted,
}: {
  successPath: string;
  onGranted?: () => Promise<unknown> | unknown;
}) {
  const { getToken } = useAuth();
  const router = useRouter();
  const [state, setState] = useState<CreditConfirmationState>({
    kind: "idle",
    message: null,
  });
  const query =
    typeof window === "undefined"
      ? { creditsFlow: null, checkoutSessionId: null }
      : (() => {
          const params = new URLSearchParams(window.location.search);
          // Support both "tokens" (current) and "credits" (legacy) URL params
          const flow = params.get("tokens") ?? params.get("credits");
          return {
            creditsFlow: flow,
            checkoutSessionId: params.get("session_id"),
          };
        })();
  const { creditsFlow, checkoutSessionId } = query;
  const shouldConfirmCredits = creditsFlow === "success" && !!checkoutSessionId;

  useEffect(() => {
    if (creditsFlow === "cancelled") {
      router.replace(successPath);
    }
  }, [creditsFlow, router, successPath]);

  useEffect(() => {
    if (!shouldConfirmCredits || !checkoutSessionId) {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const confirm = async () => {
      attempts += 1;
      setState({
        kind: "confirming",
        message: "Confirming your payment and applying tokens...",
      });

      try {
        const token = await getToken();
        if (!token || cancelled) return;

        const result = await confirmCreditPurchase(checkoutSessionId, token);
        if (cancelled) return;

        if (result.status === "pending_payment" && attempts < 12) {
          timer = setTimeout(confirm, 2500);
          return;
        }

        if (result.status === "granted") {
          await onGranted?.();
          // Revalidate all founderState SWR keys so token balance updates across all pages
          await mutate(
            (key) =>
              typeof key === "string" && key.includes("/founder-state"),
          );
          setState({
            kind: "success",
            message: `Tokens added. New balance: ${result.balance >= 1_000_000 ? `${(result.balance / 1_000_000).toFixed(1)}M` : result.balance.toLocaleString()}.`,
          });
          router.replace(successPath);
          return;
        }

        setState({
          kind: "error",
          message: "Payment is still pending or could not be confirmed. Please refresh in a few seconds.",
        });
      } catch (error) {
        if (cancelled) return;

        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "We couldn’t confirm the payment yet. Please refresh in a few seconds.",
        });
      }
    };

    void confirm();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [checkoutSessionId, getToken, onGranted, router, shouldConfirmCredits, successPath]);

  if (creditsFlow === "cancelled") {
    return {
      kind: "error",
      message: "Token purchase cancelled.",
    };
  }

  return state;
}
