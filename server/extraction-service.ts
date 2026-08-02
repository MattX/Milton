import { extractArticle, ExtractionError } from "./extractor.js";
import type { Repository } from "./repository.js";

const MAX_ATTEMPTS = 3;

export class ExtractionService {
  constructor(
    private readonly repository: Repository,
    private readonly extractor: typeof extractArticle = extractArticle,
  ) {}

  /** Returns true when Cloud Tasks should redeliver this task. */
  async run(articleId: string): Promise<boolean> {
    const claim = await this.repository.claimExtraction(articleId);
    // Another delivery holds the lease. It may be a duplicate, or a worker that died mid-extraction,
    // so ask for redelivery rather than acknowledging work that might never have happened.
    if (claim.status === "leased") return true;
    if (claim.status === "settled") return false;

    try {
      await this.repository.completeExtraction(articleId, await this.extractor(claim.article.normalizedUrl));
      return false;
    } catch (error) {
      const failure = error instanceof ExtractionError ? error : new ExtractionError(
        "network_error",
        error instanceof Error ? error.message : "Unknown extraction error",
        { hostname: claim.article.domain, httpStatus: null, contentLength: null },
      );
      const terminal = failure.permanent || claim.job.attempts >= MAX_ATTEMPTS;
      await this.repository.failExtraction(articleId, {
        failureClass: failure.failureClass,
        message: failure.message,
        ...failure.metadata,
      }, terminal);
      return !terminal;
    }
  }
}
