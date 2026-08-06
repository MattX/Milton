import type { Config } from "./types.js";

export function splitConfig(value: string | undefined): string[] {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const projectId = required(env, "GOOGLE_CLOUD_PROJECT");
  const serviceUrl = normalizedUrl(env.SERVICE_URL || "http://localhost:8080");
  return {
    projectId,
    firestoreDatabaseId: env.FIRESTORE_DATABASE_ID || "milton",
    location: env.GOOGLE_CLOUD_LOCATION || "us-central1",
    serviceUrl,
    publicUrl: normalizedUrl(env.PUBLIC_URL || serviceUrl),
    liveTaskQueue: env.LIVE_TASK_QUEUE || "milton-live-extraction",
    historyTaskQueue: env.HISTORY_TASK_QUEUE || "milton-history-extraction",
    commandTaskQueue: env.COMMAND_TASK_QUEUE || "milton-commands",
    taskServiceAccount: required(env, "TASK_SERVICE_ACCOUNT"),
    internalServiceAccounts: new Set(splitConfig(env.INTERNAL_SERVICE_ACCOUNTS)),
    discordApplicationId: required(env, "DISCORD_APPLICATION_ID"),
    discordClientSecret: required(env, "DISCORD_CLIENT_SECRET"),
    discordBotToken: required(env, "DISCORD_BOT_TOKEN"),
    discordGuildId: required(env, "DISCORD_GUILD_ID"),
    discordPublicKey: required(env, "DISCORD_PUBLIC_KEY"),
    adminDiscordUserIds: new Set(splitConfig(env.ADMIN_DISCORD_USER_IDS)),
    sessionSecret: required(env, "SESSION_SECRET"),
    openRouterApiKey: required(env, "OPENROUTER_API_KEY"),
    openRouterModel: env.OPENROUTER_MODEL || "openai/gpt-5.6-luna",
    openRouterReasoningEffort: reasoningEffort(env.OPENROUTER_REASONING_EFFORT),
    allowUnauthenticatedInternal: env.ALLOW_UNAUTHENTICATED_INTERNAL === "true",
  };
}

function normalizedUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function reasoningEffort(value: string | undefined): Config["openRouterReasoningEffort"] {
  const effort = value?.trim() || "medium";
  if (["max", "xhigh", "high", "medium", "low", "minimal", "none"].includes(effort)) {
    return effort as Config["openRouterReasoningEffort"];
  }
  throw new Error(`Invalid OPENROUTER_REASONING_EFFORT ${effort}`);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
