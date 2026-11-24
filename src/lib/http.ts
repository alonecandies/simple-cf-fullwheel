export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function secureResponse(response: Response, requestUrl: URL): Response {
  if (response.status === 101) return response;

  const headers = new Headers(response.headers);
  const websocketOrigin = `${requestUrl.protocol === "https:" ? "wss:" : "ws:"}//${requestUrl.host}`;
  headers.set(
    "Content-Security-Policy",
    headers.get("Content-Security-Policy") ||
      [
        "default-src 'self'",
        "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
        "style-src 'self'",
        "img-src 'self' data:",
        `connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com ${websocketOrigin}`,
        "frame-src https://challenges.cloudflare.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (requestUrl.protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
