export interface Config {
  projectId: string;
  firestoreDatabaseId: string;
  location: string;
  serviceUrl: string;
  liveTaskQueue: string;
  historyTaskQueue: string;
  taskServiceAccount: string;
  internalServiceAccounts: Set<string>;
  discordApplicationId: string;
  discordClientSecret: string;
  discordBotToken: string;
  discordGuildId: string;
  adminDiscordUserIds: Set<string>;
  sessionSecret: string;
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
  guild_id?: string;
  parent_id?: string | null;
  name?: string;
  type: number;
}

export interface DiscordThreadList {
  threads: DiscordChannel[];
}

export interface LatestOccurrence {
  id: string;
  channelId: string;
  channelName: string;
  authorName: string;
  postedAt: string;
  messageUrl: string;
}

export type ExtractionStatus = "pending" | "indexed" | "failed";
export type JobStatus = "pending" | "processing" | "completed" | "failed";
export type JobPriority = "live" | "history";

export interface ArticleDocument {
  normalizedUrl: string;
  domain: string;
  title: string;
  body: string;
  excerpt: string;
  extractionStatus: ExtractionStatus;
  extractionMethod: string | null;
  extractionFailureClass: string | null;
  extractionHttpStatus: number | null;
  extractionContentLength: number | null;
  extractionHostname: string;
  firstPostedAt: string;
  lastPostedAt: string;
  latestOccurrence: LatestOccurrence;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionJobDocument {
  articleId: string;
  priority: JobPriority;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  processingStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelCursorDocument {
  channelId: string;
  guildId: string;
  parentId: string | null;
  channelName: string;
  isThread: boolean;
  liveAfterId: string | null;
  backfillBeforeId: string | null;
  backfillComplete: boolean;
  initialized: boolean;
  updatedAt: string;
}

export interface ExtractionTaskPayload {
  articleId: string;
}
