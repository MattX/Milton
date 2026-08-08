import { describe, expect, it, vi } from "vitest";
import { ExtractionService } from "../server/extraction-service";
import { ExtractionError } from "../server/extractor";
import type { ExtractionClaim, Repository } from "../server/repository";
import type { ArticleDocument, ExtractionJobDocument } from "../server/types";

const article = {
  normalizedUrl: "https://example.com/story", domain: "example.com", extractionStatus: "pending",
  latestOccurrence: { postedAt: "2024-05-06T12:34:56.000Z" },
} as ArticleDocument;

function repositoryFor(claim: ExtractionClaim) {
  const failExtraction = vi.fn().mockResolvedValue(undefined);
  const completeExtraction = vi.fn().mockResolvedValue(undefined);
  const repository = {
    claimExtraction: vi.fn().mockResolvedValue(claim),
    failExtraction,
    completeExtraction,
  } as unknown as Repository;
  return { repository, failExtraction, completeExtraction };
}

function claimAfter(attempts: number): ExtractionClaim {
  return { status: "claimed", article, job: { attempts } as ExtractionJobDocument };
}

function alwaysThrows(error: ExtractionError) {
  return async () => { throw error; };
}

describe("extraction task delivery", () => {
  it("requests redelivery for temporary failures before attempt three", async () => {
    const { repository, failExtraction } = repositoryFor(claimAfter(2));
    const service = new ExtractionService(repository, alwaysThrows(
      new ExtractionError("timeout", "timed out", { hostname: "example.com", httpStatus: null, contentLength: null }),
    ));
    expect(await service.run("article", 1)).toBe(true);
    expect(failExtraction).toHaveBeenCalledWith("article", expect.anything(), false, 1);
  });

  it("turns retry exhaustion and permanent failures into link-only records", async () => {
    const exhausted = repositoryFor(claimAfter(3));
    const temporary = new ExtractionService(exhausted.repository, alwaysThrows(
      new ExtractionError("bot_block", "blocked", { hostname: "example.com", httpStatus: 403, contentLength: 20 }),
    ));
    expect(await temporary.run("article", 1)).toBe(false);
    expect(exhausted.failExtraction).toHaveBeenCalledWith("article", expect.anything(), true, 1);

    const permanent = repositoryFor(claimAfter(1));
    const invalid = new ExtractionService(permanent.repository, alwaysThrows(
      new ExtractionError("non_html", "PDF", { hostname: "example.com", httpStatus: 200, contentLength: 20 }, true),
    ));
    expect(await invalid.run("article", 1)).toBe(false);
    expect(permanent.failExtraction).toHaveBeenCalledWith("article", expect.anything(), true, 1);
  });

  it("acknowledges a delivery whose work another attempt already settled", async () => {
    const { repository } = repositoryFor({ status: "settled" });
    const extractor = vi.fn();
    expect(await new ExtractionService(repository, extractor).run("article", 1)).toBe(false);
    expect(extractor).not.toHaveBeenCalled();
  });

  it("acknowledges a duplicate delivery while another worker holds the lease", async () => {
    const { repository } = repositoryFor({ status: "leased" });
    const extractor = vi.fn();
    expect(await new ExtractionService(repository, extractor).run("article", 1)).toBe(false);
    expect(extractor).not.toHaveBeenCalled();
  });

  it("uses the archived extractor only for an Internet Archive job", async () => {
    const claimed = claimAfter(1);
    if (claimed.status !== "claimed") throw new Error("expected claimed job");
    claimed.job.source = "internet_archive";
    const { repository, completeExtraction } = repositoryFor(claimed);
    const originExtractor = vi.fn();
    const archiveExtractor = vi.fn().mockResolvedValue({ method: "metadata" });

    expect(await new ExtractionService(repository, originExtractor, archiveExtractor).run("article", 1)).toBe(false);

    expect(originExtractor).not.toHaveBeenCalled();
    expect(archiveExtractor).toHaveBeenCalledWith("https://example.com/story", "2024-05-06T12:34:56.000Z");
    expect(completeExtraction).toHaveBeenCalledWith("article", { method: "metadata" }, 1);
  });
});
