import { beginDiscordLogin, finishDiscordLogin, getSession, logoutResponse } from "./auth";
import { getAdminStatus, listOccurrences, searchArticles, setBackfillEnabled } from "./database";
import { runScheduledIngestion } from "./discord";
import { consumeExtractionQueue } from "./extraction";
import { errorResponse, json, methodNotAllowed } from "./http";
import type { Env, ExtractionMessage } from "./types";

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  },

  async scheduled(_controller, env, context): Promise<void> {
    context.waitUntil(runScheduledIngestion(env));
  },

  async queue(batch, env): Promise<void> {
    await consumeExtractionQueue(batch, env);
  },
} satisfies ExportedHandler<Env, ExtractionMessage>;

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/auth/discord") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return beginDiscordLogin(request, env);
  }
  if (url.pathname === "/auth/callback") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return finishDiscordLogin(request, env);
  }
  if (url.pathname === "/auth/logout") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return logoutResponse(request);
  }
  if (url.pathname === "/api/health") {
    return json({ ok: true });
  }

  const user = await getSession(request, env);
  if (url.pathname === "/api/session") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json(user ? { authenticated: true, user } : { authenticated: false });
  }
  if (!user) return json({ error: "unauthorized" }, { status: 401 });

  if (url.pathname === "/api/search") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const query = url.searchParams.get("q") || "";
    const cursor = url.searchParams.get("cursor");
    return json(await searchArticles(env.DB, query, cursor));
  }

  const occurrencesMatch = url.pathname.match(/^\/api\/articles\/(\d+)\/occurrences$/);
  if (occurrencesMatch) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const articleId = Number(occurrencesMatch[1]);
    return json(await listOccurrences(env.DB, articleId, url.searchParams.get("cursor")));
  }

  if (url.pathname === "/api/admin/status") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    if (!user.isAdmin) return json({ error: "forbidden" }, { status: 403 });
    return json(await getAdminStatus(env));
  }

  if (url.pathname === "/api/admin/backfill") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!user.isAdmin) return json({ error: "forbidden" }, { status: 403 });
    await setBackfillEnabled(env.DB, true);
    return json({ enabled: true }, { status: 202 });
  }

  return json({ error: "not_found" }, { status: 404 });
}
