import { makeExcerpt, markdownToPlainText, titleFromMarkdown } from "./content";
import { browserUsageToday, utcDay } from "./database";
import { runtimeLimits } from "./limits";
import { BROWSER_NEXT_SLOT, getNumber, setNumber } from "./state";
import type { Env, ExtractionMessage } from "./types";

const MAX_ATTEMPTS = 3;
/** Minimum spacing between Browser Run calls, to stay polite under a shared quota. */
const BROWSER_SLOT_MS = 10_000;

interface ExtractionRow {
  article_id: number;
  normalized_url: string;
  title: string;
  priority: number;
  attempts: number;
  status: string;
  extraction_status: string;
}

interface MarkdownResponse {
  success?: boolean;
  result?: string;
  errors?: Array<{ message?: string }>;
}

/**
 * Queue messages are only a wake-up nudge: `extraction_jobs.next_attempt_at` is the
 * real schedule. Every outcome acknowledges the message and records the next step in
 * D1, so deferring for quota or backoff never burns a queue retry and never leaves a
 * second copy of the same job in flight. Unexpected errors deliberately escape, which
 * leaves the message unacknowledged for the queue to redeliver.
 */
export async function consumeExtractionQueue(
  batch: MessageBatch<ExtractionMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await runExtractionJob(env, message.body.articleId);
    message.ack();
  }
}

async function runExtractionJob(env: Env, articleId: number): Promise<void> {
  const job = await env.DB.prepare(
    `SELECT j.article_id, j.priority, j.attempts, j.status,
            a.normalized_url, a.title, a.extraction_status
     FROM extraction_jobs j JOIN articles a ON a.id = j.article_id
     WHERE j.article_id = ?`,
  ).bind(articleId).first<ExtractionRow>();

  if (!job || job.status === "completed" || job.status === "failed") return;
  if (job.extraction_status === "indexed") {
    await finishJob(env.DB, articleId, "completed", null);
    return;
  }

  const limits = runtimeLimits(env);
  const budget = job.priority === 0 ? limits.browserDailyLimitMs : limits.backfillDailyBudgetMs;
  if (await browserUsageToday(env.DB) >= budget) {
    await deferJob(env.DB, articleId, startOfNextUtcDay());
    return;
  }

  const slot = await getNumber(env.DB, BROWSER_NEXT_SLOT);
  if (slot > Date.now()) {
    await deferJob(env.DB, articleId, new Date(slot));
    return;
  }
  await setNumber(env.DB, BROWSER_NEXT_SLOT, Date.now() + BROWSER_SLOT_MS);

  const attempt = job.attempts + 1;
  await env.DB.prepare(
    `UPDATE extraction_jobs SET status = 'processing', attempts = ?, updated_at = ?
     WHERE article_id = ?`,
  ).bind(attempt, new Date().toISOString(), articleId).run();

  try {
    const body = await extractArticle(env, job.normalized_url);
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE articles SET title = ?, body = ?, excerpt = ?,
           extraction_status = 'indexed', updated_at = ?
         WHERE id = ?`,
      ).bind(body.title || job.title, body.text, makeExcerpt(body.text), nowIso, articleId),
      env.DB.prepare(
        "UPDATE extraction_jobs SET status = 'completed', last_error = NULL, updated_at = ? WHERE article_id = ?",
      ).bind(nowIso, articleId),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 1000) : "Unknown extraction error";
    if (attempt >= MAX_ATTEMPTS) {
      console.error("Milton gave up extracting", articleId, job.normalized_url, detail);
      await Promise.all([
        finishJob(env.DB, articleId, "failed", detail),
        env.DB.prepare("UPDATE articles SET extraction_status = 'failed', updated_at = ? WHERE id = ?")
          .bind(new Date().toISOString(), articleId).run(),
      ]);
      return;
    }
    await deferJob(env.DB, articleId, new Date(Date.now() + 60_000 * 2 ** (attempt - 1)), detail);
  }
}

async function extractArticle(env: Env, url: string): Promise<{ title: string | null; text: string }> {
  const response = await env.BROWSER.quickAction("markdown", {
    url,
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 30_000 },
    actionTimeout: 30_000,
    rejectResourceTypes: ["image", "media", "font", "stylesheet"],
  });
  await recordBrowserUsage(env.DB, response.headers.get("x-browser-ms-used"));

  const payload = await response.json<MarkdownResponse>();
  if (!response.ok || payload.success === false || typeof payload.result !== "string") {
    const detail = payload.errors?.map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(detail || `Browser Run returned HTTP ${response.status}`);
  }

  const text = markdownToPlainText(payload.result);
  if (!text) throw new Error("Browser Run returned no readable text");
  return { title: titleFromMarkdown(payload.result), text };
}

/** Hand the job back to the cron dispatcher instead of holding a queue retry open. */
function deferJob(
  db: D1Database,
  articleId: number,
  nextAttemptAt: Date,
  error: string | null = null,
): Promise<D1Result> {
  return db.prepare(
    `UPDATE extraction_jobs
     SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE article_id = ?`,
  ).bind(nextAttemptAt.toISOString(), error, new Date().toISOString(), articleId).run();
}

function finishJob(
  db: D1Database,
  articleId: number,
  status: "completed" | "failed",
  error: string | null,
): Promise<D1Result> {
  return db.prepare(
    `UPDATE extraction_jobs
     SET status = ?, last_error = ?, next_attempt_at = NULL, updated_at = ?
     WHERE article_id = ?`,
  ).bind(status, error, new Date().toISOString(), articleId).run();
}

async function recordBrowserUsage(db: D1Database, rawMilliseconds: string | null): Promise<void> {
  const milliseconds = Number(rawMilliseconds);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  const now = new Date();
  await db.prepare(
    `INSERT INTO browser_usage(usage_date, milliseconds, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(usage_date) DO UPDATE SET
       milliseconds = browser_usage.milliseconds + excluded.milliseconds,
       updated_at = excluded.updated_at`,
  ).bind(utcDay(now), Math.round(milliseconds), now.toISOString()).run();
}

function startOfNextUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
