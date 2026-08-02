import type { Config } from "./types.js";

export function splitConfig(value: string | undefined): string[] {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const projectId = required(env, "GOOGLE_CLOUD_PROJECT");
  return {
    projectId,
    firestoreDatabaseId: env.FIRESTORE_DATABASE_ID || "milton",
    location: env.GOOGLE_CLOUD_LOCATION || "us-central1",
    serviceUrl: (env.SERVICE_URL || "http://localhost:8080").replace(/\/$/, ""),
    liveTaskQueue: env.LIVE_TASK_QUEUE || "milton-live-extraction",
    historyTaskQueue: env.HISTORY_TASK_QUEUE || "milton-history-extraction",
    taskServiceAccount: required(env, "TASK_SERVICE_ACCOUNT"),
    internalServiceAccounts: new Set(splitConfig(env.INTERNAL_SERVICE_ACCOUNTS)),
    discordApplicationId: required(env, "DISCORD_APPLICATION_ID"),
    discordClientSecret: required(env, "DISCORD_CLIENT_SECRET"),
    discordBotToken: required(env, "DISCORD_BOT_TOKEN"),
    discordGuildId: required(env, "DISCORD_GUILD_ID"),
    adminDiscordUserIds: new Set(splitConfig(env.ADMIN_DISCORD_USER_IDS)),
    sessionSecret: required(env, "SESSION_SECRET"),
    allowUnauthenticatedInternal: env.ALLOW_UNAUTHENTICATED_INTERNAL === "true",
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
