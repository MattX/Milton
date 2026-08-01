import { makeExcerpt, markdownToPlainText, titleFromMarkdown } from "./content";
import { runtimeLimits } from "./limits";
import type { Env, ExtractionMessage } from "./types";

interface ExtractionRow {
  article_id: number;
  normalized_url: string;
  title: string;
  priority: number;
  attempts: number;
  extraction_status: string;
}

interface MarkdownResponse {
  success?: boolean;
  result?: string;
  errors?: Array<{ message?: string }>;
}

export async function consumeExtractionQueue(
  batch: MessageBatch<ExtractionMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await consumeMessage(message, env);
  }
}

async function consumeMessage(message: Message<ExtractionMessage>, env: Env): Promise<void> {
  const job = await env.DB.prepare(
    `SELECT j.article_id, j.priority, j.attempts,
            a.normalized_url, a.title, a.extraction_status
     FROM extraction_jobs j JOIN articles a ON a.id = j.article_id
     WHERE j.article_id = ?`,
  ).bind(message.body.articleId).first<ExtractionRow>();

  if (!job || job.extraction_status === "indexed") {
    if (job) await markJob(env.DB, job.article_id, "completed", null);
    message.ack();
    return;
  }

  const limits = runtimeLimits(env);
  const usage = await browserUsageToday(env.DB);
  const allowed = job.priority === 0
    ? limits.browserDailyLimitMs
    : limits.backfillDailyBudgetMs;
  if (usage >= allowed) {
    message.retry({ delaySeconds: secondsUntilTomorrowUtc() });
    return;
  }

  const nextSlot = await getSystemNumber(env.DB, "browser_next_allowed_at");
  const now = Date.now();
  if (nextSlot > now) {
    message.retry({ delaySeconds: Math.max(1, Math.ceil((nextSlot - now) / 1000)) });
    return;
  }
  await setSystemNumber(env.DB, "browser_next_allowed_at", now + 10_000);

  const attempt = job.attempts + 1;
  await env.DB.prepare(
    `UPDATE extraction_jobs
     SET status = 'processing', attempts = ?, updated_at = ?
     WHERE article_id = ?`,
  ).bind(attempt, new Date().toISOString(), job.article_id).run();

  try {
    const response = await env.BROWSER.quickAction("markdown", {
      url: job.normalized_url,
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

    const body = markdownToPlainText(payload.result);
    if (!body) throw new Error("Browser Run returned no readable text");
    const title = titleFromMarkdown(payload.result) || job.title;
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE articles SET
          title = ?, body = ?, excerpt = ?, extraction_status = 'indexed',
          extraction_error = NULL, updated_at = ?
         WHERE id = ?`,
      ).bind(title, body, makeExcerpt(body), nowIso, job.article_id),
      env.DB.prepare(
        `UPDATE extraction_jobs SET
          status = 'completed', last_error = NULL, updated_at = ?
         WHERE article_id = ?`,
      ).bind(nowIso, job.article_id),
    ]);
    message.ack();
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 1000) : "Unknown extraction error";
    const finalAttempt = attempt >= 3;
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE extraction_jobs SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
         WHERE article_id = ?`,
      ).bind(
        finalAttempt ? "failed" : "enqueued",
        detail,
        finalAttempt ? null : new Date(Date.now() + 60_000 * 2 ** (attempt - 1)).toISOString(),
        nowIso,
        job.article_id,
      ),
      env.DB.prepare(
        `UPDATE articles SET extraction_status = ?, extraction_error = ?, updated_at = ? WHERE id = ?`,
      ).bind(finalAttempt ? "failed" : "pending", detail, nowIso, job.article_id),
    ]);
    if (finalAttempt) {
      console.error("Extraction permanently failed", job.article_id, detail);
      message.retry();
    } else {
      message.retry({ delaySeconds: 60 * 2 ** (attempt - 1) });
    }
  }
}

async function browserUsageToday(db: D1Database): Promise<number> {
  const date = new Date().toISOString().slice(0, 10);
  const row = await db.prepare("SELECT milliseconds FROM browser_usage WHERE usage_date = ?")
    .bind(date).first<{ milliseconds: number }>();
  return row?.milliseconds ?? 0;
}

async function recordBrowserUsage(db: D1Database, rawMilliseconds: string | null): Promise<void> {
  const milliseconds = Number(rawMilliseconds);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  await db.prepare(
    `INSERT INTO browser_usage(usage_date, milliseconds, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(usage_date) DO UPDATE SET
       milliseconds = browser_usage.milliseconds + excluded.milliseconds,
       updated_at = excluded.updated_at`,
  ).bind(date, Math.round(milliseconds), now.toISOString()).run();
}

async function getSystemNumber(db: D1Database, key: string): Promise<number> {
  const row = await db.prepare("SELECT value FROM system_state WHERE key = ?")
    .bind(key).first<{ value: string }>();
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : 0;
}

async function setSystemNumber(db: D1Database, key: string, value: number): Promise<void> {
  await db.prepare(
    `INSERT INTO system_state(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, String(value), new Date().toISOString()).run();
}

async function markJob(
  db: D1Database,
  articleId: number,
  status: "completed",
  error: string | null,
): Promise<void> {
  await db.prepare(
    "UPDATE extraction_jobs SET status = ?, last_error = ?, updated_at = ? WHERE article_id = ?",
  ).bind(status, error, new Date().toISOString(), articleId).run();
}

function secondsUntilTomorrowUtc(): number {
  const now = new Date();
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.min(86_400, Math.max(60, Math.ceil((tomorrow - now.getTime()) / 1000) + 5));
}
