import { errorType } from "../lib/logging";
import type { Environment } from "../types";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const EMBEDDING_DIMENSIONS = 768;
const BACKFILL_BATCH_SIZE = 5;
const MAX_VECTOR_INDEXED_MESSAGES = 6_000;

interface ApprovedTextRow {
  id: string;
  name: string;
  message: string;
}

async function indexApprovedRows(
  env: Environment,
  rows: ApprovedTextRow[],
): Promise<number> {
  if (rows.length === 0 || !env.VECTORIZE) return 0;

  const reservations = await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(
        "UPDATE messages SET vector_indexed_at = 'pending' WHERE id = ? AND status = 'approved' AND (vector_indexed_at IS NULL OR vector_indexed_at = 'pending') AND (vector_indexed_at = 'pending' OR (SELECT COUNT(*) FROM messages WHERE vector_indexed_at IS NOT NULL) < ?)",
      ).bind(row.id, MAX_VECTOR_INDEXED_MESSAGES),
    ),
  );
  const reservedRows = rows.filter((_, index) => reservations[index]?.meta.changes === 1);
  if (reservedRows.length === 0) return 0;

  const embeddings = await env.AI.run(EMBEDDING_MODEL, {
    text: reservedRows.map(({ name, message }) => `${name}: ${message}`),
  });
  const embeddingData = "data" in embeddings ? embeddings.data : undefined;
  if (!embeddingData || embeddingData.length !== reservedRows.length) {
    throw new Error("The embedding model returned an unexpected number of vectors");
  }

  const vectors = reservedRows.map((row, index) => {
    const values = embeddingData[index];
    if (
      !values ||
      values.length !== EMBEDDING_DIMENSIONS ||
      values.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("The embedding model returned an invalid vector");
    }
    return { id: row.id, values };
  });

  await env.VECTORIZE.upsert(vectors);
  const indexedAt = new Date().toISOString();
  const updates = await env.DB.batch(
    reservedRows.map((row) =>
      env.DB.prepare(
        "UPDATE messages SET vector_indexed_at = ? WHERE id = ? AND status = 'approved' AND vector_indexed_at = 'pending'",
      ).bind(indexedAt, row.id),
    ),
  );
  const staleIds = reservedRows.flatMap((row, index) =>
    updates[index]?.meta.changes === 1 ? [] : [row.id],
  );
  if (staleIds.length > 0) await env.VECTORIZE.deleteByIds(staleIds);
  return reservedRows.length - staleIds.length;
}

export async function indexApprovedMessage(
  env: Environment,
  messageId: string,
): Promise<void> {
  if (env.VECTORIZE_ENABLED !== "true" || !env.VECTORIZE) return;

  try {
    const row = await env.DB.prepare(
      "SELECT id, name, message FROM messages WHERE id = ? AND status = 'approved' AND vector_indexed_at IS NULL LIMIT 1",
    )
      .bind(messageId)
      .first<ApprovedTextRow>();
    if (!row) return;
    await indexApprovedRows(env, [row]);
  } catch (error) {
    console.warn("Could not index an approved guestbook note", errorType(error));
  }
}

export async function backfillApprovedVectors(env: Environment): Promise<number> {
  if (env.VECTORIZE_ENABLED !== "true" || !env.VECTORIZE) return 0;

  const result = await env.DB.prepare(
    "SELECT id, name, message FROM messages WHERE status = 'approved' AND (vector_indexed_at IS NULL OR vector_indexed_at = 'pending') ORDER BY created_at, id LIMIT 5",
  ).all<ApprovedTextRow>();
  return indexApprovedRows(env, result.results.slice(0, BACKFILL_BATCH_SIZE));
}
