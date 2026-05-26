import nextWorker from "./.open-next/worker.js";

const ROOT_DOMAIN = "aicombinator.live";
const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "clerk",
  "supervisor",
]);

type WorkerEnv = {
  ASSETS?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  };
  API_SERVICE?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  };
};

type WorkerModule = {
  fetch(request: Request, env: WorkerEnv, ctx: { waitUntil?(promise: Promise<unknown>): void }): Promise<Response>;
};

function buildHostedNotFoundResponse(hostname: string, path: string, status = 404): Response {
  const safeHost = hostname.replace(/[<>&"]/g, "");
  const safePath = path.replace(/[<>&"]/g, "");
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Company page not found</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f6f2eb;
        color: #181818;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        max-width: 520px;
        padding: 32px;
        border: 1px solid #e6d7bf;
        border-radius: 28px;
        background: #fffdf8;
        box-shadow: 0 16px 40px rgba(24, 24, 24, 0.06);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 32px;
        line-height: 1.05;
      }
      p {
        margin: 0;
        font-size: 18px;
        line-height: 1.5;
        color: #5f5b53;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.95em;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Company page not found</h1>
      <p><code>${safeHost}${safePath}</code> is not currently serving a hosted company page.</p>
    </main>
  </body>
</html>`;

  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "x-aic-hosted-fallback": String(status),
    },
  });
}

function resolveRequestHostname(request: Request): string | null {
  const hostHeader =
    request.headers.get("x-forwarded-host")
    || request.headers.get("host");
  if (!hostHeader) {
    return null;
  }

  return hostHeader.split(":")[0].toLowerCase();
}

function resolveHostedCompanySlug(request: Request): string | null {
  const hostname = resolveRequestHostname(request);
  if (!hostname) {
    return null;
  }

  if (!hostname.endsWith(`.${ROOT_DOMAIN}`)) {
    return null;
  }

  const subdomain = hostname.slice(0, -(`.${ROOT_DOMAIN}`.length));
  if (!subdomain || RESERVED_SUBDOMAINS.has(subdomain)) {
    return null;
  }

  return subdomain;
}

function resolveCustomCompanyHost(request: Request): string | null {
  const hostname = resolveRequestHostname(request);
  if (!hostname) {
    return null;
  }

  if (hostname === ROOT_DOMAIN || hostname === `www.${ROOT_DOMAIN}`) {
    return null;
  }

  if (hostname.endsWith(`.${ROOT_DOMAIN}`)) {
    return null;
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return null;
  }

  return hostname;
}

function isCompanyAssetPassthrough(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/")
    || pathname.startsWith("/cdn-cgi/")
    || pathname.startsWith("/api/")
  );
}

async function fetchHostedCompanyResponse(
  request: Request,
  env: WorkerEnv,
  target: { slug?: string; host?: string },
): Promise<{ response: Response | null; upstreamStatus: number | null }> {
  const url = new URL(request.url);
  if (isCompanyAssetPassthrough(url.pathname)) {
    return { response: null, upstreamStatus: null };
  }

  const requestedPath = url.pathname === "/"
    ? "index.html"
    : url.pathname.replace(/^\/+/, "");
  const upstreamCandidates = target.host
    ? [
      `https://internal/api/public/file?host=${encodeURIComponent(target.host)}&path=${encodeURIComponent(requestedPath)}`,
      ...(target.slug
        ? [`https://internal/api/public/${target.slug}/file?path=${encodeURIComponent(requestedPath)}`]
        : []),
    ]
    : target.slug
      ? [`https://internal/api/public/${target.slug}/file?path=${encodeURIComponent(requestedPath)}`]
      : [];

  let upstream: Response | null = null;
  let upstreamStatus: number | null = null;

  for (const upstreamUrl of upstreamCandidates) {
    const upstreamRequest = new Request(upstreamUrl, {
      method: "GET",
      headers: {
        Accept: request.headers.get("accept") || "*/*",
      },
    });
    const candidate = env.API_SERVICE
      ? await env.API_SERVICE.fetch(upstreamRequest)
      : await fetch(upstreamRequest);
    upstreamStatus = candidate.status;
    if (candidate.ok) {
      upstream = candidate;
      break;
    }
    if (candidate.status !== 404) {
      upstream = candidate;
      break;
    }
  }

  if (!upstream || !upstream.ok) {
    return { response: null, upstreamStatus };
  }

  const headers = new Headers(upstream.headers);
  headers.set("Cache-Control", "no-store");

  if (request.method === "HEAD") {
    return {
      response: new Response(null, {
        status: upstream.status,
        headers,
      }),
      upstreamStatus: upstream.status,
    };
  }

  return {
    response: new Response(upstream.body, {
      status: upstream.status,
      headers,
    }),
    upstreamStatus: upstream.status,
  };
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: { waitUntil?(promise: Promise<unknown>): void },
  ): Promise<Response> {
    const slug = resolveHostedCompanySlug(request);
    const customHost = slug ? null : resolveCustomCompanyHost(request);
    let upstreamStatus: number | null = null;
    if (slug || customHost) {
      const url = new URL(request.url);

      // Try VM-hosted app first — route through API service binding
      // which has access to the supervisor's tunnel URL via KV
      if (env.API_SERVICE && !isCompanyAssetPassthrough(url.pathname)) {
        try {
          const originalHost = resolveRequestHostname(request) || url.hostname;
          const proxyRequest = new Request(
            `https://internal/api/hosting-proxy${url.pathname}${url.search}`,
            {
              method: request.method,
              headers: {
                "x-hosting-host": originalHost,
                Accept: request.headers.get("accept") || "*/*",
              },
              body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
            },
          );
          const vmResponse = await env.API_SERVICE.fetch(proxyRequest);
          // If the proxy returned a valid response (not 502/503/404), use it
          if (vmResponse.status !== 502 && vmResponse.status !== 503 && vmResponse.status !== 404) {
            return vmResponse;
          }
        } catch {
          // Proxy unavailable — fall through to KV-based hosting
        }
      }

      // Fall back to KV-based static file hosting
      // For subdomains, pass both slug and host so the API can resolve by hosted_domain when slug doesn't match
      const hostedHost = slug ? `${slug}.${ROOT_DOMAIN}` : (customHost || undefined);
      const hosted = await fetchHostedCompanyResponse(
        request,
        env,
        slug ? { slug, host: hostedHost } : { host: customHost || undefined },
      );
      const hostedResponse = hosted.response;
      if (hostedResponse) {
        return hostedResponse;
      }
      upstreamStatus = hosted.upstreamStatus;
      if (upstreamStatus === 404) {
        const hostname = resolveRequestHostname(request) || url.hostname;
        return buildHostedNotFoundResponse(hostname, url.pathname, upstreamStatus);
      }
    }

    const response = await (nextWorker as WorkerModule).fetch(request, env, ctx);
    if ((slug || customHost) && upstreamStatus !== null) {
      response.headers.set("x-aic-hosted-fallback", String(upstreamStatus));
    }
    return response;
  },
};
