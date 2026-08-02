export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface OccurrenceResult {
  id: string;
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
  backfillPausedReason: string | null;
  pendingLiveJobs: number;
  pendingBackfillJobs: number;
  failedJobs: number;
  channelsComplete: number;
  channelsTotal: number;
}
