export type ModerationStatus = "pending" | "approved" | "rejected" | "unavailable";

export type Environment = Omit<
  Cloudflare.Env,
  "EMAIL"
  | "EMAIL_NOTIFICATIONS_ENABLED"
  | "EMAIL_ROUTING_ENABLED"
  | "EMAIL_ROUTING_ADDRESS"
  | "HYPERDRIVE_DEMO_ENABLED"
  | "HYPERDRIVE"
  | "AI_SEARCH"
  | "AI_SEARCH_ENABLED"
  | "AI_SEARCH_INSTANCE"
  | "VECTORIZE"
  | "VECTORIZE_ENABLED"
  | "ZARAZ_ENABLED"
  | "ZARAZ_CONSENT_PURPOSE_ID"
> & {
  TURNSTILE_SECRET_KEY?: string;
  EMAIL?: SendEmail;
  EMAIL_NOTIFICATIONS_ENABLED?: string;
  EMAIL_FROM?: string;
  EMAIL_TO?: string;
  EMAIL_ROUTING_ENABLED?: string;
  EMAIL_ROUTING_ADDRESS?: string;
  HYPERDRIVE?: Hyperdrive;
  HYPERDRIVE_DEMO_ENABLED?: string;
  AI_SEARCH?: AiSearchNamespace;
  AI_SEARCH_ENABLED?: string;
  AI_SEARCH_INSTANCE?: string;
  VECTORIZE?: Vectorize;
  VECTORIZE_ENABLED?: string;
  ZARAZ_ENABLED?: string;
  ZARAZ_CONSENT_PURPOSE_ID?: string;
};

export type QueueMessage<T> = Message<T>;
export type QueueBatch<T> = MessageBatch<T>;

export interface GuestbookMessage {
  id: string;
  name: string;
  message: string;
  created_at: string;
  image_key: string | null;
  share_card_key: string | null;
  status: ModerationStatus;
}

export interface PublicMessage
  extends Omit<GuestbookMessage, "image_key" | "share_card_key" | "status"> {
  imageUrl: string | null;
  shareCardUrl: string | null;
}

export interface ModerationJob {
  messageId: string;
  manualDecision?: "approve" | "reject";
  actionId?: string;
}

export interface QueueResult {
  response?: string;
  answer?: string;
}

export interface CachedGuestbook {
  messages: PublicMessage[];
  total: number;
}

export interface ModerationStatusResult {
  status: ModerationStatus;
}
