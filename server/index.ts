import path from "node:path";
import { fileURLToPath } from "node:url";
import { Firestore } from "@google-cloud/firestore";
import { CloudTasksClient } from "@google-cloud/tasks";
import express, { type NextFunction, type Request, type Response } from "express";
import { beginDiscordLogin, finishDiscordLogin, getSession, logout, requireInternal } from "./auth.js";
import { loadConfig } from "./config.js";
import { mapConcurrent } from "./concurrency.js";
import { DigestService, DiscordWebhookResponder } from "./digest.js";
import { DiscordIngestion } from "./discord.js";
import { DiscordCommands } from "./discord-commands.js";
import { ExtractionService } from "./extraction-service.js";
import { OpenRouterSummarizer } from "./openrouter.js";
import { FirestoreRepository } from "./repository.js";
import { CloudCommandTaskEnqueuer, CloudTaskEnqueuer } from "./tasks.js";
import type { DigestTaskPayload } from "./types.js";

const RETRY_JOBS_PER_REQUEST = 200;

const config = loadConfig();
const firestore = new Firestore({ projectId: config.projectId, databaseId: config.firestoreDatabaseId });
const repository = new FirestoreRepository(firestore, config.discordGuildId);
const tasksClient = new CloudTasksClient();
const taskEnqueuer = new CloudTaskEnqueuer(tasksClient, config);
const commandTaskEnqueuer = new CloudCommandTaskEnqueuer(tasksClient, config);
const ingestion = new DiscordIngestion(repository, taskEnqueuer, config);
const extraction = new ExtractionService(repository);
const commands = new DiscordCommands(commandTaskEnqueuer, config);
const digest = new DigestService(
  repository,
  new OpenRouterSummarizer(config),
  new DiscordWebhookResponder(config.discordApplicationId),
  config,
);

// Express 5 forwards rejected promises from handlers to the error middleware below, so async
// handlers need no try/catch of their own.
const app = express();
app.set("trust proxy", 1);
app.post("/discord/interactions", express.raw({ type: "application/json", limit: "16kb" }), async (request, response) => {
  if (!Buffer.isBuffer(request.body)) {
    response.status(400).json({ error: "invalid_body" });
    return;
  }
  const result = await commands.handle(request.body, {
    signature: request.get("x-signature-ed25519") || undefined,
    timestamp: request.get("x-signature-timestamp") || undefined,
  });
  if (result.body === undefined) response.status(result.status).end();
  else response.status(result.status).json(result.body);
});
app.use(express.json({ limit: "16kb" }));

app.get("/api/health", (_request, response) => response.json({ ok: true }));
app.get("/api/session", (request, response) => {
  const user = getSession(request, config);
  response.json(user ? { authenticated: true, user } : { authenticated: false });
});
app.get("/auth/discord", (request, response) => beginDiscordLogin(request, response, config));
app.get("/auth/callback", (request, response) => finishDiscordLogin(request, response, config));
app.post("/auth/logout", logout(config));

app.post("/internal/poll", requireInternal(config), async (_request, response) => {
  try {
    await commands.ensureRegistered();
  } catch (error) {
    console.error("Discord command registration failed", error);
  }
  await ingestion.run();
  response.status(204).end();
});
app.post("/internal/extract", requireInternal(config), async (request, response) => {
  const articleId = typeof request.body?.articleId === "string" ? request.body.articleId : "";
  const generation = request.body?.generation;
  if (!/^[a-f0-9]{64}$/.test(articleId)) {
    response.status(400).json({ error: "invalid_article_id" });
    return;
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    response.status(400).json({ error: "invalid_task_generation" });
    return;
  }
  // A 503 asks Cloud Tasks to redeliver; anything else would drop the job for good.
  if (await extraction.run(articleId, generation)) response.status(503).json({ error: "extraction_retry" });
  else response.status(204).end();
});
app.post("/internal/commands/digest", requireInternal(config), async (request, response) => {
  const payload = digestPayload(request.body);
  if (!payload) {
    response.status(400).json({ error: "invalid_digest_task" });
    return;
  }
  await digest.run(payload);
  response.status(204).end();
});

app.use("/api", requireSession);
app.get("/api/search", async (request, response) => {
  response.json(await repository.search(stringQuery(request.query.q) || "", stringQuery(request.query.cursor)));
});
app.get("/api/admin/status", requireAdmin, async (_request, response) => {
  response.json(await repository.getAdminStatus());
});
app.get("/api/admin/failed-jobs", requireAdmin, async (_request, response) => {
  response.json(await repository.listFailedExtractions(RETRY_JOBS_PER_REQUEST));
});
app.post("/api/admin/backfill", requireAdmin, async (_request, response) => {
  await repository.setBackfillEnabled(true);
  response.status(202).json({ enabled: true });
});
app.post("/api/admin/retry-failed", requireAdmin, async (_request, response) => {
  const jobs = await repository.requeueFailedExtractions(RETRY_JOBS_PER_REQUEST);
  await mapConcurrent(jobs, 10, async (job) => {
    await taskEnqueuer.enqueue(job);
    await repository.markTaskDispatched(job);
  });
  response.status(202).json({ requeued: jobs.length });
});

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(sourceDir, "../../dist");
app.use(express.static(staticDir, { index: false }));
app.use((request, response, next) => {
  if (request.method === "GET" && !request.path.startsWith("/api/") && !request.path.startsWith("/internal/")) {
    response.sendFile(path.join(staticDir, "index.html"));
  } else {
    next();
  }
});
app.use((_request, response) => response.status(404).json({ error: "not_found" }));
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({ error: "internal_error" });
});

function requireSession(request: Request, response: Response, next: NextFunction): void {
  const user = getSession(request, config);
  if (!user) {
    response.status(401).json({ error: "unauthorized" });
    return;
  }
  response.locals.user = user;
  next();
}

function requireAdmin(_request: Request, response: Response, next: NextFunction): void {
  if (response.locals.user?.isAdmin === true) next();
  else response.status(403).json({ error: "forbidden" });
}

function stringQuery(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function digestPayload(value: unknown): DigestTaskPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<DigestTaskPayload>;
  if (!snowflake(payload.interactionId) || !snowflake(payload.userId) || typeof payload.interactionToken !== "string"
    || !payload.interactionToken || typeof payload.days !== "number" || !Number.isSafeInteger(payload.days) || payload.days <= 0
    || typeof payload.invokedAt !== "string" || !Number.isFinite(Date.parse(payload.invokedAt))) return null;
  return payload as DigestTaskPayload;
}

function snowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`Milton listening on ${port}`);
  void commands.ensureRegistered().catch((error) => console.error("Discord command registration failed", error));
});
