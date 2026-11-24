import { handleApi } from "./routes/api";
import { handleMedia } from "./routes/media";
import { json, secureResponse } from "./lib/http";
import { handleModerationQueue } from "./services/moderation";
import { logPendingBacklogSummary } from "./services/scheduled-health";
import { handleRoutedGuestbookEmail } from "./services/email-routing";
import { backfillApprovedVectors } from "./services/vector-index";
import { backfillApprovedAiSearchMessages } from "./services/ai-search-index";
import { errorType } from "./lib/logging";
import type { Environment, ModerationJob, QueueBatch } from "./types";

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/presence") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (request.headers.get("Origin") !== url.origin) {
        return secureResponse(new Response("Origin not allowed", { status: 403 }), url);
      }
      try {
        return secureResponse(
          await env.PRESENCE.getByName("passing-place").fetch(request),
          url,
        );
      } catch (error) {
        console.error("Presence connection error", errorType(error));
        return secureResponse(
          json({ error: "Live visitor updates are temporarily unavailable." }, 503),
          url,
        );
      }
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return secureResponse(await handleApi(request, env, url), url);
      } catch (error) {
        console.error("Guestbook API error", errorType(error));
        return secureResponse(
          json(
            {
              error: "The guestbook is temporarily unavailable. Try again soon.",
            },
            500,
          ),
          url,
        );
      }
    }

    if (url.pathname.startsWith("/media/") || url.pathname.startsWith("/share-cards/")) {
      try {
        return secureResponse(await handleMedia(request, env, url), url);
      } catch (error) {
        console.error("Guestbook photo error", errorType(error));
        return secureResponse(
          new Response("The photo is temporarily unavailable.", { status: 500 }),
          url,
        );
      }
    }

    return secureResponse(await env.ASSETS.fetch(request), url);
  },

  async queue(batch: QueueBatch<ModerationJob>, env: Environment): Promise<void> {
    await handleModerationQueue(batch, env);
  },

  async email(message: ForwardableEmailMessage, env: Environment): Promise<void> {
    try {
      await handleRoutedGuestbookEmail(message, env);
    } catch (error) {
      console.error("Routed guestbook email failed", errorType(error));
      throw new Error("Email note processing failed");
    }
  },

  async scheduled(controller: ScheduledController, env: Environment): Promise<void> {
    const work: Promise<unknown>[] = [
      logPendingBacklogSummary(env, controller.scheduledTime, controller.cron),
    ];
    if (env.VECTORIZE_ENABLED === "true" && env.VECTORIZE) {
      work.push(
        backfillApprovedVectors(env)
          .then((indexedCount) => {
            if (indexedCount > 0) {
              console.info("Vector search backfill completed", { indexedCount });
            }
          })
          .catch((error: unknown) =>
            console.warn("Vector search backfill failed", errorType(error)),
          ),
      );
    }
    if (
      env.AI_SEARCH_ENABLED === "true" &&
      env.AI_SEARCH &&
      env.AI_SEARCH_INSTANCE
    ) {
      work.push(
        backfillApprovedAiSearchMessages(env)
          .then((indexedCount) => {
            if (indexedCount > 0) {
              console.info("AI Search backfill completed", { indexedCount });
            }
          })
          .catch((error: unknown) =>
            console.warn("AI Search backfill failed", errorType(error)),
          ),
      );
    }
    await Promise.all(work);
  },
};

export { PresenceHub } from "./durable-objects/presence-hub";
export { ModerationWorkflow } from "./workflows/moderation-workflow";
