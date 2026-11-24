/**
 * Hash the edge-provided client address before using it as a limiter key.
 * The raw address is not logged or stored by this application.
 */
export async function allowRateLimitedRequest(
  limiter: RateLimit,
  request: Request,
  scope: string,
): Promise<boolean> {
  const address = request.headers.get("CF-Connecting-IP") || "local-development";
  return allowRateLimitedIdentity(limiter, scope, address);
}

/** Hash an identity before it becomes a Cloudflare Rate Limiting key. */
export async function allowRateLimitedIdentity(
  limiter: RateLimit,
  scope: string,
  identity: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  const key = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const { success } = await limiter.limit({ key: `${scope}:${key}` });
  return success;
}
