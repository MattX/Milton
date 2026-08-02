import path from "node:path";
import { fileURLToPath } from "node:url";
import { Firestore } from "@google-cloud/firestore";
import { CloudTasksClient } from "@google-cloud/tasks";
import express, { type NextFunction, type Request, type Response } from "express";
import { beginDiscordLogin, finishDiscordLogin, getSession, logout, requireInternal } from "./auth.js";
import { loadConfig } from "./config.js";
import { mapConcurrent } from "./concurrency.js";
import { DiscordIngestion } from "./discord.js";
import { ExtractionService } from "./extraction-service.js";
import { FirestoreRepository } from "./repository.js";
import { CloudTaskEnqueuer, retryToken } from "./tasks.js";

const RETRY_JOBS_PER_REQUEST = 200;

const config = loadConfig();
const firestore = new Firestore({ projectId: config.projectId, databaseId: config.firestoreDatabaseId });
const repository = new FirestoreRepository(firestore, config.discordGuildId);
const taskEnqueuer = new CloudTaskEnqueuer(new CloudTasksClient(), config);
const ingestion = new DiscordIngestion(repository, taskEnqueuer, config);
const extraction = new ExtractionService(repository);

// Express 5 forwards rejected promises from handlers to the error middleware below, so async
// handlers need no try/catch of their own.
const app = express();
app.set("trust proxy", 1);
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
  await ingestion.run();
  response.status(204).end();
});
app.post("/internal/extract", requireInternal(config), async (request, response) => {
  const articleId = typeof request.body?.articleId === "string" ? request.body.articleId : "";
  if (!/^[a-f0-9]{64}$/.test(articleId)) {
    response.status(400).json({ error: "invalid_article_id" });
    return;
  }
  // A 503 asks Cloud Tasks to redeliver; anything else would drop the job for good.
  if (await extraction.run(articleId)) response.status(503).json({ error: "extraction_retry" });
  else response.status(204).end();
});

app.use("/api", requireSession);
app.get("/api/search", async (request, response) => {
  response.json(await repository.search(stringQuery(request.query.q) || "", stringQuery(request.query.cursor)));
});
app.get("/api/admin/status", requireAdmin, async (_request, response) => {
  response.json(await repository.getAdminStatus());
});
app.post("/api/admin/backfill", requireAdmin, async (_request, response) => {
  await repository.setBackfillEnabled(true);
  response.status(202).json({ enabled: true });
});
app.post("/api/admin/retry-failed", requireAdmin, async (_request, response) => {
  const jobs = await repository.requeueFailedExtractions(RETRY_JOBS_PER_REQUEST);
  await mapConcurrent(jobs, 10, (job) => taskEnqueuer.enqueue(job.articleId, job.priority, retryToken()));
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

const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => console.log(`Milton listening on ${port}`));
