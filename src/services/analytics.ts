import type { Environment } from "../types";
import { errorType } from "../lib/logging";

export type ModerationMetricStatus =
  | "approved"
  | "rejected"
  | "unavailable"
  | "missing";

/** Record only aggregate event labels and duration; never note data or IDs. */
export function recordModerationMetric(
  env: Environment,
  status: ModerationMetricStatus,
  durationMs: number,
  source: "automatic" | "manual" = "automatic",
): void {
  try {
    env.MODERATION_METRICS.writeDataPoint({
      indexes: ["passing-place"],
      blobs: ["moderation", status, source],
      doubles: [Math.max(0, Math.round(durationMs))],
    });
  } catch (error) {
    // Metrics must never prevent a note from being moderated or published.
    console.warn("Could not record moderation metrics", errorType(error));
  }
}
