import { Firestore } from "@google-cloud/firestore";
import { afterAll, describe, expect, it } from "vitest";
import { FirestoreRepository } from "../server/repository";
import type { DiscordMessage } from "../server/types";

const projectId = process.env.FIRESTORE_CONTRACT_PROJECT;
const databaseId = process.env.FIRESTORE_CONTRACT_DATABASE || "milton";
const db = projectId ? new Firestore({ projectId, databaseId }) : null;
const repository = db ? new FirestoreRepository(db, "guild") : null;
const createdArticleIds: string[] = [];

describe.skipIf(!repository)("Firestore Enterprise repository contract", () => {
  afterAll(async () => {
    if (!db) return;
    const writer = db.bulkWriter();
    for (const id of createdArticleIds) {
      const occurrences = await db.collection("occurrences").where("articleId", "==", id).get();
      for (const occurrence of occurrences.docs) writer.delete(occurrence.ref);
      writer.delete(db.collection("articles").doc(id));
      writer.delete(db.collection("extractionJobs").doc(id));
    }
    await writer.close();
    await db.terminate();
  });

  it("searches phrases, exclusions, Unicode, and opaque pages while keeping the latest repost", async () => {
    const token = `contract${Date.now()}`;
    const messages: DiscordMessage[] = Array.from({ length: 22 }, (_, index) => ({
      id: String(10_000 + index), channel_id: "channel", timestamp: new Date(Date.now() + index * 1000).toISOString(),
      content: `https://example.com/${token}-distributed-systems-${index}${index === 0 ? "-legacy" : ""}`,
      author: { id: "user", username: `author${index}` },
    }));
    createdArticleIds.push(...await repository!.persistDiscordMessages(messages, "general", "history"));
    const repost = { ...messages[1]!, id: "99999", timestamp: new Date(Date.now() + 100_000).toISOString(), author: { id: "new", username: "latest" } };
    await repository!.persistDiscordMessages([repost], "reposts", "live");
    const unicode = { ...messages[0]!, id: "unicode", content: `https://example.com/${token}-日本語-café` };
    createdArticleIds.push(...await repository!.persistDiscordMessages([unicode], "unicode", "live"));

    const page1 = await repository!.search(`"${token} distributed systems" -legacy`, null);
    expect(page1.items).toHaveLength(20);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.nextCursor).not.toMatch(/^\d+$/);
    const page2 = await repository!.search(`"${token} distributed systems" -legacy`, page1.nextCursor);
    expect(page2.items).toHaveLength(1);
    const reposted = [...page1.items, ...page2.items].find((item) => item.url.endsWith("-1"));
    expect(reposted?.latestOccurrence).toMatchObject({ authorName: "latest", channelName: "reposts" });
    expect((await repository!.search("日本語 café", null)).items.some((item) => item.url.includes(token))).toBe(true);
  }, 30_000);
});
