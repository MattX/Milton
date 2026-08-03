import { createPublicKey, verify } from "node:crypto";
import type { CommandTaskEnqueuer } from "./tasks.js";
import type { Config, DigestTaskPayload } from "./types.js";

const DISCORD_API = "https://discord.com/api/v10";
const SIGNATURE_MAX_AGE_MS = 5 * 60_000;
const EPHEMERAL = 1 << 6;

interface InteractionOption {
  name?: string;
  type?: number;
  value?: unknown;
}

interface Interaction {
  id?: string;
  application_id?: string;
  type?: number;
  token?: string;
  guild_id?: string;
  member?: { user?: { id?: string } };
  data?: { name?: string; options?: InteractionOption[] };
}

export interface InteractionHeaders {
  signature: string | undefined;
  timestamp: string | undefined;
}

export interface InteractionResult {
  status: number;
  body?: unknown;
}

export class DiscordCommands {
  private registered = false;
  private registration: Promise<void> | null = null;

  constructor(
    private readonly tasks: CommandTaskEnqueuer,
    private readonly config: Config,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async handle(rawBody: Buffer, headers: InteractionHeaders, now = Date.now()): Promise<InteractionResult> {
    if (!verifyDiscordSignature(rawBody, headers, this.config.discordPublicKey, now)) return { status: 401 };

    let interaction: Interaction;
    try {
      interaction = JSON.parse(rawBody.toString("utf8")) as Interaction;
    } catch {
      return { status: 400, body: { error: "invalid_json" } };
    }
    if (interaction.application_id !== this.config.discordApplicationId) return { status: 401 };
    if (interaction.type === 1) return { status: 200, body: { type: 1 } };
    if (interaction.type !== 2) return immediateError("Unsupported interaction.");
    if (interaction.guild_id !== this.config.discordGuildId) return immediateError("This command is only available in Milton's server.");
    if (interaction.data?.name !== "digest") return immediateError("Unknown Milton command.");

    const interactionId = snowflake(interaction.id);
    const userId = snowflake(interaction.member?.user?.id);
    const interactionToken = typeof interaction.token === "string" ? interaction.token : "";
    const days = digestDays(interaction.data.options);
    if (!interactionId || !userId || !interactionToken || days === null) {
      return immediateError("`days` must be a positive integer.");
    }

    const payload: DigestTaskPayload = {
      interactionId, interactionToken, userId, days, invokedAt: new Date(now).toISOString(),
    };
    try {
      await this.tasks.enqueueDigest(payload);
    } catch (error) {
      console.error("Could not enqueue Discord digest", error);
      return immediateError("Milton could not start that digest. Please try again.");
    }
    return { status: 200, body: { type: 5 } };
  }

  async ensureRegistered(): Promise<void> {
    if (this.registered) return;
    if (this.registration) return this.registration;
    this.registration = this.register().finally(() => { this.registration = null; });
    return this.registration;
  }

  private async register(): Promise<void> {
    const response = await this.fetchFn(
      `${DISCORD_API}/applications/${this.config.discordApplicationId}/guilds/${this.config.discordGuildId}/commands`,
      {
        method: "PUT",
        headers: {
          authorization: `Bot ${this.config.discordBotToken}`,
          "content-type": "application/json",
          "user-agent": "DiscordBot (https://github.com/MattX/milton, 3.0)",
        },
        body: JSON.stringify([{
          name: "digest",
          description: "Summarize recently shared links",
          type: 1,
          options: [{
            name: "days", description: "Rolling days to include (default: 7)", type: 4, required: false, min_value: 1,
          }],
        }]),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`Discord command registration failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    this.registered = true;
  }
}

export function verifyDiscordSignature(
  rawBody: Buffer,
  headers: InteractionHeaders,
  publicKeyHex: string,
  now = Date.now(),
): boolean {
  const { signature, timestamp } = headers;
  if (!signature || !timestamp || !/^[a-f0-9]{128}$/i.test(signature) || !/^[a-f0-9]{64}$/i.test(publicKeyHex)) return false;
  const sentAt = Number(timestamp) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > SIGNATURE_MAX_AGE_MS) return false;
  try {
    // Discord supplies the raw 32-byte Ed25519 key; Node expects its standard SPKI wrapper.
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

function digestDays(options: InteractionOption[] | undefined): number | null {
  const option = options?.find((item) => item.name === "days");
  if (!option) return 7;
  return option.type === 4 && typeof option.value === "number" && Number.isSafeInteger(option.value) && option.value > 0
    ? option.value
    : null;
}

function snowflake(value: unknown): string | null {
  return typeof value === "string" && /^\d{1,20}$/.test(value) ? value : null;
}

function immediateError(content: string): InteractionResult {
  return { status: 200, body: { type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } } };
}
