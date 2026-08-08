import { describe, expect, it, vi } from "vitest";
import { availabilityUrl, extractArchivedArticle } from "../server/internet-archive";
import type { ExtractedArticle } from "../server/types";

const outcome: ExtractedArticle = {
  title: "Archived title",
  description: "Archived description",
  body: "Archived body",
  excerpt: "Archived description",
  method: "readability",
  httpStatus: 200,
  contentLength: 123,
  hostname: "web.archive.org",
};

describe("Internet Archive extraction", () => {
  it("requests the capture closest to the Discord share time and extracts its replay", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      archived_snapshots: {
        closest: {
          available: true,
          url: "https://web.archive.org/web/20240506123456/https://example.com/story?x=1",
          timestamp: "20240506123456",
          status: "200",
        },
      },
    }), { headers: { "content-type": "application/json" } }));
    const extractor = vi.fn().mockResolvedValue(outcome);

    await expect(extractArchivedArticle(
      "https://example.com/story?x=1",
      "2024-05-06T12:34:56.000Z",
      { fetcher, extractor },
    )).resolves.toEqual(outcome);

    expect(fetcher).toHaveBeenCalledWith(
      "https://archive.org/wayback/available?url=https%3A%2F%2Fexample.com%2Fstory%3Fx%3D1&timestamp=20240506123456",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(extractor).toHaveBeenCalledWith(
      "https://web.archive.org/web/20240506123456/https://example.com/story?x=1",
    );
  });

  it("terminalizes a retry when no accessible capture exists", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ archived_snapshots: {} })));

    await expect(extractArchivedArticle(
      "https://example.com/missing",
      "2024-05-06T12:34:56.000Z",
      { fetcher },
    )).rejects.toMatchObject({ failureClass: "archive_unavailable", permanent: true });
  });

  it("treats lookup outages and malformed or untrusted responses as retryable", async () => {
    const outage = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(extractArchivedArticle(
      "https://example.com/story",
      "2024-05-06T12:34:56.000Z",
      { fetcher: outage },
    )).rejects.toMatchObject({ failureClass: "network_error", permanent: false });

    const untrusted = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      archived_snapshots: {
        closest: {
          available: true,
          url: "https://attacker.example/web/20240506123456/https://example.com/story",
          timestamp: "20240506123456",
          status: "200",
        },
      },
    })));
    await expect(extractArchivedArticle(
      "https://example.com/story",
      "2024-05-06T12:34:56.000Z",
      { fetcher: untrusted },
    )).rejects.toMatchObject({ failureClass: "network_error", permanent: false });
  });

  it("rejects an invalid share timestamp before making a request", () => {
    expect(() => availabilityUrl("https://example.com/story", "not-a-date"))
      .toThrow(expect.objectContaining({ failureClass: "archive_unavailable", permanent: true }));
  });
});
