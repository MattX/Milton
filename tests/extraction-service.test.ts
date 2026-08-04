import { describe, expect, it, vi } from "vitest";
import { ExtractionService } from "../server/extraction-service";
import { ExtractionError } from "../server/extractor";
import type { ExtractionClaim, Repository } from "../server/repository";
import type { ArticleDocument, ExtractionJobDocument } from "../server/types";

const article = {
  normalizedUrl: "https://example.com/story", domain: "example.com", extractionStatus: "pending",
} as ArticleDocument;

function repositoryFor(claim: ExtractionClaim) {
  const failExtraction = vi.fn().mockResolvedValue(undefined);
  const repository = {
    claimExtraction: vi.fn().mockResolvedValue(claim),
    failExtraction,
  } as unknown as Repository;
  return { repository, failExtraction };
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
    expect(await service.run("article")).toBe(true);
    expect(failExtraction).toHaveBeenCalledWith("article", expect.anything(), false);
  });

  it("turns retry exhaustion and permanent failures into link-only records", async () => {
    const exhausted = repositoryFor(claimAfter(3));
    const temporary = new ExtractionService(exhausted.repository, alwaysThrows(
      new ExtractionError("bot_block", "blocked", { hostname: "example.com", httpStatus: 403, contentLength: 20 }),
    ));
    expect(await temporary.run("article")).toBe(false);
    expect(exhausted.failExtraction).toHaveBeenCalledWith("article", expect.anything(), true);

    const permanent = repositoryFor(claimAfter(1));
    const invalid = new ExtractionService(permanent.repository, alwaysThrows(
      new ExtractionError("non_html", "PDF", { hostname: "example.com", httpStatus: 200, contentLength: 20 }, true),
    ));
    expect(await invalid.run("article")).toBe(false);
    expect(permanent.failExtraction).toHaveBeenCalledWith("article", expect.anything(), true);
  });

  it("acknowledges a delivery whose work another attempt already settled", async () => {
    const { repository } = repositoryFor({ status: "settled" });
    const extractor = vi.fn();
    expect(await new ExtractionService(repository, extractor).run("article")).toBe(false);
    expect(extractor).not.toHaveBeenCalled();
  });

  it("acknowledges a duplicate delivery while another worker holds the lease", async () => {
    const { repository } = repositoryFor({ status: "leased" });
    const extractor = vi.fn();
    expect(await new ExtractionService(repository, extractor).run("article")).toBe(false);
    expect(extractor).not.toHaveBeenCalled();
  });
});
