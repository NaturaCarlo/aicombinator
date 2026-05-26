/**
 * Local LLM proxy for Claude Code SDK.
 *
 * Claude Code SDK sends Anthropic-format requests (x-api-key auth, /v1/messages).
 * OpenRouter needs Authorization: Bearer and supports /api/v1/messages.
 *
 * This proxy runs on the supervisor (Hetzner), avoiding Cloudflare-to-Cloudflare
 * routing issues that make the worker unable to proxy to OpenRouter directly.
 */

import { Hono } from "hono";

export interface LlmProxyConfig {
  /** The internal API key that Claude Code SDK sends as x-api-key */
  internalApiKey: string;
  /** Worker API URL to fetch LLM provider config from */
  workerApiUrl: string;
  /** Optional OpenRouter API key for direct model-aware routing */
  openRouterApiKey?: string;
}

interface LlmProviderConfig {
  provider: "anthropic" | "openrouter";
  key: string;
}

let cachedConfig: LlmProviderConfig | null = null;

async function fetchProviderConfig(config: LlmProxyConfig): Promise<LlmProviderConfig> {
  if (cachedConfig) return cachedConfig;

  const res = await fetch(`${config.workerApiUrl}/api/supervisor/llm-config`, {
    headers: { "x-api-key": config.internalApiKey },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch LLM config: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as LlmProviderConfig;
  cachedConfig = data;
  console.log(`[llm-proxy] Fetched LLM config: provider=${data.provider}`);
  return data;
}

export function createLlmProxy(config: LlmProxyConfig): Hono {
  const app = new Hono();

  // Health check
  app.get("/llm-proxy/health", (c) => c.json({ ok: true }));

  // Catch-all: proxy Anthropic SDK requests to the real provider
  app.all("/llm-proxy/*", async (c) => {
    // Verify the internal API key
    const apiKey = c.req.header("x-api-key");
    if (!apiKey || apiKey !== config.internalApiKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const subpath = c.req.path.replace("/llm-proxy", "");

    let providerConfig: LlmProviderConfig;
    try {
      providerConfig = await fetchProviderConfig(config);
    } catch (err) {
      console.error("[llm-proxy] Failed to get provider config:", err);
      return c.json({ error: "LLM provider not configured" }, 500);
    }

    if (providerConfig.provider === "anthropic") {
      // Direct proxy to Anthropic — just swap the key
      const target = `https://api.anthropic.com${subpath}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(c.req.header())) {
        if (typeof v !== "string") continue;
        const lower = k.toLowerCase();
        if (lower === "host" || lower === "content-length") continue;
        headers.set(k, v);
      }
      headers.set("x-api-key", providerConfig.key);

      const upstream = await fetch(target, {
        method: c.req.method,
        headers,
        body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
        ...(c.req.method !== "GET" && c.req.method !== "HEAD" ? { duplex: "half" } : {}),
      } as RequestInit);

      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    }

    // OpenRouter: proxy to /api/v1/messages with Bearer auth
    if (providerConfig.provider === "openrouter") {
      const target = `https://openrouter.ai/api${subpath}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(c.req.header())) {
        if (typeof v !== "string") continue;
        const lower = k.toLowerCase();
        if (lower === "host" || lower === "content-length" || lower === "x-api-key") continue;
        headers.set(k, v);
      }
      headers.set("authorization", `Bearer ${providerConfig.key}`);
      headers.set("accept", "application/json");
      headers.set("http-referer", config.workerApiUrl);
      headers.set("x-title", "AI Combinator Supervisor");

      // Read and transform body: prefix model name with "anthropic/" if needed
      let body: string | null = null;
      if (c.req.method === "POST" && subpath === "/v1/messages") {
        const json = await c.req.json();
        if (typeof json.model === "string" && !json.model.includes("/")) {
          json.model = `anthropic/${json.model}`;
        }
        body = JSON.stringify(json);
      }

      const upstream = await fetch(target, {
        method: c.req.method,
        headers,
        body: body ?? (c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body),
        ...(c.req.method !== "GET" && c.req.method !== "HEAD" ? { duplex: "half" } : {}),
      } as RequestInit);

      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    }

    return c.json({ error: `Unknown provider: ${providerConfig.provider}` }, 500);
  });

  return app;
}

/** Clear cached config (e.g. if the key changes) */
export function clearLlmConfigCache(): void {
  cachedConfig = null;
}
