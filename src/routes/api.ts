import { json } from "../lib/http";
import { isUuidV4 } from "../lib/ids";
import {
  getMessage,
  listApprovedMessages,
} from "../services/guestbook";
import { verifyTurnstile } from "../services/turnstile";
import { checkHyperdrive } from "../services/hyperdrive";
import { allowRateLimitedRequest } from "../services/rate-limit";
import { searchWithAiSearch, searchWithVectorize } from "../services/search";
import { consumeAiSearchBudget } from "../services/search-budget";
import { errorType } from "../lib/logging";
import { isLocalDevelopmentUrl, readBoundedJson } from "../lib/request";
import { MAX_STORED_MESSAGES, MAX_STORED_PHOTOS } from "../lib/limits";
import type { Environment } from "../types";

const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 24_576;
const IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"];

function getImageExtension(file: File, bytes: Uint8Array): string | null {
  if (
    file.type === "image/jpeg" &&
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpg";
  }

  if (
    file.type === "image/png" &&
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }

  if (
    file.type === "image/webp" &&
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "webp";
  }

  return null;
}

async function parseForm(request: Request): Promise<FormData | Response> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^multipart\/form-data\s*;\s*boundary=/i.test(contentType)) {
    return json({ error: "Send the note using the guestbook form." }, 415);
  }

  const maximumBytes = MAX_IMAGE_BYTES + MAX_MULTIPART_OVERHEAD_BYTES;
  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader !== null) {
    if (!/^\d+$/.test(contentLengthHeader)) {
      return json({ error: "The note could not be read. Please try again." }, 400);
    }
    if (Number(contentLengthHeader) > maximumBytes) {
      return json({ error: "Your photo must be 512 KB or smaller." }, 413);
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return json({ error: "The note could not be read. Please try again." }, 400);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return json({ error: "Your photo must be 512 KB or smaller." }, 413);
      }
      chunks.push(value);
    }
  } catch {
    return json({ error: "The note could not be read. Please try again." }, 400);
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return await new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    }).formData();
  } catch {
    return json({ error: "The note could not be read. Please try again." }, 400);
  }
}

export async function handleApi(
  request: Request,
  env: Environment,
  url: URL,
): Promise<Response> {
  const turnstileDevBypass =
    env.TURNSTILE_DEV_BYPASS === "true" && isLocalDevelopmentUrl(url);

  if (url.pathname === "/api/config" && request.method === "GET") {
    return json({
      turnstileSiteKey:
        turnstileDevBypass
          ? null
          : env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY
            ? env.TURNSTILE_SITE_KEY
            : null,
      webAnalyticsToken: env.WEB_ANALYTICS_TOKEN || null,
      aiSearchEnabled:
        env.AI_SEARCH_ENABLED === "true" && Boolean(env.AI_SEARCH && env.AI_SEARCH_INSTANCE),
      vectorSearchEnabled:
        env.VECTORIZE_ENABLED === "true" && Boolean(env.VECTORIZE),
      zarazEnabled:
        env.ZARAZ_ENABLED === "true" && Boolean(env.ZARAZ_CONSENT_PURPOSE_ID),
      zarazConsentPurposeId:
        env.ZARAZ_ENABLED === "true" ? env.ZARAZ_CONSENT_PURPOSE_ID || null : null,
    });
  }

  if (url.pathname === "/api/messages" && request.method === "GET") {
    return json(await listApprovedMessages(env));
  }

  if (url.pathname === "/api/search" && request.method === "POST") {
    if (request.headers.get("Origin") !== url.origin) {
      return json({ error: "Origin not allowed." }, 403);
    }

    const parsedBody = await readBoundedJson(request, 2_048);
    if (parsedBody instanceof Response) return parsedBody;
    if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
      return json({ error: "Send a search request." }, 400);
    }

    const body = parsedBody as Record<string, unknown>;
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const provider = body.provider;
    if (
      query.length < 2 ||
      query.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(query)
    ) {
      return json({ error: "Search text must be 2 to 120 characters." }, 400);
    }
    if (provider !== "ai-search" && provider !== "vectorize") {
      return json({ error: "Choose an available search service." }, 400);
    }

    const enabled = provider === "ai-search"
      ? env.AI_SEARCH_ENABLED === "true" && Boolean(env.AI_SEARCH && env.AI_SEARCH_INSTANCE)
      : env.VECTORIZE_ENABLED === "true" && Boolean(env.VECTORIZE);
    if (!enabled) return json({ error: "That search service is not enabled." }, 404);

    try {
      const allowed = await allowRateLimitedRequest(
        env.PUBLIC_API_RATE_LIMITER,
        request,
        `guestbook-search-${provider}`,
      );
      if (!allowed) {
        return json({ error: "Please wait before searching again." }, 429);
      }
    } catch (error) {
      console.error("Could not check the guestbook search rate limit", errorType(error));
      return json({ error: "Search is temporarily unavailable." }, 503);
    }

    if (provider === "ai-search") {
      try {
        if (!(await consumeAiSearchBudget(env))) {
          return json({ error: "The monthly AI Search demo allowance is used up." }, 429);
        }
      } catch (error) {
        console.error("Could not check the AI Search monthly allowance", errorType(error));
        return json({ error: "Search is temporarily unavailable." }, 503);
      }
    }

    try {
      const messages = provider === "ai-search"
        ? await searchWithAiSearch(env, query)
        : await searchWithVectorize(env, query);
      return json({ messages });
    } catch (error) {
      console.error("Guestbook search failed", { provider, errorType: errorType(error) });
      return json({ error: "Search is temporarily unavailable." }, 503);
    }
  }

  if (url.pathname === "/api/integrations/hyperdrive" && request.method === "GET") {
    if (env.HYPERDRIVE_DEMO_ENABLED !== "true" || !env.HYPERDRIVE) {
      return json({ error: "That page is not here." }, 404);
    }

    try {
      const allowed = await allowRateLimitedRequest(
        env.PUBLIC_API_RATE_LIMITER,
        request,
        "hyperdrive-demo",
      );
      if (!allowed) {
        return json({ error: "Please wait before checking the database again." }, 429);
      }
      return json(await checkHyperdrive(env));
    } catch (error) {
      console.error("Hyperdrive connectivity check failed", errorType(error));
      return json({ error: "The external database check is temporarily unavailable." }, 503);
    }
  }

  if (url.pathname.startsWith("/api/messages/status/") && request.method === "GET") {
    const id = url.pathname.slice("/api/messages/status/".length);
    if (!isUuidV4(id)) {
      return json({ error: "That note is not here." }, 404);
    }

    const entry = await getMessage(env, id);
    if (!entry) return json({ error: "That note is not here." }, 404);
    return json({ status: entry.status });
  }

  if (url.pathname === "/api/messages" && request.method === "POST") {
    if (request.headers.get("Origin") !== url.origin) {
      return json({ error: "Origin not allowed." }, 403);
    }

    try {
      const allowed = await allowRateLimitedRequest(
        env.PUBLIC_API_RATE_LIMITER,
        request,
        "guestbook-submit",
      );
      if (!allowed) {
        return json({ error: "Please wait a moment before leaving another note." }, 429);
      }
    } catch (error) {
      console.error("Could not check the guestbook rate limit", errorType(error));
      return json({ error: "Posting is temporarily unavailable. Try again soon." }, 503);
    }

    const parsedForm = await parseForm(request);
    if (parsedForm instanceof Response) return parsedForm;
    const form = parsedForm;

    const rawName = form.get("name");
    const rawMessage = form.get("message");
    const rawToken = form.get("turnstileToken");
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const message = typeof rawMessage === "string" ? rawMessage.trim() : "";

    if (name.length < 2 || name.length > 40) {
      return json({ error: "Your name must be 2 to 40 characters." }, 400);
    }
    if (message.length < 3 || message.length > 240) {
      return json({ error: "Your note must be 3 to 240 characters." }, 400);
    }

    if (!turnstileDevBypass) {
      const hasSiteKey = Boolean(env.TURNSTILE_SITE_KEY);
      const hasSecret = Boolean(env.TURNSTILE_SECRET_KEY);
      if (!hasSiteKey || !hasSecret) {
        return json(
          { error: "Posting will open after spam protection is configured." },
          503,
        );
      }

      if (typeof rawToken !== "string" || rawToken.length === 0) {
        return json({ error: "Complete the human check before posting." }, 400);
      }

      const verified = await verifyTurnstile(rawToken, env.TURNSTILE_SECRET_KEY!, request);
      if (!verified) {
        return json(
          { error: "The human check expired. Please try it again." },
          403,
        );
      }
    }

    const rawImage = form.get("image");
    const imageFile = rawImage instanceof File && rawImage.size > 0 ? rawImage : null;
    let imageBytes: ArrayBuffer | null = null;
    let imageType: string | null = null;
    let imageExtension: string | null = null;

    if (imageFile) {
      if (imageFile.size > MAX_IMAGE_BYTES) {
        return json({ error: "Your photo must be 512 KB or smaller." }, 413);
      }

      imageBytes = await imageFile.arrayBuffer();
      imageExtension = getImageExtension(imageFile, new Uint8Array(imageBytes));
      if (!imageExtension || !IMAGE_CONTENT_TYPES.includes(imageFile.type)) {
        return json({ error: "Choose a valid JPG, PNG, or WebP photo." }, 415);
      }
      imageType = imageFile.type;
    }

    const createdAt = new Date().toISOString();
    const id = crypto.randomUUID();
    const imageKey = imageExtension ? `${id}/${crypto.randomUUID()}.${imageExtension}` : null;

    try {
      const insert = imageKey
        ? await env.DB.prepare(
            "INSERT INTO messages (id, name, message, created_at, status, image_key) SELECT ?, ?, ?, ?, 'pending', ? WHERE (SELECT COUNT(*) FROM messages) < ? AND (SELECT COUNT(*) FROM messages WHERE image_key IS NOT NULL AND status IN ('pending', 'approved')) < ?",
          )
            .bind(
              id,
              name,
              message,
              createdAt,
              imageKey,
              MAX_STORED_MESSAGES,
              MAX_STORED_PHOTOS,
            )
            .run()
        : await env.DB.prepare(
            "INSERT INTO messages (id, name, message, created_at, status, image_key) SELECT ?, ?, ?, ?, 'pending', NULL WHERE (SELECT COUNT(*) FROM messages) < ?",
          )
            .bind(id, name, message, createdAt, MAX_STORED_MESSAGES)
            .run();

      if (insert.meta.changes !== 1) {
        if (insert.meta.changes === 0) {
          return json(
            {
              error: imageKey
                ? "This demo has reached a storage limit for notes or photos."
                : "This demo has reached its note storage limit.",
            },
            507,
          );
        }
        throw new Error("The guestbook storage limit could not be confirmed");
      }

      if (imageKey && imageBytes && imageType) {
        await env.PHOTOS.put(imageKey, imageBytes, {
          httpMetadata: { contentType: imageType },
        });
      }

      await env.MODERATION_QUEUE.send({ messageId: id });
    } catch (error) {
      await env.DB.prepare("DELETE FROM messages WHERE id = ? AND status = 'pending'")
        .bind(id)
        .run()
        .catch((cleanupError: unknown) =>
          console.error("Could not remove the unsent note", errorType(cleanupError)),
        );
      if (imageKey) {
        await env.PHOTOS.delete(imageKey).catch((cleanupError: unknown) =>
          console.error("Could not remove the unsent photo", errorType(cleanupError)),
        );
      }
      throw error;
    }

    return json({ id, status: "pending" }, 202);
  }

  if (url.pathname.startsWith("/api/")) {
    return json({ error: "That page is not here." }, 404);
  }

  return json({ error: "Method not allowed." }, 405);
}
