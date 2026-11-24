import { isUuidV4 } from "../lib/ids";
import { getApprovedMessagesByIds } from "./guestbook";
import { getGuestbookAiSearchInstance } from "./ai-search-index";
import type { Environment, PublicMessage } from "../types";

const MAX_RESULTS = 5;

function getAiSearchRowIds(response: AiSearchSearchResponse): string[] {
  const ids: string[] = [];
  for (const chunk of response.chunks) {
    const rowId = chunk.item.metadata?.row_id;
    if (typeof rowId === "string" && isUuidV4(rowId)) ids.push(rowId);
    else if (typeof rowId === "number" && Number.isSafeInteger(rowId)) ids.push(String(rowId));
    else if (chunk.item.key.endsWith(".md")) {
      const keyId = chunk.item.key.slice(0, -3);
      if (isUuidV4(keyId)) ids.push(keyId);
    }
  }
  return [...new Set(ids)].slice(0, MAX_RESULTS);
}

export async function searchWithAiSearch(
  env: Environment,
  query: string,
): Promise<PublicMessage[]> {
  const instance = await getGuestbookAiSearchInstance(env);
  const response = await instance.search({
    query,
    ai_search_options: {
      retrieval: {
        retrieval_type: "hybrid",
        max_num_results: MAX_RESULTS,
        match_threshold: 0.25,
      },
    },
  });
  return getApprovedMessagesByIds(env, getAiSearchRowIds(response));
}

export async function searchWithVectorize(
  env: Environment,
  query: string,
): Promise<PublicMessage[]> {
  if (env.VECTORIZE_ENABLED !== "true" || !env.VECTORIZE) {
    throw new Error("Vectorize is not configured");
  }

  const response = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [query],
  });
  const embeddingData = "data" in response ? response.data : undefined;
  const vector = embeddingData?.[0];
  if (!vector || vector.length !== 768 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("The embedding model returned an invalid vector");
  }

  const matches = await env.VECTORIZE.query(vector, { topK: MAX_RESULTS });
  const ids = matches.matches
    .map((match) => match.id)
    .filter(isUuidV4)
    .slice(0, MAX_RESULTS);
  return getApprovedMessagesByIds(env, ids);
}
