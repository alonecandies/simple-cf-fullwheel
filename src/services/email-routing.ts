import PostalMime, { type Email } from "postal-mime";
import { errorType } from "../lib/logging";
import { MAX_INBOUND_EMAIL_BYTES, MAX_STORED_MESSAGES } from "../lib/limits";
import { allowRateLimitedIdentity } from "./rate-limit";
import type { Environment } from "../types";

const MIME_MAX_PARTS = 32;
const MIME_MAX_NESTING = 8;
const MESSAGE_NAME = "Email visitor";

function reject(message: ForwardableEmailMessage, reason: string): void {
  message.setReject(reason);
}

function hasPassingDmarc(message: ForwardableEmailMessage): boolean {
  const authenticationResult = message.headers.get("Authentication-Results") || "";
  const trustedResult = authenticationResult.match(
    /^\s*mx\.cloudflare\.net\s*;([^,\r\n]*)/i,
  )?.[1];
  return Boolean(trustedResult && /\bdmarc=pass\b/i.test(trustedResult));
}

function normalizedPlainText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function handleRoutedGuestbookEmail(
  incoming: ForwardableEmailMessage,
  env: Environment,
): Promise<void> {
  if (
    env.EMAIL_ROUTING_ENABLED !== "true" ||
    !env.EMAIL_ROUTING_ADDRESS ||
    !env.EMAIL_ROUTING_ADDRESS.includes("@")
  ) {
    reject(incoming, "Guestbook email submissions are not configured.");
    return;
  }

  if (incoming.to.trim().toLowerCase() !== env.EMAIL_ROUTING_ADDRESS.trim().toLowerCase()) {
    reject(incoming, "This address does not accept guestbook notes.");
    return;
  }
  if (incoming.rawSize > MAX_INBOUND_EMAIL_BYTES) {
    reject(incoming, "Email notes must be 64 KB or smaller.");
    return;
  }
  if (!hasPassingDmarc(incoming)) {
    reject(incoming, "The sender could not be authenticated.");
    return;
  }

  let parsed: Email;
  try {
    parsed = await PostalMime.parse(incoming.raw, {
      maxNestingDepth: MIME_MAX_NESTING,
      maxPartCount: MIME_MAX_PARTS,
      maxHeadersSize: 16 * 1024,
      maxRfc822NestingDepth: 0,
    });
  } catch {
    reject(incoming, "The email format is not supported.");
    return;
  }

  if (parsed.attachments.length > 0 || !parsed.text) {
    reject(incoming, "Send a plain-text note without attachments.");
    return;
  }

  const from = parsed.from;
  if (!from || "group" in from) {
    reject(incoming, "A single authenticated sender is required.");
    return;
  }
  const sender = from.address.trim().toLowerCase();
  if (sender.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
    reject(incoming, "A valid sender address is required.");
    return;
  }

  try {
    const allowed = await allowRateLimitedIdentity(
      env.PUBLIC_API_RATE_LIMITER,
      "guestbook-email",
      sender,
    );
    if (!allowed) {
      reject(incoming, "Please wait before sending another note.");
      return;
    }
  } catch (error) {
    console.error("Could not check the email submission rate limit", errorType(error));
    throw new Error("Email submission rate limiting is unavailable");
  }

  const note = normalizedPlainText(parsed.text);
  if (note.length < 3 || note.length > 240) {
    reject(incoming, "Email notes must be between 3 and 240 characters.");
    return;
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const insert = await env.DB.prepare(
    "INSERT INTO messages (id, name, message, created_at, status, image_key) SELECT ?, ?, ?, ?, 'pending', NULL WHERE (SELECT COUNT(*) FROM messages) < ?",
  )
    .bind(id, MESSAGE_NAME, note, createdAt, MAX_STORED_MESSAGES)
    .run();
  if (insert.meta.changes !== 1) {
    reject(incoming, "The guestbook has reached its note storage limit.");
    return;
  }

  try {
    await env.MODERATION_QUEUE.send({ messageId: id });
  } catch (error) {
    await env.DB.prepare("DELETE FROM messages WHERE id = ? AND status = 'pending'")
      .bind(id)
      .run()
      .catch((cleanupError: unknown) =>
        console.error("Could not remove an unqueued email note", errorType(cleanupError)),
      );
    console.error("Could not queue an email note", errorType(error));
    throw new Error("Email note processing is temporarily unavailable");
  }
}
