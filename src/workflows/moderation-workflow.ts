import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  applyManualDecision,
  markModerationUnavailable,
  moderateGuestbookMessage,
} from "../services/moderation";
import { generateShareCard } from "../services/share-card";
import { recordModerationMetric } from "../services/analytics";
import { notifyModeratorOfApproval } from "../services/email-notification";
import { indexApprovedMessage } from "../services/vector-index";
import { indexApprovedMessageForAiSearch } from "../services/ai-search-index";
import { errorType } from "../lib/logging";
import type { Environment, ModerationJob } from "../types";

async function broadcastPresence(
  env: Environment,
  type: "new-note" | "share-card-ready",
): Promise<void> {
  const response = await env.PRESENCE.getByName("passing-place").fetch(
    new Request("https://presence.internal/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    }),
  );
  if (!response.ok) throw new Error("Could not notify live visitors");
}

export class ModerationWorkflow extends WorkflowEntrypoint<Environment, ModerationJob> {
  async run(
    event: WorkflowEvent<ModerationJob>,
    step: WorkflowStep,
  ): Promise<{ status: string; shareCardReady?: boolean }> {
    const { messageId } = event.payload;
    let outcome: Awaited<ReturnType<typeof moderateGuestbookMessage>> = {
      status: "unavailable",
    };
    let moderationDurationMs = 0;
    let manualDecisionApplied = false;

    try {
      if (event.payload.manualDecision && event.payload.actionId) {
        const result = await step.do(
          "apply-manual-decision",
          {
            retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
            timeout: "30 seconds",
          },
          async () => {
            const startedAt = Date.now();
            const result = await applyManualDecision(
              this.env,
              messageId,
              event.payload.actionId!,
              event.payload.manualDecision!,
            );
            return { ...result, durationMs: Date.now() - startedAt };
          },
        );
        outcome = result.outcome;
        manualDecisionApplied = result.applied;
        moderationDurationMs = result.durationMs;
      } else {
        const result = await step.do(
          "moderate-note",
          {
            retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
            timeout: "2 minutes",
          },
          async () => {
            const startedAt = Date.now();
            try {
              const moderation = await moderateGuestbookMessage(this.env, messageId);
              return { moderation, durationMs: Date.now() - startedAt };
            } catch (error) {
              moderationDurationMs = Date.now() - startedAt;
              throw error;
            }
          },
        );
        outcome = result.moderation;
        moderationDurationMs = result.durationMs;
      }
    } catch (error) {
      if (event.payload.manualDecision && event.payload.actionId) {
        console.error("Manual moderation workflow exhausted its retries", errorType(error));
        await this.env.DB.prepare(
          "UPDATE moderation_actions SET status = 'failed', completed_at = ? WHERE id = ? AND status IN ('queued', 'applying')",
        )
          .bind(new Date().toISOString(), event.payload.actionId)
          .run()
          .catch((auditError: unknown) =>
            console.error("Could not record a failed moderator action", errorType(auditError)),
          );
        outcome = { status: "unavailable" };
      } else {
        console.error("Moderation workflow exhausted its retries", errorType(error));
        try {
          await step.do("mark-note-unavailable", () =>
            markModerationUnavailable(this.env, messageId).then(() => ({ status: "unavailable" })),
          );
        } catch (cleanupError) {
          console.error(
            "Could not mark the note unavailable",
            errorType(cleanupError),
          );
        }
        outcome = { status: "unavailable" };
      }
    }

    await step.do("record-moderation-metric", async () => {
      recordModerationMetric(
        this.env,
        outcome.status,
        moderationDurationMs,
        event.payload.manualDecision && event.payload.actionId ? "manual" : "automatic",
      );
      return { recorded: true };
    });

    if (
      outcome.status === "approved" &&
      (!event.payload.manualDecision || manualDecisionApplied) &&
      this.env.VECTORIZE_ENABLED === "true" &&
      this.env.VECTORIZE
    ) {
      try {
        await step.do(
          "index-approved-note-for-vector-search",
          { retries: { limit: 1, delay: "10 seconds", backoff: "linear" }, timeout: "60 seconds" },
          async () => {
            await indexApprovedMessage(this.env, messageId);
            return { indexed: true };
          },
        );
      } catch (error) {
        console.warn("The approved note could not be indexed for vector search", errorType(error));
      }
    }

    if (
      outcome.status === "approved" &&
      (!event.payload.manualDecision || manualDecisionApplied) &&
      this.env.AI_SEARCH_ENABLED === "true" &&
      this.env.AI_SEARCH &&
      this.env.AI_SEARCH_INSTANCE
    ) {
      try {
        await step.do(
          "index-approved-note-for-ai-search",
          { retries: { limit: 1, delay: "10 seconds", backoff: "linear" }, timeout: "60 seconds" },
          async () => {
            await indexApprovedMessageForAiSearch(this.env, messageId);
            return { indexed: true };
          },
        );
      } catch (error) {
        console.warn("The approved note could not be indexed for AI Search", errorType(error));
      }
    }

    if (outcome.status !== "approved" || (event.payload.manualDecision && !manualDecisionApplied)) {
      return { status: outcome.status };
    }

    try {
      await step.do(
        "notify-live-visitors",
        { retries: { limit: 1, delay: "5 seconds", backoff: "linear" }, timeout: "30 seconds" },
        async () => {
          await broadcastPresence(this.env, "new-note");
          return { notified: true };
        },
      );
    } catch (error) {
      console.warn(
        "The approved note could not be pushed to connected visitors",
        errorType(error),
      );
    }

    if (
      this.env.EMAIL_NOTIFICATIONS_ENABLED === "true" &&
      this.env.EMAIL &&
      this.env.EMAIL_FROM &&
      this.env.EMAIL_TO
    ) {
      try {
        await step.do(
          "email-approval-notification",
          { retries: { limit: 1, delay: "5 seconds", backoff: "linear" }, timeout: "30 seconds" },
          async () => {
            await notifyModeratorOfApproval(this.env);
            return { sent: true };
          },
        );
      } catch (error) {
        console.warn(
          "The approved note was published but its email notice failed",
          errorType(error),
        );
      }
    }

    let shareCardReady = false;
    try {
      const cardKey = await step.do(
        "render-share-card",
        { retries: { limit: 1, delay: "15 seconds", backoff: "linear" }, timeout: "90 seconds" },
        async () => {
          const key = await generateShareCard(this.env, messageId);
          if (key) await broadcastPresence(this.env, "share-card-ready");
          return key;
        },
      );
      shareCardReady = cardKey !== null;
    } catch (error) {
      console.warn(
        "The note was approved but its share card could not be rendered",
        messageId,
        errorType(error),
      );
    }

    return { status: "approved", shareCardReady };
  }
}
