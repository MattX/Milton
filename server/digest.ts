import type { Repository } from "./repository.js";
import type { ArticleSummarizer } from "./openrouter.js";
import type { Config, DigestTaskPayload, RecentArticle } from "./types.js";

const DISCORD_API = "https://discord.com/api/v10";
const ARTICLE_LIMIT = 25;
const LOCK_MS = 5 * 60_000;
const EMBEDS_PER_MESSAGE = 10;
const EMBED_CHARACTER_BUDGET = 5_900;

interface DiscordEmbed {
  title: string;
  url?: string;
  description: string;
  footer: { text: string };
}

interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
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
  const embeds = articles.map((article) => articleEmbed(article, summaries.get(article.id)));
  const chunks: DiscordEmbed[][] = [];
  for (const embed of embeds) {
    let chunk = chunks.at(-1);
    if (!chunk || chunk.length >= EMBEDS_PER_MESSAGE || embedCharacters(chunk) + embedCharacters([embed]) > EMBED_CHARACTER_BUDGET) {
      chunk = [];
      chunks.push(chunk);
    }
    chunk.push(embed);
  }
  const omitted = Math.max(0, total - articles.length);
  const heading = `**Link digest · last ${days} day${days === 1 ? "" : "s"}**\n${total} link${total === 1 ? "" : "s"} found${omitted ? `; showing the newest ${articles.length} (${omitted} omitted)` : ""}.`;
  return chunks.map((chunk, index) => ({
    content: index === 0 ? heading : `**Link digest continued · ${index + 1}/${chunks.length}**`,
    embeds: chunk,
    allowed_mentions: { parse: [] },
  }));
}

function articleEmbed({ data }: RecentArticle, generated: string | undefined): DiscordEmbed {
  const fallback = data.extractionStatus === "pending"
    ? "Content extraction is still pending."
    : data.extractionStatus === "failed"
      ? "Milton could not extract this page; use the links below to review it directly."
      : data.excerpt || "No summary is available for this page.";
  const discussion = `[Discord discussion](${data.latestOccurrence.messageUrl})`;
  return {
    title: truncate(data.title || data.domain, 100),
    ...(isDiscordUrl(data.normalizedUrl) ? { url: data.normalizedUrl } : {}),
    description: `${truncate(escapeMarkdown(generated || fallback), 260)}\n${discussion}`,
    footer: { text: truncate(`${data.domain} · ${formatDate(data.lastPostedAt)}`, 80) },
  };
}

function embedCharacters(embeds: DiscordEmbed[]): number {
  return embeds.reduce((sum, embed) => sum + embed.title.length + embed.description.length + embed.footer.text.length, 0);
}

function message(content: string): DiscordMessagePayload {
  return { content, allowed_mentions: { parse: [] } };
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\*_~`|>\[\]()])/g, "\\$1");
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown date" : date.toISOString().slice(0, 10);
}

function isDiscordUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && value.length <= 2_048;
  } catch {
    return false;
  }
}
