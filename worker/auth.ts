import type { SessionUser } from "../shared/api";
import type { DiscordUser, Env } from "./types";

const SESSION_COOKIE = "milton_session";
const OAUTH_STATE_COOKIE = "milton_oauth_state";
const SESSION_SECONDS = 8 * 60 * 60;

interface SessionPayload extends SessionUser {
  expiresAt: number;
}

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
}

interface DiscordMemberResponse {
  user?: DiscordUser;
  nick?: string | null;
}

export function adminIds(env: Env): Set<string> {
  return new Set(splitConfig(env.ADMIN_DISCORD_USER_IDS));
}

export function splitConfig(value: string): string[] {
  if (!value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
  } catch {
    // Comma-separated configuration is easier to set in the dashboard.
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export async function beginDiscordLogin(request: Request, env: Env): Promise<Response> {
  assertAuthConfiguration(env);
  const state = randomBase64Url(32);
  const requestUrl = new URL(request.url);
  const redirectUri = `${requestUrl.origin}/auth/callback`;
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", env.DISCORD_APPLICATION_ID);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "identify guilds.members.read");
  authorize.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      "set-cookie": serializeCookie(OAUTH_STATE_COOKIE, state, {
        maxAge: 600,
        httpOnly: true,
        secure: requestUrl.protocol === "https:",
      }),
    },
  });
}

export async function finishDiscordLogin(request: Request, env: Env): Promise<Response> {
  assertAuthConfiguration(env);
  const url = new URL(request.url);
  const expectedState = getCookie(request, OAUTH_STATE_COOKIE);
  const receivedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!expectedState || !receivedState || !constantTimeEqual(expectedState, receivedState) || !code) {
    return oauthFailure(url.origin, "Discord login state was invalid or expired.");
  }

  const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.DISCORD_APPLICATION_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  if (!tokenResponse.ok) return oauthFailure(url.origin, "Discord rejected the login code.");
  const token = await tokenResponse.json<DiscordTokenResponse>();

  const headers = { authorization: `${token.token_type} ${token.access_token}` };
  const [userResponse, memberResponse] = await Promise.all([
    fetch("https://discord.com/api/v10/users/@me", { headers }),
    fetch(`https://discord.com/api/v10/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`, { headers }),
  ]);

  if (!userResponse.ok) return oauthFailure(url.origin, "Discord did not return your identity.");
  if (memberResponse.status === 404 || memberResponse.status === 403) {
    return oauthFailure(url.origin, "You are not a member of this Discord server.");
  }
  if (!memberResponse.ok) return oauthFailure(url.origin, "Discord could not verify server membership.");

  const user = await userResponse.json<DiscordUser>();
  const member = await memberResponse.json<DiscordMemberResponse>();
  const sessionUser: SessionUser = {
    id: user.id,
    username: user.username,
    displayName: member.nick || user.global_name || user.username,
    avatarUrl: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : null,
    isAdmin: adminIds(env).has(user.id),
  };
  const cookie = await createSessionCookie(sessionUser, env.SESSION_SECRET, url.protocol === "https:");

  return new Response(null, {
    status: 302,
    headers: [
      ["location", "/"],
      ["set-cookie", cookie],
      ["set-cookie", serializeCookie(OAUTH_STATE_COOKIE, "", {
        maxAge: 0,
        httpOnly: true,
        secure: url.protocol === "https:",
      })],
    ],
  });
}

export function logoutResponse(request: Request): Response {
  const secure = new URL(request.url).protocol === "https:";
  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": serializeCookie(SESSION_COOKIE, "", { maxAge: 0, httpOnly: true, secure }),
    },
  });
}

export async function getSession(request: Request, env: Env): Promise<SessionUser | null> {
  const value = getCookie(request, SESSION_COOKIE);
  if (!value || !env.SESSION_SECRET) return null;
  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature) return null;
  const expected = await sign(encodedPayload, env.SESSION_SECRET);
  if (!constantTimeEqual(signature, expected)) return null;

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload)) as SessionPayload;
    if (payload.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return {
      id: payload.id,
      username: payload.username,
      displayName: payload.displayName,
      avatarUrl: payload.avatarUrl,
      isAdmin: adminIds(env).has(payload.id),
    };
  } catch {
    return null;
  }
}

async function createSessionCookie(user: SessionUser, secret: string, secure: boolean): Promise<string> {
  const payload: SessionPayload = {
    ...user,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  };
  const encoded = encodeBase64Url(JSON.stringify(payload));
  const signature = await sign(encoded, secret);
  return serializeCookie(SESSION_COOKIE, `${encoded}.${signature}`, {
    maxAge: SESSION_SECONDS,
    httpOnly: true,
    secure,
  });
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; httpOnly: boolean; secure?: boolean },
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${options.maxAge}`,
    "SameSite=Lax",
  ];
  if (options.secure !== false) attributes.push("Secure");
  if (options.httpOnly) attributes.push("HttpOnly");
  return attributes.join("; ");
}

function oauthFailure(origin: string, message: string): Response {
  const location = new URL("/", origin);
  location.searchParams.set("login_error", message);
  return new Response(null, {
    status: 302,
    headers: {
      location: location.toString(),
      "set-cookie": serializeCookie(OAUTH_STATE_COOKIE, "", {
        maxAge: 0,
        httpOnly: true,
        secure: location.protocol === "https:",
      }),
    },
  });
}

function assertAuthConfiguration(env: Env): void {
  if (!env.DISCORD_APPLICATION_ID || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_GUILD_ID || !env.SESSION_SECRET) {
    throw new Error("Discord OAuth is not configured");
  }
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function encodeBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
