import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DiscordCommands, verifyDiscordSignature } from "../server/discord-commands";
import type { CommandTaskEnqueuer } from "../server/tasks";
import type { Config } from "../server/types";

const now = 1_800_000_000_000;
const timestamp = String(Math.floor(now / 1000));
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");

function signed(value: unknown) {
  const rawBody = Buffer.from(JSON.stringify(value));
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), keys.privateKey).toString("hex");
  return { rawBody, headers: { signature, timestamp } };
}

function config(): Config {
  return {
    discordPublicKey: publicKey,
    discordApplicationId: "123",
    discordGuildId: "456",
    discordBotToken: "bot-token",
  } as Config;
}

describe("Discord interactions", () => {
  it("verifies signed requests and rejects tampering and stale requests", () => {
    const request = signed({ type: 1 });
    expect(verifyDiscordSignature(request.rawBody, request.headers, publicKey, now)).toBe(true);
    expect(verifyDiscordSignature(Buffer.from("tampered"), request.headers, publicKey, now)).toBe(false);
    expect(verifyDiscordSignature(request.rawBody, request.headers, publicKey, now + 6 * 60_000)).toBe(false);
  });

  it("answers PING and queues a public digest with seven default days", async () => {
    const enqueueDigest = vi.fn().mockResolvedValue(undefined);
    const commands = new DiscordCommands({ enqueueDigest } as CommandTaskEnqueuer, config());

    const ping = signed({ type: 1, application_id: "123" });
    expect(await commands.handle(ping.rawBody, ping.headers, now)).toEqual({ status: 200, body: { type: 1 } });

    const command = signed({
      id: "789", application_id: "123", guild_id: "456", token: "interaction-token", type: 2,
      member: { user: { id: "999" } }, data: { name: "digest" },
    });
    expect(await commands.handle(command.rawBody, command.headers, now)).toEqual({ status: 200, body: { type: 5 } });
    expect(enqueueDigest).toHaveBeenCalledWith({
      interactionId: "789", interactionToken: "interaction-token", userId: "999", days: 7,
      invokedAt: new Date(now).toISOString(),
    });
  });

  it("accepts an unbounded positive days option and rejects invalid values ephemerally", async () => {
    const enqueueDigest = vi.fn().mockResolvedValue(undefined);
    const commands = new DiscordCommands({ enqueueDigest } as CommandTaskEnqueuer, config());
    const interaction = (value: number) => signed({
      id: "789", application_id: "123", guild_id: "456", token: "token", type: 2,
      member: { user: { id: "999" } }, data: { name: "digest", options: [{ name: "days", type: 4, value }] },
    });

    const valid = interaction(100_000);
    expect((await commands.handle(valid.rawBody, valid.headers, now)).body).toEqual({ type: 5 });
    expect(enqueueDigest).toHaveBeenLastCalledWith(expect.objectContaining({ days: 100_000 }));

    const invalid = interaction(0);
    expect(await commands.handle(invalid.rawBody, invalid.headers, now)).toEqual(expect.objectContaining({
      status: 200,
      body: expect.objectContaining({ type: 4, data: expect.objectContaining({ flags: 64 }) }),
    }));
  });

  it("bulk-registers the guild command once", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    const commands = new DiscordCommands({ enqueueDigest: vi.fn() }, config(), fetchFn as typeof fetch);
    await Promise.all([commands.ensureRegistered(), commands.ensureRegistered()]);
    await commands.ensureRegistered();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toContain("/applications/123/guilds/456/commands");
    expect(JSON.parse(String(init.body))).toEqual([expect.objectContaining({ name: "digest" })]);
  });
});
