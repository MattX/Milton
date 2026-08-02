import { extractArticle, ExtractionError } from "./extractor.js";
import type { Repository } from "./repository.js";

const MAX_ATTEMPTS = 3;

export class ExtractionService {
  constructor(
    private readonly repository: Repository,
    private readonly extractor: typeof extractArticle = extractArticle,
  ) {}

  /** Returns true when Cloud Tasks should retry this delivery. */
  async run(articleId: string): Promise<boolean> {
    const claimed = await this.repository.claimExtraction(articleId);
    if (!claimed) return false;
    try {
      const outcome = await this.extractor(claimed.article.normalizedUrl);
      await this.repository.completeExtraction(articleId, outcome);
      return false;
    } catch (error) {
      const extractionError = error instanceof ExtractionError ? error : new ExtractionError(
        "network_error", error instanceof Error ? error.message : "Unknown extraction error",
        { hostname: claimed.article.domain, httpStatus: null, contentLength: null },
      );
      const terminal = extractionError.permanent || claimed.job.attempts >= MAX_ATTEMPTS;
      await this.repository.failExtraction(articleId, {
        failureClass: extractionError.failureClass,
        message: extractionError.message,
        ...extractionError.metadata,
      }, terminal);
      return !terminal;
    }
  }
}
