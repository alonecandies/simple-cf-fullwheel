import type { Environment } from "../types";

const AI_SEARCH_APP_MONTHLY_BUDGET = 900;

/** Keep this app's AI Search calls below the account's 1,000-query Free allowance. */
export async function consumeAiSearchBudget(env: Environment): Promise<boolean> {
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const result = await env.DB.prepare(
    "INSERT INTO integration_usage (service, period, requests) VALUES ('ai-search', ?, 1) ON CONFLICT(service) DO UPDATE SET period = excluded.period, requests = CASE WHEN integration_usage.period = excluded.period THEN integration_usage.requests + 1 ELSE 1 END WHERE integration_usage.period <> excluded.period OR integration_usage.requests < ?",
  )
    .bind(period, AI_SEARCH_APP_MONTHLY_BUDGET)
    .run();
  return result.meta.changes === 1;
}
