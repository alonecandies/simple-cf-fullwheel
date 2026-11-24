import type { Environment } from "../types";
import { isUuidV4 } from "../lib/ids";
import { errorType } from "../lib/logging";

export async function handleMedia(
  request: Request,
  env: Environment,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const isShareCard = url.pathname.startsWith("/share-cards/");
  const prefix = isShareCard ? "/share-cards/" : "/media/";
  const id = url.pathname.slice(prefix.length);
  if (!isUuidV4(id)) return new Response("Not found", { status: 404 });

  const result = isShareCard
    ? await env.DB.prepare(
        "SELECT share_card_key AS media_key FROM messages WHERE id = ? AND status = 'approved' LIMIT 1",
      )
        .bind(id)
        .all<{ media_key: string | null }>()
    : await env.DB.prepare(
        "SELECT image_key AS media_key FROM messages WHERE id = ? AND status = 'approved' LIMIT 1",
      )
        .bind(id)
        .all<{ media_key: string | null }>();
  const mediaKey = result.results[0]?.media_key;
  if (!mediaKey) return new Response("Not found", { status: 404 });

  // Check D1 before consulting the edge cache. A cached image can never bypass
  // the current approval status, and query parameters cannot create cache keys.
  const cacheKey = new Request(new URL(`${prefix}${id}`, url.origin), { method: "GET" });
  let cache: Cache | null = null;
  let cacheHit: Response | undefined;
  try {
    cache = caches.default;
    cacheHit = await cache.match(cacheKey);
  } catch (error) {
    console.warn("Could not read approved media from the edge cache", errorType(error));
  }
  if (cacheHit) {
    return request.method === "HEAD"
      ? new Response(null, { status: cacheHit.status, headers: cacheHit.headers })
      : cacheHit;
  }

  const object = await env.PHOTOS.get(mediaKey);
  if (!object) return new Response("Not found", { status: 404 });

  let body: ReadableStream<Uint8Array> | ArrayBuffer | null = null;
  let contentType = object.httpMetadata?.contentType || "application/octet-stream";

  if (!isShareCard) {
    const originalBytes = await object.arrayBuffer();
    body = originalBytes;

    try {
      const input = new Response(originalBytes).body;
      if (!input) throw new Error("Photo bytes were unavailable");
      const optimized = await env.IMAGES.input(input)
        .transform({ width: 1200, height: 1200, fit: "scale-down" })
        .output({ format: "image/webp", quality: 82 });
      const optimizedResponse = optimized.response();
      contentType = optimized.contentType();
      body = optimizedResponse.body;
    } catch (error) {
      // Keep approved photos available if a transform fails or the free
      // transformation allowance is exhausted.
      console.warn(
        "Cloudflare Images could not transform an approved photo",
        id,
        errorType(error),
      );
    }
  } else {
    body = await object.arrayBuffer();
  }

  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400, immutable",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  if (isShareCard) {
    headers.set("Content-Disposition", `attachment; filename="passing-place-${id}.jpg"`);
  }

  const response = new Response(request.method === "HEAD" ? null : body, { headers });
  if (cache && request.method === "GET" && response.ok) {
    try {
      await cache.put(cacheKey, response.clone());
    } catch (error) {
      // Edge cache is best-effort; approved media stays available on a miss.
      console.warn("Could not cache approved media at the edge", errorType(error));
    }
  }

  return response;
}
