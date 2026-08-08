import { extractArticle, ExtractionError } from "./extractor.js";
import { extractArchivedArticle } from "./internet-archive.js";
import type { Repository } from "./repository.js";

const MAX_ATTEMPTS = 3;

export class ExtractionService {
  constructor(
    private readonly repository: Repository,
    private readonly extractor: typeof extractArticle = extractArticle,
    private readonly archiveExtractor: typeof extractArchivedArticle = extractArchivedArticle,
  ) {}

  /** Returns true when Cloud Tasks should redeliver this task. */
  async run(articleId: string, generation: number): Promise<boolean> {
    const claim = await this.repository.claimExtraction(articleId, generation);
    // Duplicate leases are acknowledged. Poll reconciliation owns abandoned-worker recovery.
    if (claim.status === "leased") return false;
    if (claim.status === "settled") return false;

    try {
      const outcome = claim.job.source === "internet_archive"
        ? await this.archiveExtractor(claim.article.normalizedUrl, claim.article.latestOccurrence.postedAt)
        : await this.extractor(claim.article.normalizedUrl);
      await this.repository.completeExtraction(articleId, outcome, generation);
      return false;
    } catch (error) {
      const failure = error instanceof ExtractionError ? error : new ExtractionError(
        "network_error",
        error instanceof Error ? error.message : "Unknown extraction error",
        { hostname: claim.article.domain, httpStatus: null, contentLength: null },
      );
      const terminal = failure.permanent || claim.job.attempts >= MAX_ATTEMPTS;
      const storedFailure = {
        failureClass: failure.failureClass,
        message: failure.message,
        ...failure.metadata,
      };
      await this.repository.failExtraction(articleId, storedFailure, terminal, generation);
      return !terminal;
    }
  }
}
