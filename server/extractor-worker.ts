import { parentPort } from "node:worker_threads";
import { ExtractionError, parseArticleHtml } from "./extractor.js";

interface ParseRequest {
  source: Uint8Array;
  url: string;
  status: number;
  contentType: string;
  oversized: boolean;
  contentLength: number;
}

if (!parentPort) throw new Error("Article parser must run in a worker thread");

parentPort.once("message", async (request: ParseRequest) => {
  try {
    const source = Buffer.from(request.source.buffer, request.source.byteOffset, request.source.byteLength);
    const article = await parseArticleHtml(source, new URL(request.url), request.status, request.contentType, {
      oversized: request.oversized,
      contentLength: request.contentLength,
    });
    parentPort!.postMessage({ ok: true, article });
  } catch (error) {
    const failure = error instanceof ExtractionError ? error : new ExtractionError(
      "network_error",
      error instanceof Error ? error.message : "Unknown parser failure",
      { hostname: new URL(request.url).hostname, httpStatus: request.status, contentLength: request.contentLength },
    );
    parentPort!.postMessage({
      ok: false,
      error: {
        failureClass: failure.failureClass,
        message: failure.message,
        metadata: failure.metadata,
        permanent: failure.permanent,
      },
    });
  }
});
