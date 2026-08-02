import { describe, expect, it, vi } from "vitest";
import { ExtractionService } from "../server/extraction-service";
import { ExtractionError } from "../server/extractor";
import type { Repository } from "../server/repository";
import type { ArticleDocument, ExtractionJobDocument } from "../server/types";

const article = {
  normalizedUrl: "https://example.com/story", domain: "example.com", extractionStatus: "pending",
} as ArticleDocument;

function repositoryFor(attempts: number) {
  const failExtraction = vi.fn().mockResolvedValue(undefined);
  const repository = {
    claimExtraction: vi.fn().mockResolvedValue({ article, job: { attempts } as ExtractionJobDocument }),
    failExtraction,
  } as unknown as Repository;
  return { repository, failExtraction };
}

describe("extraction task delivery", () => {
  it("requests redelivery for temporary failures before attempt three", async () => {
    const { repository, failExtraction } = repositoryFor(2);
    const service = new ExtractionService(repository, async () => { throw new ExtractionError("timeout", "timed out", { hostname: "example.com", httpStatus: null, contentLength: null }); });
    expect(await service.run("article")).toBe(true);
    expect(failExtraction).toHaveBeenCalledWith("article", expect.anything(), false);
  });

  it("turns retry exhaustion and permanent failures into link-only records", async () => {
    const exhausted = repositoryFor(3);
    const temporary = new ExtractionService(exhausted.repository, async () => { throw new ExtractionError("bot_block", "blocked", { hostname: "example.com", httpStatus: 403, contentLength: 20 }); });
    expect(await temporary.run("article")).toBe(false);
    expect(exhausted.failExtraction).toHaveBeenCalledWith("article", expect.anything(), true);

    const permanent = repositoryFor(1);
    const invalid = new ExtractionService(permanent.repository, async () => { throw new ExtractionError("non_html", "PDF", { hostname: "example.com", httpStatus: 200, contentLength: 20 }, true); });
    expect(await invalid.run("article")).toBe(false);
    expect(permanent.failExtraction).toHaveBeenCalledWith("article", expect.anything(), true);
  });

  it("acknowledges duplicate delivery after a job has already been claimed or completed", async () => {
    const repository = { claimExtraction: vi.fn().mockResolvedValue(null) } as unknown as Repository;
    const extractor = vi.fn();
    expect(await new ExtractionService(repository, extractor).run("article")).toBe(false);
    expect(extractor).not.toHaveBeenCalled();
  });
});
