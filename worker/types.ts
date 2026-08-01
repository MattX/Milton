export interface BrowserRunBinding {
  quickAction(action: "markdown", options: Record<string, unknown>): Promise<Response>;
}

export interface Env {
  DB: D1Database;
  EXTRACTION_QUEUE: Queue<ExtractionMessage>;
  BROWSER: BrowserRunBinding;
  DISCORD_APPLICATION_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  ADMIN_DISCORD_USER_IDS: string;
  SESSION_SECRET: string;
  BROWSER_DAILY_LIMIT_MS?: string;
  BACKFILL_DAILY_BUDGET_MS?: string;
}

export interface ExtractionMessage {
  articleId: number;
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
