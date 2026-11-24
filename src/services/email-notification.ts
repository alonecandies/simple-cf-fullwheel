import type { Environment } from "../types";

/** Send a content-free notice to the operator after a note is approved. */
export async function notifyModeratorOfApproval(env: Environment): Promise<void> {
  if (
    env.EMAIL_NOTIFICATIONS_ENABLED !== "true" ||
    !env.EMAIL ||
    !env.EMAIL_FROM ||
    !env.EMAIL_TO
  ) {
    return;
  }

  await env.EMAIL.send({
    from: env.EMAIL_FROM,
    to: env.EMAIL_TO,
    subject: "A Passing Place note was approved",
    text: "A guestbook note passed moderation and is now visible on Passing Place.",
  });
}
