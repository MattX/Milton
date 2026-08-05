export interface Config {
  projectId: string;
  firestoreDatabaseId: string;
  location: string;
  serviceUrl: string;
  liveTaskQueue: string;
  historyTaskQueue: string;
  commandTaskQueue: string;
  taskServiceAccount: string;
  internalServiceAccounts: Set<string>;
  discordApplicationId: string;
  discordClientSecret: string;
  discordBotToken: string;
  discordGuildId: string;
  discordPublicKey: string;
  adminDiscordUserIds: Set<string>;
  sessionSecret: string;
  openRouterApiKey: string;
  openRouterModel: string;
  openRouterReasoningEffort: "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
  allowUnauthenticatedInternal: boolean;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: DiscordUser;
}

export interface DiscordChannel {
  id: string;
  name?: string;
  type: number;
  last_message_id?: string | null;
  thread_metadata?: { archive_timestamp?: string };
}

export interface DiscordThreadList {
  threads: DiscordChannel[];
  has_more?: boolean;
}

export interface LatestOccurrence {
  channelId: string;
  channelName: string;
  authorName: string;
  postedAt: string;
  messageUrl: string;
}

export type ExtractionStatus = "pending" | "indexed" | "failed";
export type JobStatus = "pending" | "processing" | "completed" | "failed";
export type JobPriority = "live" | "history";

export type ExtractionFailureClass =
  | "invalid_url" | "private_address" | "dns_failure" | "timeout" | "redirect_limit"
  | "http_error" | "bot_block" | "non_html" | "body_too_large" | "malformed_html"
  | "insufficient_content" | "network_error" | "parse_resource_limit" | "retry_exhausted";

/** A successful extraction, as returned by the extractor and stored on the article. */
export interface ExtractedArticle {
  title: string | null;
  description: string;
  body: string;
  excerpt: string;
  method: "readability" | "json-ld" | "metadata";
  httpStatus: number;
  contentLength: number;
  hostname: string;
}

/** A failed extraction, as stored on the article and its job. */
export interface ExtractionFailure {
  failureClass: ExtractionFailureClass;
  message: string;
  httpStatus: number | null;
  contentLength: number | null;
  hostname: string;
}

export interface ArticleDocument {
  normalizedUrl: string;
  domain: string;
  title: string;
  description: string;
  body: string;
  excerpt: string;
  extractionStatus: ExtractionStatus;
  extractionMethod: string | null;
  extractionFailureClass: string | null;
  extractionHttpStatus: number | null;
  extractionContentLength: number | null;
  extractionHostname: string;
  lastPostedAt: string;
  latestOccurrence: LatestOccurrence;
  createdAt: string;
  updatedAt: string;
}

export interface RecentArticle {
  id: string;
  data: ArticleDocument;
}

export interface DigestTaskPayload {
  interactionId: string;
  interactionToken: string;
  userId: string;
  days: number;
  invokedAt: string;
}

export interface ExtractionJobDocument {
  articleId: string;
  priority: JobPriority;
  taskGeneration: number;
  taskPriority: JobPriority;
  taskDispatchState: "needs_dispatch" | "dispatched";
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  processingStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One Discord channel or thread. `liveAfterId` walks forward from the newest seen message;
 * `backfillBeforeId` walks backward through history until `backfillComplete`.
 */
export interface ChannelCursorDocument {
  channelId: string;
  channelName: string;
  isThread: boolean;
  archived: boolean;
  liveAfterId: string;
  backfillBeforeId: string | null;
  backfillComplete: boolean;
  archivedThreadScanBefore: string | null;
  archivedThreadScanComplete: boolean;
  updatedAt: string;
}
