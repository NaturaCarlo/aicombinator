"use client";

import { useEffect, useEffectEvent, useRef, useCallback, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { connectStatusStream } from "@/lib/api";
import type { RealtimeEvent } from "@/lib/types";

/**
 * Hook for real-time company status updates via Server-Sent Events.
 *
 * Connects to the SSE endpoint and dispatches events to the handler.
 * Automatically reconnects on disconnect with exponential backoff.
 */
export function useRealtimeStatus(
  companyId: string | null,
  onEvent: (event: RealtimeEvent) => void,
) {
  const { getToken } = useAuth();
  const handleEvent = useEffectEvent(onEvent);
  const sourceRef = useRef<EventSource | null>(null);
  const [connected, setConnected] = useState(false);

  const cleanup = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    setConnected(false);
  }, []);

  useEffect(() => {
    if (!companyId) {
      return;
    }

    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;

      try {
        const token = await getToken();
        if (!token || cancelled) return;

        const source = connectStatusStream(companyId, token);
        sourceRef.current = source;

        source.onopen = () => {
          if (cancelled) return;
          setConnected(true);
        };

        source.onmessage = (e) => {
          if (cancelled) return;
          try {
            const event = JSON.parse(e.data) as RealtimeEvent;
            handleEvent(event);
          } catch {
            // Ignore parse errors (e.g. heartbeat pings)
          }
        };

        source.onerror = () => {
          if (cancelled) return;
          setConnected(false);
          // EventSource handles retry/reconnect for us. We only surface the
          // disconnected state so the UI can stay honest.
        };
      } catch {
        if (cancelled) return;
        setConnected(false);
        window.setTimeout(connect, 1000);
      }
    };

    connect();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [companyId, getToken, cleanup]);

  return { connected };
}
