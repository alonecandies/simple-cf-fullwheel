import { clearMessageCache, getMessage, purgeMessage } from "./guestbook";
import { isUuidV4 } from "../lib/ids";
import { errorType } from "../lib/logging";
import type { Environment, ModerationJob, QueueBatch, QueueResult } from "../types";

const MODERATION_QUEUE_NAME = "passing-place-moderation";
const MODERATION_DEAD_LETTER_QUEUE_NAME = "passing-place-moderation-dead";
const TEXT_MODERATION_MODEL = "@cf/meta/llama-guard-3-8b";
const IMAGE_MODERATION_MODEL = "@cf/moondream/moondream3.1-9B-A2B";

export interface ModerationOutcome {
  status: "approved" | "rejected" | "unavailable" | "missing";
}

export interface ManualDecisionResult {
  outcome: ModerationOutcome;
  applied: boolean;
}

interface ModerationActionRow {
  id: string;
  message_id: string;
  decision: "approve" | "reject";
  status: "queued" | "applying" | "applied" | "conflict" | "failed";
}

function outcomeForStatus(
  status: "pending" | "approved" | "rejected" | "unavailable" | undefined,
): ModerationOutcome {
  if (!status) return { status: "missing" };
  if (status === "pending") return { status: "missing" };
  return { status };
}

function approvedAiAnswer(value: string | undefined): boolean {
  return typeof value === "string" && /^\s*safe(?:\s|$)/i.test(value);
}

async function moderateText(env: Environment, name: string, message: string): Promise<boolean> {
  const response = (await env.AI.run(TEXT_MODERATION_MODEL, {
    messages: [
      {
        role: "user",
        content:
          "Task: Check if there is unsafe content in 'User' messages in the " +
          "conversation according to this policy: flag hateful or discriminatory " +
          "language, sexual content, violence, threats, personal contact details, " +
          "or spam. Reply with exactly safe or unsafe, followed by a category only " +
          "if unsafe.\n<BEGIN CONVERSATION>\nUser: " +
          `Name: ${name}\nNote: ${message}` +
          "\n<END CONVERSATION>",
      },
    ],
    max_tokens: 64,
    temperature: 0,
  }, {
    gateway: { id: "default" },
    extraHeaders: { "cf-aig-collect-log-payload": "false" },
  })) as QueueResult;

  return approvedAiAnswer(response.response);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

async function moderateImage(
  env: Environment,
  image: ArrayBuffer,
  contentType: string,
): Promise<boolean> {
  const dataUri = `data:${contentType};base64,${arrayBufferToBase64(image)}`;
  const response = (await env.AI.run(IMAGE_MODERATION_MODEL, {
    task: "query",
    image: dataUri,
    question:
      "Does this image contain nudity, sexual content, graphic injury, violence, " +
      "hateful symbols, visible private contact information, or anything clearly " +
      "unsuitable for a public guestbook? Answer SAFE or UNSAFE and nothing else.",
    reasoning: false,
    max_tokens: 24,
    temperature: 0,
    stream: false,
  }, {
    gateway: { id: "default" },
    extraHeaders: { "cf-aig-collect-log-payload": "false" },
  })) as QueueResult;

  return approvedAiAnswer(response.answer);
}

export async function moderateGuestbookMessage(
  env: Environment,
  id: string,
): Promise<ModerationOutcome> {
  const entry = await getMessage(env, id);
  if (!entry) return { status: "missing" };
  if (entry.status === "approved") return { status: "approved" };
  if (entry.status !== "pending") return { status: entry.status };

  const textIsSafe = await moderateText(env, entry.name, entry.message);
  let imageIsSafe = true;

  if (textIsSafe && entry.image_key) {
    const object = await env.PHOTOS.get(entry.image_key);
    if (!object) throw new Error(`Photo for message ${id} is missing from R2`);

    const image = await new Response(object.body).arrayBuffer();
    const contentType = object.httpMetadata?.contentType;
    if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      throw new Error(`Photo for message ${id} has an unsupported content type`);
    }

    imageIsSafe = await moderateImage(env, image, contentType);
  }

  if (!textIsSafe || !imageIsSafe) {
    await purgeMessage(env, id, "rejected");
    return { status: "rejected" };
  }

  const update = await env.DB.prepare(
    "UPDATE messages SET status = 'approved' WHERE id = ? AND status = 'pending'",
  )
    .bind(id)
    .run();
  if (update.meta.changes !== 1) {
    const current = await getMessage(env, id);
    if (!current) return { status: "missing" };
    if (current.status === "pending") return { status: "unavailable" };
    return { status: current.status };
  }
  await clearMessageCache(env);
  return { status: "approved" };
}

export async function applyManualDecision(
  env: Environment,
  messageId: string,
  actionId: string,
  decision: "approve" | "reject",
): Promise<ManualDecisionResult> {
  const action = await env.DB.prepare(
    "SELECT id, message_id, decision, status FROM moderation_actions WHERE id = ? LIMIT 1",
  )
    .bind(actionId)
    .first<ModerationActionRow>();

  if (
    !action ||
    action.message_id !== messageId ||
    action.decision !== decision
  ) {
    return { outcome: { status: "missing" }, applied: false };
  }

  const expectedStatus = decision === "approve" ? "approved" : "rejected";
  if (action.status === "applied") {
    return { outcome: { status: expectedStatus }, applied: false };
  }
  if (action.status === "conflict" || action.status === "failed") {
    const current = await getMessage(env, messageId);
    return { outcome: outcomeForStatus(current?.status), applied: false };
  }

  if (action.status === "queued") {
    const changeMessage = decision === "approve"
      ? `UPDATE messages
         SET status = 'approved'
         WHERE id = ? AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM moderation_actions
             WHERE id = ? AND message_id = ? AND decision = 'approve' AND status = 'applying'
           )`
      : `UPDATE messages
         SET status = 'rejected', name = '', message = ''
         WHERE id = ? AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM moderation_actions
             WHERE id = ? AND message_id = ? AND decision = 'reject' AND status = 'applying'
           )`;

    const [actionUpdate, messageUpdate] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE moderation_actions
         SET status = 'applying'
         WHERE id = ? AND message_id = ? AND decision = ? AND status = 'queued'
           AND EXISTS (
             SELECT 1 FROM messages WHERE id = ? AND status = 'pending'
           )`,
      ).bind(actionId, messageId, decision, messageId),
      env.DB.prepare(changeMessage).bind(messageId, actionId, messageId),
    ]);

    if (actionUpdate.meta.changes !== 1 || messageUpdate.meta.changes !== 1) {
      await env.DB.prepare(
        "UPDATE moderation_actions SET status = 'conflict', completed_at = ? WHERE id = ? AND status IN ('queued', 'applying')",
      )
        .bind(new Date().toISOString(), actionId)
        .run();
      const current = await getMessage(env, messageId);
      return { outcome: outcomeForStatus(current?.status), applied: false };
    }
  }

  const current = await getMessage(env, messageId);
  if (current?.status !== expectedStatus) {
    await env.DB.prepare(
      "UPDATE moderation_actions SET status = 'conflict', completed_at = ? WHERE id = ? AND status = 'applying'",
    )
      .bind(new Date().toISOString(), actionId)
      .run();
    return { outcome: outcomeForStatus(current?.status), applied: false };
  }

  if (decision === "reject" && current.image_key) {
    await env.PHOTOS.delete(current.image_key);
    await env.DB.prepare(
      "UPDATE messages SET image_key = NULL WHERE id = ? AND status = 'rejected' AND image_key = ?",
    )
      .bind(messageId, current.image_key)
      .run();
  }

  await clearMessageCache(env);
  await env.DB.prepare(
    "UPDATE moderation_actions SET status = 'applied', completed_at = ? WHERE id = ? AND status = 'applying'",
  )
    .bind(new Date().toISOString(), actionId)
    .run();

  return { outcome: { status: expectedStatus }, applied: true };
}

export async function handleModerationQueue(
  batch: QueueBatch<ModerationJob>,
  env: Environment,
): Promise<void> {
  if (batch.queue === MODERATION_DEAD_LETTER_QUEUE_NAME) {
    for (const message of batch.messages) {
      try {
        const hasManualFields =
          message.body?.manualDecision !== undefined || message.body?.actionId !== undefined;
        if (hasManualFields) {
          if (typeof message.body?.actionId === "string" && isUuidV4(message.body.actionId)) {
            await env.DB.prepare(
              "UPDATE moderation_actions SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'queued'",
            )
              .bind(new Date().toISOString(), message.body.actionId)
              .run();
          } else {
            console.error("Discarded an invalid manual moderation message from the dead-letter queue");
          }
        } else if (message.body && typeof message.body.messageId === "string") {
          await purgeMessage(env, message.body.messageId, "unavailable");
        }
        message.ack();
      } catch (error) {
        console.error("Could not clean up a failed moderation trigger", errorType(error));
        message.retry({ delaySeconds: 60 });
      }
    }
    return;
  }

  if (batch.queue !== MODERATION_QUEUE_NAME) {
    console.error("Received a message from an unknown queue", batch.queue);
    for (const message of batch.messages) message.ack();
    return;
  }

  for (const message of batch.messages) {
    const id = message.body?.messageId;
    if (typeof id !== "string" || !isUuidV4(id)) {
      message.ack();
      continue;
    }

    const manualDecision = message.body.manualDecision;
    const actionId = message.body.actionId;
    const hasManualFields = manualDecision !== undefined || actionId !== undefined;
    if (
      (hasManualFields && manualDecision !== "approve" && manualDecision !== "reject") ||
      (hasManualFields && (typeof actionId !== "string" || !isUuidV4(actionId)))
    ) {
      console.error("Discarded an invalid manual moderation message");
      message.ack();
      continue;
    }

    try {
      await env.MODERATION_WORKFLOW.create({
        id: manualDecision && actionId ? `manual-${actionId}` : id,
        params: {
          messageId: id,
          ...(manualDecision && actionId ? { manualDecision, actionId } : {}),
        },
      });
      message.ack();
    } catch (error) {
      if (error instanceof Error && error.message.includes("(instance.already_exists)")) {
        message.ack();
        continue;
      }
      console.error(
        "Could not start the moderation workflow; the queue will retry",
        errorType(error),
      );
      message.retry({ delaySeconds: 30 });
    }
  }
}

export async function markModerationUnavailable(
  env: Environment,
  id: string,
): Promise<void> {
  await purgeMessage(env, id, "unavailable");
}
