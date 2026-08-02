import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import type { SessionUser } from "../shared/api.js";
import type { Config, DiscordUser } from "./types.js";

const SESSION_COOKIE = "milton_session";
const OAUTH_STATE_COOKIE = "milton_oauth_state";
const SESSION_SECONDS = 8 * 60 * 60;
const oidcClient = new OAuth2Client();

interface SessionPayload extends SessionUser { expiresAt: number }
interface DiscordTokenResponse { access_token: string; token_type: string }
interface DiscordMemberResponse { user?: DiscordUser; nick?: string | null }

export function beginDiscordLogin(request: Request, response: Response, config: Config): void {
  const state = randomBytes(32).toString("base64url");
  const redirectUri = `${requestOrigin(request)}/auth/callback`;
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", config.discordApplicationId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "identify guilds.members.read");
  authorize.searchParams.set("state", state);
  response.setHeader("set-cookie", serializeCookie(OAUTH_STATE_COOKIE, state, 600, request.secure));
  response.redirect(authorize.toString());
}

export async function finishDiscordLogin(request: Request, response: Response, config: Config): Promise<void> {
  const origin = requestOrigin(request);
  const expectedState = getCookie(request, OAUTH_STATE_COOKIE);
  const receivedState = stringQuery(request.query.state);
  const code = stringQuery(request.query.code);
  if (!expectedState || !receivedState || !safeEqual(expectedState, receivedState) || !code) {
    oauthFailure(response, origin, "Discord login state was invalid or expired."); return;
  }
  const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: config.discordApplicationId, client_secret: config.discordClientSecret, redirect_uri: `${origin}/auth/callback` }),
  });
  if (!tokenResponse.ok) { oauthFailure(response, origin, "Discord rejected the login code."); return; }
  const token = await tokenResponse.json() as DiscordTokenResponse;
  const headers = { authorization: `${token.token_type} ${token.access_token}` };
  const [userResponse, memberResponse] = await Promise.all([
    fetch("https://discord.com/api/v10/users/@me", { headers }),
    fetch(`https://discord.com/api/v10/users/@me/guilds/${config.discordGuildId}/member`, { headers }),
  ]);
  if (!userResponse.ok) { oauthFailure(response, origin, "Discord did not return your identity."); return; }
  if (memberResponse.status === 404 || memberResponse.status === 403) { oauthFailure(response, origin, "You are not a member of this Discord server."); return; }
  if (!memberResponse.ok) { oauthFailure(response, origin, "Discord could not verify server membership."); return; }
  const user = await userResponse.json() as DiscordUser;
  const member = await memberResponse.json() as DiscordMemberResponse;
  const sessionUser: SessionUser = {
    id: user.id,
    username: user.username,
    displayName: member.nick || user.global_name || user.username,
    avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null,
    isAdmin: config.adminDiscordUserIds.has(user.id),
  };
  response.setHeader("set-cookie", [
    createSessionCookie(sessionUser, config.sessionSecret, request.secure),
    serializeCookie(OAUTH_STATE_COOKIE, "", 0, request.secure),
  ]);
  response.redirect("/");
}

export function getSession(request: Request, config: Config): SessionUser | null {
  const value = getCookie(request, SESSION_COOKIE);
  if (!value) return null;
  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature || !safeEqual(signature, sign(encodedPayload, config.sessionSecret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SessionPayload;
    if (payload.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return { id: payload.id, username: payload.username, displayName: payload.displayName, avatarUrl: payload.avatarUrl, isAdmin: config.adminDiscordUserIds.has(payload.id) };
  } catch { return null; }
}

export function logout(request: Request, response: Response): void {
  response.setHeader("set-cookie", serializeCookie(SESSION_COOKIE, "", 0, request.secure));
  response.status(204).end();
}

export function requireInternal(config: Config) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (config.allowUnauthenticatedInternal && process.env.NODE_ENV !== "production") { next(); return; }
    const header = request.get("x-serverless-authorization") || request.get("authorization") || "";
    const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) { response.status(401).json({ error: "unauthorized" }); return; }
    try {
      const ticket = await oidcClient.verifyIdToken({ idToken: token, audience: config.serviceUrl });
      const payload = ticket.getPayload();
      if (!payload?.email || payload.email_verified !== true || !config.internalServiceAccounts.has(payload.email)) {
        response.status(403).json({ error: "forbidden" }); return;
      }
      next();
    } catch { response.status(401).json({ error: "unauthorized" }); }
  };
}

function createSessionCookie(user: SessionUser, secret: string, secure: boolean): string {
  const payload: SessionPayload = { ...user, expiresAt: Math.floor(Date.now() / 1000) + SESSION_SECONDS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return serializeCookie(SESSION_COOKIE, `${encoded}.${sign(encoded, secret)}`, SESSION_SECONDS, secure);
}
function sign(value: string, secret: string): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function getCookie(request: Request, name: string): string | null {
  for (const part of (request.get("cookie") || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}
function serializeCookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${maxAge}`, "SameSite=Lax", "HttpOnly", secure ? "Secure" : ""].filter(Boolean).join("; ");
}
function oauthFailure(response: Response, origin: string, message: string): void {
  const location = new URL("/", origin); location.searchParams.set("login_error", message);
  response.setHeader("set-cookie", serializeCookie(OAUTH_STATE_COOKIE, "", 0, location.protocol === "https:"));
  response.redirect(location.toString());
}
function requestOrigin(request: Request): string { return `${request.protocol}://${request.get("host")}`; }
function stringQuery(value: unknown): string | null { return typeof value === "string" ? value : null; }
