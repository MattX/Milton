import { parentPort } from "node:worker_threads";
import { ExtractionError, parseArticleHtml } from "./extractor.js";

interface ParseRequest {
  source: Uint8Array;
  url: string;
  status: number;
  contentType: string;
}

if (!parentPort) throw new Error("Article parser must run in a worker thread");

parentPort.once("message", (request: ParseRequest) => {
  try {
    const source = Buffer.from(request.source.buffer, request.source.byteOffset, request.source.byteLength);
    parentPort!.postMessage({ ok: true, article: parseArticleHtml(source, new URL(request.url), request.status, request.contentType) });
  } catch (error) {
    const failure = error instanceof ExtractionError ? error : new ExtractionError(
      "network_error",
      error instanceof Error ? error.message : "Unknown parser failure",
      { hostname: new URL(request.url).hostname, httpStatus: request.status, contentLength: request.source.byteLength },
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
