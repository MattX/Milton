import { beginDiscordLogin, finishDiscordLogin, getSession, logoutResponse } from "./auth";
import { getAdminStatus, searchArticles, setBackfillEnabled } from "./database";
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
  const path = url.pathname;

  if (path === "/auth/discord") return wrongMethod(request, "GET") ?? beginDiscordLogin(request, env);
  if (path === "/auth/callback") return wrongMethod(request, "GET") ?? finishDiscordLogin(request, env);
  if (path === "/auth/logout") return wrongMethod(request, "POST") ?? logoutResponse(request);
  if (path === "/api/health") return json({ ok: true });

  const user = await getSession(request, env);
  if (path === "/api/session") {
    return wrongMethod(request, "GET")
      ?? json(user ? { authenticated: true, user } : { authenticated: false });
  }
  if (!user) return json({ error: "unauthorized" }, { status: 401 });

  if (path === "/api/search") {
    return wrongMethod(request, "GET") ?? json(await searchArticles(
      env.DB,
      url.searchParams.get("q") || "",
      url.searchParams.get("cursor"),
    ));
  }

  if (path.startsWith("/api/admin/")) {
    if (!user.isAdmin) return json({ error: "forbidden" }, { status: 403 });
    if (path === "/api/admin/status") {
      return wrongMethod(request, "GET") ?? json(await getAdminStatus(env));
    }
    if (path === "/api/admin/backfill") {
      const rejected = wrongMethod(request, "POST");
      if (rejected) return rejected;
      await setBackfillEnabled(env.DB, true);
      return json({ enabled: true }, { status: 202 });
    }
  }

  return json({ error: "not_found" }, { status: 404 });
}

/** Null when the method is allowed, so handlers read as `?? handle(...)`. */
function wrongMethod(request: Request, allowed: string): Response | null {
  return request.method === allowed ? null : methodNotAllowed(allowed);
}
