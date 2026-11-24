import { errorType } from "../lib/logging";
import type { Environment } from "../types";

interface PendingBacklogSummary {
  pending_count: number;
  oldest_pending_at: string | null;
}

export async function logPendingBacklogSummary(
  env: Environment,
  scheduledTime: number,
  cron: string,
): Promise<void> {
  try {
    const summary = await env.DB.prepare(
      "SELECT COUNT(*) AS pending_count, MIN(created_at) AS oldest_pending_at FROM messages WHERE status = ?",
    )
      .bind("pending")
      .first<PendingBacklogSummary>();

    const oldestTimestamp = summary?.oldest_pending_at
      ? Date.parse(summary.oldest_pending_at)
      : Number.NaN;
    const oldestPendingAgeSeconds = Number.isFinite(oldestTimestamp)
      ? Math.max(0, Math.floor((scheduledTime - oldestTimestamp) / 1_000))
      : null;

    console.info("Scheduled guestbook health summary", {
      cron,
      scheduledAt: new Date(scheduledTime).toISOString(),
      pendingCount: Math.max(0, Math.floor(summary?.pending_count ?? 0)),
      oldestPendingAgeSeconds,
    });
  } catch (error) {
    console.error("Scheduled guestbook health check failed", errorType(error));
    throw new Error("Scheduled guestbook health check failed");
  }
}
