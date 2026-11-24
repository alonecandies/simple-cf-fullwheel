import { isUuidV4 } from "../lib/ids";
import { errorType } from "../lib/logging";
import type { ModerationJob } from "../types";

interface ModeratorEnvironment {
  DB: D1Database;
  MODERATION_QUEUE: Queue<ModerationJob>;
  PHOTOS: R2Bucket;
}

interface PendingReview {
  id: string;
  name: string;
  message: string;
  created_at: string;
  image_key: string | null;
  action_pending: number;
}

const MAX_FORM_BYTES = 2_048;
const MAX_MODERATOR_EMAIL_LENGTH = 320;
const APPROVED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function responseHeaders(nonce: string): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      "img-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
    "Content-Type": "text/html; charset=utf-8",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}

function renderPage(
  moderatorEmail: string,
  notes: PendingReview[],
  notice: string,
): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const noticeText: Record<string, string> = {
    queued: "Decision queued. The note will update after the workflow finishes.",
    conflict: "That note is no longer pending, or another decision is already queued.",
    failed: "The decision could not be queued. The note has not been changed.",
  };
  const cards = notes.map((note) => {
    const image = note.image_key
      ? `<img class="note-photo" src="/photo?id=${encodeURIComponent(note.id)}" alt="Photo attached to this note">`
      : "";
    const actions = note.action_pending
      ? `<p class="in-progress">A moderation decision is already in progress.</p>`
      : `<form method="post" action="/decision">
          <input type="hidden" name="id" value="${escapeHtml(note.id)}">
          <button class="approve" type="submit" name="decision" value="approve">Approve and publish</button>
          <button class="reject" type="submit" name="decision" value="reject">Reject and remove</button>
        </form>`;

    return `<article class="note">
      <div class="note-meta"><strong>${escapeHtml(note.name)}</strong><time>${escapeHtml(note.created_at)}</time></div>
      <p class="message">${escapeHtml(note.message)}</p>
      ${image}
      ${actions}
    </article>`;
  });
  const emptyState = notes.length === 0
    ? `<p class="empty">No notes are waiting for review.</p>`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Passing Place moderation</title>
  <style nonce="${nonce}">
    :root { color-scheme: light; font-family: system-ui, sans-serif; color: #18373a; background: #f4f6f2; }
    body { max-width: 880px; margin: 0 auto; padding: 32px 18px 64px; }
    header { margin-bottom: 28px; }
    h1 { margin-bottom: 8px; }
    .signed-in, .guidance, time { color: #526568; }
    .notice { padding: 12px 14px; border-radius: 8px; background: #e7efd4; }
    .note { margin: 18px 0; padding: 20px; border: 1px solid #cbd6d0; border-radius: 12px; background: #fff; }
    .note-meta { display: flex; justify-content: space-between; gap: 16px; }
    time { font-size: .875rem; }
    .message { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
    .note-photo { display: block; max-width: min(100%, 560px); max-height: 480px; object-fit: contain; margin: 16px 0; }
    form { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    button { min-height: 42px; padding: 8px 14px; border: 0; border-radius: 7px; font: inherit; cursor: pointer; }
    .approve { color: #fff; background: #17654f; }
    .reject { color: #fff; background: #9c332f; }
    .in-progress { color: #78551a; }
    .empty { padding: 22px; border: 1px dashed #aebbb4; border-radius: 10px; }
  </style>
</head>
<body>
  <header>
    <h1>Passing Place moderation</h1>
    <p class="signed-in">Signed in as ${escapeHtml(moderatorEmail)}</p>
    <p class="guidance">Review pending notes. Approval publishes a note; rejection removes its text and any attached photo.</p>
  </header>
  ${noticeText[notice] ? `<p class="notice" role="status">${noticeText[notice]}</p>` : ""}
  <h2>Waiting for review (${notes.length})</h2>
  ${emptyState}
  ${cards.join("\n")}
</body>
</html>`;

  return new Response(html, { headers: responseHeaders(nonce) });
}

function forbidden(): Response {
  return new Response("Cloudflare Access authentication is required.", {
    status: 403,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function redirectWithNotice(url: URL, notice: "queued" | "conflict" | "failed"): Response {
  const destination = new URL("/", url);
  destination.searchParams.set("notice", notice);
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: destination.toString(),
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function listPendingNotes(env: ModeratorEnvironment): Promise<PendingReview[]> {
  const result = await env.DB.prepare(
    `SELECT m.id, m.name, m.message, m.created_at, m.image_key,
       EXISTS (
         SELECT 1 FROM moderation_actions AS a
         WHERE a.message_id = m.id AND a.status IN ('queued', 'applying')
       ) AS action_pending
     FROM messages AS m
     WHERE m.status = 'pending'
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT 100`,
  ).all<PendingReview>();
  return result.results;
}

async function servePhoto(requestUrl: URL, env: ModeratorEnvironment): Promise<Response> {
  const id = requestUrl.searchParams.get("id");
  if (!id || !isUuidV4(id)) return notFound();

  const row = await env.DB.prepare(
    "SELECT image_key FROM messages WHERE id = ? AND status = 'pending' LIMIT 1",
  )
    .bind(id)
    .first<{ image_key: string | null }>();
  if (!row?.image_key) return notFound();

  const object = await env.PHOTOS.get(row.image_key);
  if (!object) return notFound();
  const contentType = object.httpMetadata?.contentType;
  if (!contentType || !APPROVED_IMAGE_TYPES.has(contentType)) return notFound();

  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Length": String(object.size),
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

async function readBoundedBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_FORM_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

async function queueDecision(
  request: Request,
  url: URL,
  env: ModeratorEnvironment,
  moderatorEmail: string,
): Promise<Response> {
  if (request.headers.get("Origin") !== url.origin) {
    return new Response("Origin not allowed", { status: 403 });
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin") {
    return new Response("Origin not allowed", { status: 403 });
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) {
    return new Response("Unsupported form", { status: 415 });
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && !/^\d+$/.test(contentLength)) {
    return new Response("Invalid form", { status: 400 });
  }
  if (contentLength !== null && Number(contentLength) > MAX_FORM_BYTES) {
    return new Response("Form is too large", { status: 413 });
  }

  let body: string | null;
  try {
    body = await readBoundedBody(request);
  } catch {
    return new Response("Invalid form", { status: 400 });
  }
  if (body === null) return new Response("Form is too large", { status: 413 });

  const form = new URLSearchParams(body);
  const ids = form.getAll("id");
  const decisions = form.getAll("decision");
  const messageId = ids.length === 1 ? ids[0] : "";
  const decision = decisions.length === 1 ? decisions[0] : "";
  if (!isUuidV4(messageId) || (decision !== "approve" && decision !== "reject")) {
    return new Response("Invalid moderation decision", { status: 400 });
  }

  const actionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    const inserted = await env.DB.prepare(
      `INSERT INTO moderation_actions
         (id, message_id, decision, moderator_email, status, created_at)
       SELECT ?, ?, ?, ?, 'queued', ?
       WHERE EXISTS (
         SELECT 1 FROM messages WHERE id = ? AND status = 'pending'
       )`,
    )
      .bind(actionId, messageId, decision, moderatorEmail, createdAt, messageId)
      .run();

    if (inserted.meta.changes !== 1) {
      return redirectWithNotice(url, "conflict");
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) return redirectWithNotice(url, "conflict");
    console.error("Could not record a moderator decision", errorType(error));
    return redirectWithNotice(url, "failed");
  }

  try {
    await env.MODERATION_QUEUE.send({
      messageId,
      manualDecision: decision,
      actionId,
    });
  } catch (error) {
    await env.DB.prepare(
      "UPDATE moderation_actions SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'queued'",
    )
      .bind(new Date().toISOString(), actionId)
      .run()
      .catch(() => undefined);
    console.error("Could not queue a moderator decision", errorType(error));
    return redirectWithNotice(url, "failed");
  }

  return redirectWithNotice(url, "queued");
}

async function authenticatedEmail(ctx: ExecutionContext): Promise<string | null> {
  try {
    const identity = await ctx.access?.getIdentity();
    const email = identity?.email;
    if (typeof email !== "string" || email.length === 0 || email.length > MAX_MODERATOR_EMAIL_LENGTH) {
      return null;
    }
    return email;
  } catch {
    return null;
  }
}

export default {
  async fetch(
    request: Request,
    env: ModeratorEnvironment,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const moderatorEmail = await authenticatedEmail(ctx);
    if (!moderatorEmail) return forbidden();

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        const notes = await listPendingNotes(env);
        return renderPage(moderatorEmail, notes, url.searchParams.get("notice") || "");
      }

      if (request.method === "GET" && url.pathname === "/photo") {
        return await servePhoto(url, env);
      }

      if (request.method === "POST" && url.pathname === "/decision") {
        return await queueDecision(request, url, env, moderatorEmail);
      }

      return notFound();
    } catch (error) {
      console.error("Moderator request failed", errorType(error));
      return new Response("The moderation page is temporarily unavailable.", {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  },
};
