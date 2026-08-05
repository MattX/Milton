export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface OccurrenceResult {
  channelName: string;
  authorName: string;
  postedAt: string;
  messageUrl: string;
}

export interface ArticleResult {
  id: string;
  title: string;
  url: string;
  domain: string;
  excerpt: string;
  extractionStatus: "pending" | "indexed" | "failed";
  latestOccurrence: OccurrenceResult;
}

export interface SearchResponse {
  items: ArticleResult[];
  nextCursor: string | null;
}

export interface AdminStatus {
  backfillEnabled: boolean;
  pendingLiveJobs: number;
  pendingBackfillJobs: number;
  failedJobs: number;
  channelsComplete: number;
  channelsTotal: number;
}

export interface FailedJobResult {
  articleId: string;
  title: string;
  url: string | null;
  domain: string | null;
  reason: string;
  failureClass: string | null;
  httpStatus: number | null;
  attempts: number;
  priority: "live" | "history";
  failedAt: string;
}
