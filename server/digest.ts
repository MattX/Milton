import type { Repository } from "./repository.js";
import type { ArticleSummarizer } from "./openrouter.js";
import type { Config, DigestTaskPayload, RecentArticle } from "./types.js";

const DISCORD_API = "https://discord.com/api/v10";
const ARTICLE_LIMIT = 25;
const LOCK_MS = 5 * 60_000;
const MESSAGE_CHARACTER_LIMIT = 2_000;
const SUMMARY_CHARACTER_LIMIT = 240;
const SUPPRESS_EMBEDS = 1 << 2;

interface DiscordMessagePayload {
  content?: string;
  flags?: number;
  allowed_mentions: { parse: never[] };
}

export interface DiscordResponder {
  editOriginal(token: string, payload: DiscordMessagePayload): Promise<void>;
  createFollowup(token: string, payload: DiscordMessagePayload): Promise<void>;
}

export class DiscordWebhookResponder implements DiscordResponder {
  constructor(private readonly applicationId: string, private readonly fetchFn: typeof fetch = fetch) {}

  editOriginal(token: string, payload: DiscordMessagePayload): Promise<void> {
    return this.send(`${DISCORD_API}/webhooks/${this.applicationId}/${token}/messages/@original`, "PATCH", payload);
  }

  createFollowup(token: string, payload: DiscordMessagePayload): Promise<void> {
    return this.send(`${DISCORD_API}/webhooks/${this.applicationId}/${token}`, "POST", payload);
  }

  private async send(url: string, method: string, payload: DiscordMessagePayload): Promise<void> {
    const response = await this.fetchFn(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Discord webhook failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
}

export class DigestService {
  constructor(
    private readonly repository: Repository,
    private readonly summarizer: ArticleSummarizer,
    private readonly responder: DiscordResponder,
    private readonly config: Config,
  ) {}

  async run(payload: DigestTaskPayload): Promise<void> {
    const startedAt = Date.now();
    const lockId = `digest-${this.config.discordGuildId}-${payload.userId}`;
    const locked = await this.repository.claimCommandLock(
      lockId, payload.interactionId, new Date(startedAt + LOCK_MS).toISOString(),
    );
    if (!locked) {
      await this.responder.editOriginal(payload.interactionToken, message("You already have a digest running. Try again when it finishes."));
      return;
    }

    try {
      const since = cutoff(payload.invokedAt, payload.days);
      const recent = await this.repository.listRecentArticles(since, ARTICLE_LIMIT);
      if (!recent.items.length) {
        await this.responder.editOriginal(payload.interactionToken, message(`No links were posted in the last ${payload.days} day${payload.days === 1 ? "" : "s"}.`));
        return;
      }

      let summaries = new Map<string, string>();
      try {
        summaries = await this.summarizer.summarize(recent.items);
      } catch (error) {
        console.error("OpenRouter digest summarization failed; using excerpts", error);
      }
      const messages = renderDigest(payload.days, recent.items, recent.total, summaries);
      await this.responder.editOriginal(payload.interactionToken, messages[0]!);
      for (const followup of messages.slice(1)) await this.responder.createFollowup(payload.interactionToken, followup);
      console.info("Discord digest complete", {
        days: payload.days, matched: recent.total, rendered: recent.items.length, durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.error("Discord digest failed", error);
      try {
        await this.responder.editOriginal(payload.interactionToken, message("Milton could not build that digest. Please try again."));
      } catch (responseError) {
        console.error("Could not report Discord digest failure", responseError);
      }
    } finally {
      await this.repository.releaseCommandLock(lockId, payload.interactionId);
    }
  }
}

export function cutoff(invokedAt: string, days: number): string | null {
  const invoked = Date.parse(invokedAt);
  const milliseconds = days * 24 * 60 * 60_000;
  const value = invoked - milliseconds;
  if (!Number.isFinite(invoked) || !Number.isFinite(value) || value < -8_640_000_000_000_000) return null;
  return new Date(value).toISOString();
}

export function renderDigest(
  days: number,
  articles: RecentArticle[],
  total: number,
  summaries: Map<string, string>,
): DiscordMessagePayload[] {
  const omitted = Math.max(0, total - articles.length);
  const heading = `**Link digest · last ${days} day${days === 1 ? "" : "s"}**\n${total} link${total === 1 ? "" : "s"} found${omitted ? `; showing the newest ${articles.length} (${omitted} omitted)` : ""}.`;
  const continuationHeading = "**Link digest · continued**";
  const chunks: string[] = [];
  let content = heading;
  for (const article of articles) {
    const bullet = articleBullet(article, summaries.get(article.id));
    if (`${content}\n${bullet}`.length > MESSAGE_CHARACTER_LIMIT) {
      chunks.push(content);
      content = `${continuationHeading}\n${bullet}`;
    } else {
      content += `\n${bullet}`;
    }
  }
  chunks.push(content);
  return chunks.map((chunk) => message(chunk, true));
}

function articleBullet({ data }: RecentArticle, generated: string | undefined): string {
  const fallback = data.extractionStatus === "pending"
    ? "Content extraction is still pending."
    : data.extractionStatus === "failed"
      ? "Milton could not extract this page."
      : data.description || data.excerpt || "No summary is available for this page.";
  const title = escapeMarkdown(truncate(singleLine(data.title || data.domain), 100));
  const summary = escapeMarkdown(truncate(singleLine(generated || fallback), SUMMARY_CHARACTER_LIMIT));
  const page = markdownLink(title, data.normalizedUrl);
  const discussion = markdownLink("discussion", data.latestOccurrence.messageUrl);
  return `- ${page} — ${summary} (${discussion})`;
}

function message(content: string, suppressEmbeds = false): DiscordMessagePayload {
  return { content, ...(suppressEmbeds ? { flags: SUPPRESS_EMBEDS } : {}), allowed_mentions: { parse: [] } };
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\*_~`|>\[\]()])/g, "\\$1");
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function markdownLink(label: string, value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return label;
    const destination = url.href.replaceAll("(", "%28").replaceAll(")", "%29");
    return `[${label}](${destination})`;
  } catch {
    return label;
  }
}
