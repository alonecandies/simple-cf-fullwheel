import type {
  CachedGuestbook,
  Environment,
  GuestbookMessage,
  PublicMessage,
} from "../types";
import { errorType } from "../lib/logging";

const MESSAGE_CACHE_KEY = "guestbook:approved:v1";

export async function getMessage(
  env: Environment,
  id: string,
): Promise<GuestbookMessage | null> {
  const result = await env.DB.prepare(
    "SELECT id, name, message, created_at, image_key, share_card_key, status FROM messages WHERE id = ? LIMIT 1",
  )
    .bind(id)
    .all<GuestbookMessage>();

  return result.results[0] ?? null;
}

function toPublicMessage(entry: GuestbookMessage): PublicMessage {
  const { image_key, share_card_key, status: _status, ...message } = entry;
  return {
    ...message,
    imageUrl: image_key ? `/media/${message.id}` : null,
    shareCardUrl: share_card_key ? `/share-cards/${message.id}` : null,
  };
}

/** Re-read IDs returned by search indexes so stale or rejected results stay private. */
export async function getApprovedMessagesByIds(
  env: Environment,
  ids: string[],
): Promise<PublicMessage[]> {
  const uniqueIds = [...new Set(ids)];
  const rows = await Promise.all(
    uniqueIds.map((id) =>
      env.DB.prepare(
        "SELECT id, name, message, created_at, image_key, share_card_key, status FROM messages WHERE id = ? AND status = 'approved' LIMIT 1",
      )
        .bind(id)
        .first<GuestbookMessage>(),
    ),
  );
  const approved = new Map(
    rows
      .filter((row): row is GuestbookMessage => row !== null)
      .map((row) => [row.id, toPublicMessage(row)] as const),
  );
  return uniqueIds.flatMap((id) => {
    const message = approved.get(id);
    return message ? [message] : [];
  });
}

async function readCachedGuestbook(env: Environment): Promise<CachedGuestbook | null> {
  try {
    return await env.CACHE.get<CachedGuestbook>(MESSAGE_CACHE_KEY, "json");
  } catch (error) {
    console.warn("Could not read the guestbook cache", errorType(error));
    return null;
  }
}

async function writeCachedGuestbook(
  env: Environment,
  guestbook: CachedGuestbook,
): Promise<void> {
  try {
    await env.CACHE.put(MESSAGE_CACHE_KEY, JSON.stringify(guestbook), {
      expirationTtl: 60,
    });
  } catch (error) {
    console.warn("Could not write the guestbook cache", errorType(error));
  }
}

export async function listApprovedMessages(env: Environment): Promise<CachedGuestbook> {
  const cached = await readCachedGuestbook(env);
  if (cached) return cached;

  const [result, count] = await Promise.all([
    env.DB.prepare(
      "SELECT id, name, message, created_at, image_key, share_card_key, status FROM messages WHERE status = 'approved' ORDER BY created_at DESC, id DESC LIMIT 60",
    ).all<GuestbookMessage>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS total FROM messages WHERE status = 'approved'",
    ).all<{ total: number }>(),
  ]);

  const messages: PublicMessage[] = result.results.map(toPublicMessage);
  const guestbook = {
    messages,
    total: count.results[0]?.total ?? messages.length,
  };

  await writeCachedGuestbook(env, guestbook);
  return guestbook;
}

export async function clearMessageCache(env: Environment): Promise<void> {
  try {
    await env.CACHE.delete(MESSAGE_CACHE_KEY);
  } catch (error) {
    console.warn("Could not clear the guestbook cache", errorType(error));
  }
}

export async function purgeMessage(
  env: Environment,
  id: string,
  status: "rejected" | "unavailable",
): Promise<void> {
  const entry = await getMessage(env, id);
  if (!entry || entry.status === "approved") return;

  const update = await env.DB.prepare(
    "UPDATE messages SET status = ?, name = '', message = '', image_key = NULL WHERE id = ? AND status = 'pending'",
  )
    .bind(status, id)
    .run();

  if (update.meta.changes === 1 && entry.image_key) {
    await env.PHOTOS.delete(entry.image_key);
  }
}
