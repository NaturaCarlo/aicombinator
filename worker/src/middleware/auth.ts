import type { Env } from "../types.js";

interface JwtPayload {
  sub: string;
  iss: string;
  exp: number;
  iat: number;
  [key: string]: unknown;
}

/**
 * Verify a Clerk JWT using the JWKS endpoint.
 * Returns the userId (sub claim) on success, null on failure.
 */
export async function verifyClerkJwt(
  token: string,
  env: Env,
): Promise<string | null> {
  try {
    // Decode the JWT header to get the key ID
    const [headerB64] = token.split(".");
    const header = JSON.parse(atob(headerB64.replace(/-/g, "+").replace(/_/g, "/")));
    const kid = header.kid;
    if (!kid) return null;

    // Fetch JWKS (cached in KV for 1 hour)
    // Extract the issuer from the token and validate it matches Clerk's domain
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(
      atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")),
    );
    const issuer = payload.iss as string;
    if (!issuer) return null;

    // Validate issuer matches Clerk's known domain patterns to prevent JWKS URL injection
    // Supports both default Clerk domains (*.clerk.accounts.dev) and custom domains (e.g. clerk.aicombinator.live)
    const CLERK_ISSUER_PATTERN = /^https:\/\/[a-zA-Z0-9-]+\.clerk\.accounts\.dev$|^https:\/\/clerk\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}$/;
    if (!CLERK_ISSUER_PATTERN.test(issuer)) {
      console.error("JWT issuer does not match Clerk pattern:", issuer);
      return null;
    }

    // Include issuer in cache key to prevent cache poisoning across Clerk instances
    const cacheKey = `clerk_jwks:${issuer}`;
    let jwksRaw = await env.AUTOMATON_KV.get(cacheKey);
    if (!jwksRaw) {
      const jwksUrl = `${issuer}/.well-known/jwks.json`;
      const res = await fetch(jwksUrl);
      if (!res.ok) return null;
      jwksRaw = await res.text();
      await env.AUTOMATON_KV.put(cacheKey, jwksRaw, { expirationTtl: 3600 });
    }

    const jwks = JSON.parse(jwksRaw);
    const jwk = jwks.keys?.find((k: { kid: string }) => k.kid === kid);
    if (!jwk) return null;

    // Import the key and verify
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const [hdr, pld, sig] = token.split(".");
    const data = new TextEncoder().encode(`${hdr}.${pld}`);
    const signature = Uint8Array.from(
      atob(sig.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      data,
    );

    if (!valid) return null;

    // Decode payload and check expiry
    const decoded = JSON.parse(
      atob(pld.replace(/-/g, "+").replace(/_/g, "/")),
    ) as JwtPayload;

    if (decoded.exp && decoded.exp < Date.now() / 1000) return null;

    return decoded.sub;
  } catch (err) {
    console.error("JWT verification error:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Extract Bearer token from Authorization header.
 */
export function extractToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}
