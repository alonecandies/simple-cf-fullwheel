export async function verifyTurnstile(
  token: string,
  secret: string,
  request: Request,
): Promise<boolean> {
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);

  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form, signal: AbortSignal.timeout(5_000) },
    );

    if (!response.ok) return false;
    const result = (await response.json()) as {
      success?: boolean;
      hostname?: string;
      action?: string;
    };
    const expectedHostname = new URL(request.url).hostname.toLowerCase();
    return (
      result.success === true &&
      result.hostname?.toLowerCase() === expectedHostname &&
      result.action === "guestbook-post"
    );
  } catch {
    return false;
  }
}
