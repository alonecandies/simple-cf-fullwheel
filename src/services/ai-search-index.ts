import { errorType } from "../lib/logging";
import type { Environment } from "../types";

const MAX_INDEXED_MESSAGES = 6_000;
const BACKFILL_BATCH_SIZE = 5;
const PENDING = "pending";

interface ApprovedTextRow {
  id: string;
  name: string;
  message: string;
}

let cachedInstance: AiSearchInstance | undefined;

function isAiSearchConfigured(env: Environment): boolean {
  return env.AI_SEARCH_ENABLED === "true" && Boolean(env.AI_SEARCH && env.AI_SEARCH_INSTANCE);
}

async function findInstance(env: Environment): Promise<AiSearchInstance | null> {
  if (!env.AI_SEARCH || !env.AI_SEARCH_INSTANCE) return null;
  const response = await env.AI_SEARCH.list({
    search: env.AI_SEARCH_INSTANCE,
    per_page: 50,
  });
  if (!response.result.some(({ id }) => id === env.AI_SEARCH_INSTANCE)) return null;
  return env.AI_SEARCH.get(env.AI_SEARCH_INSTANCE);
}

/** Create the app's built-in-storage instance inside its dedicated namespace. */
export async function getGuestbookAiSearchInstance(
  env: Environment,
): Promise<AiSearchInstance> {
  if (!isAiSearchConfigured(env) || !env.AI_SEARCH || !env.AI_SEARCH_INSTANCE) {
    throw new Error("AI Search is not configured");
  }
  if (cachedInstance) return cachedInstance;

  const existing = await findInstance(env);
  if (existing) {
    cachedInstance = existing;
    return existing;
  }

  try {
    cachedInstance = await env.AI_SEARCH.create({
      id: env.AI_SEARCH_INSTANCE,
      index_method: { vector: true, keyword: true },
      max_num_results: 5,
      score_threshold: 0.25,
      cache: false,
    });
    return cachedInstance;
  } catch (error) {
    // A search request and the scheduled task can race on first use. Re-read
    // the namespace before surfacing an error from the losing create call.
    const createdByAnotherInvocation = await findInstance(env).catch(() => null);
    if (createdByAnotherInvocation) {
      cachedInstance = createdByAnotherInvocation;
      return createdByAnotherInvocation;
    }
    throw error;
  }
}

async function indexApprovedRows(
  env: Environment,
  rows: ApprovedTextRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const instance = await getGuestbookAiSearchInstance(env);

  const reservations = await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(
        "UPDATE messages SET ai_search_indexed_at = ? WHERE id = ? AND status = 'approved' AND (ai_search_indexed_at IS NULL OR ai_search_indexed_at = ?) AND (ai_search_indexed_at = ? OR (SELECT COUNT(*) FROM messages WHERE ai_search_indexed_at IS NOT NULL) < ?)",
      ).bind(PENDING, row.id, PENDING, PENDING, MAX_INDEXED_MESSAGES),
    ),
  );
  const reservedRows = rows.filter((_, index) => reservations[index]?.meta.changes === 1);
  if (reservedRows.length === 0) return 0;

  const uploaded = await Promise.all(
    reservedRows.map(async (row) => {
      const item = await instance.items.upload(
        `${row.id}.md`,
        `# ${row.name}\n\n${row.message}`,
      );
      return { row, itemId: item.id };
    }),
  );
  const indexedAt = new Date().toISOString();
  const updates = await env.DB.batch(
    uploaded.map(({ row, itemId }) =>
      env.DB.prepare(
        "UPDATE messages SET ai_search_indexed_at = ?, ai_search_item_id = ? WHERE id = ? AND status = 'approved' AND ai_search_indexed_at = ?",
      ).bind(indexedAt, itemId, row.id, PENDING),
    ),
  );

  const staleItemIds = uploaded.flatMap(({ itemId }, index) =>
    updates[index]?.meta.changes === 1 ? [] : [itemId],
  );
  if (staleItemIds.length > 0) {
    await Promise.all(staleItemIds.map((itemId) => instance.items.delete(itemId)));
  }
  return uploaded.length - staleItemIds.length;
}

export async function indexApprovedMessageForAiSearch(
  env: Environment,
  messageId: string,
): Promise<void> {
  if (!isAiSearchConfigured(env)) return;

  try {
    const row = await env.DB.prepare(
      "SELECT id, name, message FROM messages WHERE id = ? AND status = 'approved' AND ai_search_indexed_at IS NULL LIMIT 1",
    )
      .bind(messageId)
      .first<ApprovedTextRow>();
    if (!row) return;
    await indexApprovedRows(env, [row]);
  } catch (error) {
    console.warn("Could not index an approved guestbook note for AI Search", errorType(error));
  }
}

export async function backfillApprovedAiSearchMessages(env: Environment): Promise<number> {
  if (!isAiSearchConfigured(env)) return 0;

  try {
    await getGuestbookAiSearchInstance(env);
    const result = await env.DB.prepare(
      "SELECT id, name, message FROM messages WHERE status = 'approved' AND (ai_search_indexed_at IS NULL OR ai_search_indexed_at = ?) ORDER BY created_at, id LIMIT ?",
    )
      .bind(PENDING, BACKFILL_BATCH_SIZE)
      .all<ApprovedTextRow>();
    return await indexApprovedRows(env, result.results);
  } catch (error) {
    console.warn("Could not backfill approved notes into AI Search", errorType(error));
    return 0;
  }
}
