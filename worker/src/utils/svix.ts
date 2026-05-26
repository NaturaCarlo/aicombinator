/**
 * Verify a Svix webhook signature using the Web Crypto API.
 *
 * Svix signs webhooks with HMAC-SHA256. The secret is base64-encoded
 * and prefixed with "whsec_". The signed content is "${msg_id}.${timestamp}.${body}".
 * The signature header may contain multiple space-separated versioned signatures
 * like "v1,<base64>". We check if any v1 signature matches.
 */
export async function verifySvixSignature(
  body: string,
  msgId: string,
  timestamp: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  const secretBytes = Uint8Array.from(
    atob(secret.replace(/^whsec_/, "")),
    (c) => c.charCodeAt(0),
  );

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signedContent = `${msgId}.${timestamp}.${body}`;
  const encoder = new TextEncoder();
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedContent),
  );

  const computed = btoa(
    String.fromCharCode(...new Uint8Array(signatureBytes)),
  );

  const signatures = signatureHeader.split(" ");
  for (const sig of signatures) {
    const [version, value] = sig.split(",", 2);
    if (version === "v1" && value === computed) {
      return true;
    }
  }

  return false;
}
