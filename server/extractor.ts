import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { Worker } from "node:worker_threads";
import { Readability } from "@mozilla/readability";
import ipaddr from "ipaddr.js";
import { JSDOM } from "jsdom";
import createMetascraper from "metascraper";
import descriptionRules from "metascraper-description";
import titleRules from "metascraper-title";
import { limitBody, makeExcerpt } from "./content.js";
import type { ExtractedArticle, ExtractionFailureClass } from "./types.js";
import { isSafeUrl } from "./urls.js";

/** Wall-clock budget for one extraction, covering DNS, every redirect hop, and the body read. */
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MIN_READABLE_CHARACTERS = 120;
const BOT_BLOCK_SAMPLE_BYTES = 100_000;
const PARSE_TIMEOUT_MS = 20_000;
const PARSE_OLD_GENERATION_MB = 192;
const MAX_TITLE_CHARACTERS = 300;
const MAX_DESCRIPTION_CHARACTERS = 2_000;

const scrapeMetadata = createMetascraper([
  titleRules(),
  descriptionRules({ truncateLength: MAX_DESCRIPTION_CHARACTERS, ellipsis: "" }),
]);

export class ExtractionError extends Error {
  constructor(
    readonly failureClass: ExtractionFailureClass,
    message: string,
    readonly metadata: { hostname: string; httpStatus: number | null; contentLength: number | null },
    readonly permanent = false,
  ) {
    super(message);
  }
}

interface HtmlResponse {
  url: URL;
  status: number;
  contentType: string;
  body: Buffer;
  oversized: boolean;
  contentLength: number;
}

export async function extractArticle(rawUrl: string): Promise<ExtractedArticle> {
  const response = await fetchHtml(rawUrl);
  return parseArticleIsolated(response.body, response.url, response.status, response.contentType, {
    oversized: response.oversized,
    contentLength: response.contentLength,
  });
}

type WorkerFactory = (url: URL, options: ConstructorParameters<typeof Worker>[1]) => Worker;

/** Runs one parse in a disposable heap so malformed or adversarial DOMs cannot kill the service. */
export function parseArticleIsolated(
  source: Buffer,
  url: URL,
  status: number,
  contentType: string,
  options: {
    timeoutMs?: number;
    workerFactory?: WorkerFactory;
    oversized?: boolean;
    contentLength?: number;
  } = {},
): Promise<ExtractedArticle> {
  const metadata = { hostname: url.hostname, httpStatus: status, contentLength: options.contentLength ?? source.byteLength };
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source); // Buffer may be a view into a much larger slab; transfer only the response bytes.
  let worker: Worker;
  try {
    worker = (options.workerFactory ?? ((entry, workerOptions) => new Worker(entry, workerOptions)))(
      new URL("./extractor-worker.js", import.meta.url),
      { resourceLimits: { maxOldGenerationSizeMb: PARSE_OLD_GENERATION_MB } },
    );
  } catch (error) {
    return Promise.reject(new ExtractionError("network_error", `Could not start article parser: ${messageOf(error)}`, metadata));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      callback();
    };
    const timer = setTimeout(() => settle(() => reject(new ExtractionError(
      "parse_resource_limit", "HTML parsing exceeded the 20-second resource limit", metadata, true,
    ))), options.timeoutMs ?? PARSE_TIMEOUT_MS);

    worker.once("message", (message: unknown) => settle(() => {
      const result = message as { ok?: boolean; article?: ExtractedArticle; error?: { failureClass: ExtractionFailureClass; message: string; metadata: typeof metadata; permanent: boolean } };
      if (result.ok && result.article) resolve(result.article);
      else if (!result.ok && result.error) reject(new ExtractionError(result.error.failureClass, result.error.message, result.error.metadata, result.error.permanent));
      else reject(new ExtractionError("network_error", "Article parser returned an invalid response", metadata));
    }));
    worker.once("error", (error: Error & { code?: string }) => settle(() => reject(new ExtractionError(
      error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "parse_resource_limit" : "network_error",
      error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "HTML parsing exceeded its memory limit" : `Article parser failed: ${error.message}`,
      metadata,
      error.code === "ERR_WORKER_OUT_OF_MEMORY",
    ))));
    worker.once("exit", (code) => {
      if (!settled) settle(() => reject(new ExtractionError("network_error", `Article parser exited without a result (${code})`, metadata)));
    });
    try {
      worker.postMessage({
        source: bytes,
        url: url.toString(),
        status,
        contentType,
        oversized: options.oversized ?? false,
        contentLength: options.contentLength ?? source.byteLength,
      }, [bytes.buffer]);
    } catch (error) {
      settle(() => reject(new ExtractionError("network_error", `Could not start article parser: ${messageOf(error)}`, metadata)));
    }
  });
}

/**
 * Parses already-fetched HTML. The source stays a Buffer through `fetchHtml` so JSDOM can apply the
 * document's real charset; decoding as UTF-8 up front would mangle every legacy-encoded page.
 */
export async function parseArticleHtml(
  source: string | Buffer,
  url = new URL("https://example.com/"),
  status = 200,
  contentType = "text/html",
  responseInfo?: { oversized: boolean; contentLength: number },
): Promise<ExtractedArticle> {
  const sourceLength = Buffer.byteLength(source);
  const oversized = responseInfo?.oversized ?? bodyIsOversized(sourceLength);
  const contentLength = responseInfo?.contentLength ?? sourceLength;
  const cappedSource = oversized
    ? (Buffer.isBuffer(source) ? source.subarray(0, MAX_BODY_BYTES) : Buffer.from(source).subarray(0, MAX_BODY_BYTES))
    : source;
  const detail = { hostname: url.hostname, httpStatus: status, contentLength };
  if (looksLikeBotBlock(asciiSample(cappedSource))) {
    throw new ExtractionError("bot_block", "Page returned a browser challenge or CAPTCHA", detail);
  }

  let dom: JSDOM;
  try {
    dom = new JSDOM(cappedSource, { url: url.toString(), contentType: htmlContentType(contentType) });
  } catch (error) {
    throw new ExtractionError("malformed_html", `Could not parse HTML: ${messageOf(error)}`, detail, true);
  }

  // Metascraper and full-text extraction are deliberately independent. Serializing the JSDOM tree
  // gives Metascraper correctly decoded text even for legacy response charsets.
  let metadata: { title?: string; description?: string } = {};
  try {
    metadata = await scrapeMetadata({
      html: dom.serialize(),
      url: url.toString(),
      pickPropNames: new Set(["title", "description"]),
    });
  } catch { /* Metadata failure must not prevent an otherwise readable page from being indexed. */ }
  const structured = jsonLdArticle(dom);
  const title = metadata.title?.trim().slice(0, MAX_TITLE_CHARACTERS) || null;
  const scrapedDescription = metadata.description?.trim().slice(0, MAX_DESCRIPTION_CHARACTERS) || "";
  // metascraper-description treats JSON-LD articleBody as a description fallback. Keep that value
  // out of the metadata field: articleBody belongs exclusively in `body`.
  const description = scrapedDescription && structured?.body.trim().startsWith(scrapedDescription)
    ? structured.description.slice(0, MAX_DESCRIPTION_CHARACTERS)
    : scrapedDescription;

  let body = "";
  let method: ExtractedArticle["method"] = "metadata";
  if (!oversized) {
    let readableText = "";
    try {
      const readable = new Readability(dom.window.document.cloneNode(true) as Document).parse();
      readableText = readable?.textContent ? limitBody(readable.textContent) : "";
    } catch { /* JSON-LD and metadata remain valid independent extraction paths. */ }
    if (readableText.length >= MIN_READABLE_CHARACTERS) {
      body = readableText;
      method = "readability";
    } else {
      if (structured?.body && structured.body.length >= 40) {
        body = limitBody(structured.body);
        method = "json-ld";
      }
    }
  }

  if (title || description || body) {
    return result(title, description, body, method, detail);
  }
  if (oversized) {
    throw new ExtractionError("body_too_large", "Response exceeds the 2 MiB limit and its prefix contained no useful metadata", detail, true);
  }
  throw new ExtractionError("insufficient_content", "Page contained no useful article text or metadata", detail, true);
}

export async function fetchHtml(rawUrl: string): Promise<HtmlResponse> {
  const deadline = Date.now() + TIMEOUT_MS;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ExtractionError("invalid_url", "URL is invalid", { hostname: "", httpStatus: null, contentLength: null }, true);
  }

  for (let redirects = 0; ; redirects += 1) {
    if (!isSafeUrl(url)) throw new ExtractionError("private_address", "URL target is not public HTTP(S)", detailFor(url), true);
    const response = await requestOnce(url, deadline);
    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400 && response.headers.location) {
      if (redirects === MAX_REDIRECTS) {
        throw new ExtractionError("redirect_limit", `Page exceeded ${MAX_REDIRECTS} redirects`, detailFor(url, status), true);
      }
      url = resolveRedirect(url, response.headers.location);
      response.resume();
      continue;
    }

    const bodyResult = await readLimited(response, url);
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    const detail = { hostname: url.hostname, httpStatus: status || null, contentLength: bodyResult.contentLength };
    if (status === 403 || status === 429) {
      throw new ExtractionError("bot_block", `Origin returned HTTP ${status}`, detail);
    }
    if (status < 200 || status >= 300) {
      throw new ExtractionError("http_error", `Origin returned HTTP ${status || "unknown"}`, detail);
    }
    if (!isHtmlContentType(contentType)) {
      throw new ExtractionError("non_html", `Unsupported content type: ${contentType || "missing"}`, detail, true);
    }
    return { url, status, contentType, ...bodyResult };
  }
}

async function requestOnce(url: URL, deadline: number): Promise<http.IncomingMessage> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await withTimeout(
      dnsLookup(url.hostname, { all: true, verbatim: true }) as unknown as Promise<Array<{ address: string; family: number }>>,
      remainingMs(deadline),
      "DNS lookup timed out",
    );
  } catch (error) {
    const message = messageOf(error);
    throw new ExtractionError(message.includes("timed out") ? "timeout" : "dns_failure", `DNS lookup failed: ${message}`, detailFor(url));
  }

  // Every answer must be public, so a name that mixes public and private records cannot be used to
  // reach the metadata server or a private range. The chosen address is then pinned for the request
  // itself, which closes the window between this check and the connection.
  const publicAddress = addresses.find((entry) => isPublicAddress(entry.address));
  if (!publicAddress || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new ExtractionError("private_address", "Hostname resolves to a non-public address", detailFor(url), true);
  }
  const pinnedLookup = ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    if (typeof options === "object" && options && "all" in options && (options as { all?: boolean }).all) {
      callback(null, [publicAddress]);
    } else {
      callback(null, publicAddress.address, publicAddress.family);
    }
  }) as unknown as LookupFunction;

  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: "GET",
      headers: {
        "user-agent": "Milton/3.0 (+https://github.com/MattX/milton)",
        accept: "text/html,application/xhtml+xml",
        "accept-encoding": "identity",
      },
      lookup: pinnedLookup,
      // Aborts the whole exchange, not just an idle socket, so a slow drip cannot outlive the budget.
      signal: AbortSignal.timeout(remainingMs(deadline)),
    }, resolve);
    request.on("error", (error) => reject(new ExtractionError(transportFailureClass(error), error.message, detailFor(url))));
    request.end();
  });
}

async function readLimited(response: http.IncomingMessage, url: URL): Promise<{ body: Buffer; oversized: boolean; contentLength: number }> {
  const status = response.statusCode ?? null;
  const declared = Number(response.headers["content-length"]);
  const chunks: Buffer[] = [];
  let size = 0;
  let retained = 0;
  let oversized = Number.isFinite(declared) && bodyIsOversized(declared);
  try {
    for await (const raw of response) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.byteLength;
      const remaining = MAX_BODY_BYTES - retained;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        retained += kept.byteLength;
      }
      if (bodyIsOversized(size) || retained === MAX_BODY_BYTES && oversized) {
        oversized = true;
        response.destroy();
        break;
      }
    }
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError(transportFailureClass(error), messageOf(error), detailFor(url, status, size));
  }
  return {
    body: Buffer.concat(chunks, retained),
    oversized,
    contentLength: Number.isFinite(declared) ? declared : size,
  };
}

export function isPublicAddress(address: string): boolean {
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === "unicast";
}

export function resolveRedirect(current: URL, location: string): URL {
  return new URL(location, current);
}

export function bodyIsOversized(bytes: number): boolean {
  return bytes > MAX_BODY_BYTES;
}

export function isHtmlContentType(value: string): boolean {
  return /^text\/html\b|^application\/xhtml\+xml\b/i.test(value);
}

export function looksLikeBotBlock(html: string): boolean {
  const sample = html.slice(0, BOT_BLOCK_SAMPLE_BYTES);
  return /<title>\s*(?:just a moment|attention required|checking your browser)/i.test(sample)
    || /(?:cf-chl-|g-recaptcha|hcaptcha-container)/i.test(sample);
}

/**
 * Keeps the declared charset but always parses as HTML: JSDOM would switch to strict XML parsing for
 * `application/xhtml+xml`, which real pages routinely fail.
 */
function htmlContentType(value: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(value)?.[1];
  return charset ? `text/html; charset=${charset}` : "text/html";
}

/** The bot-block markers are ASCII, so a latin1 read is safe whatever the page's real encoding is. */
function asciiSample(source: string | Buffer): string {
  return Buffer.isBuffer(source) ? source.subarray(0, BOT_BLOCK_SAMPLE_BYTES).toString("latin1") : source;
}

function jsonLdArticle(dom: JSDOM): { body: string; description: string } | null {
  for (const script of dom.window.document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const root = JSON.parse(script.textContent || "") as unknown;
      for (const value of flattenJsonLd(root)) {
        if (typeof value.articleBody === "string") {
          return {
            body: value.articleBody,
            description: typeof value.description === "string" ? value.description.trim() : "",
          };
        }
      }
    } catch { /* A malformed JSON-LD block should not hide other fallbacks. */ }
  }
  return null;
}

function flattenJsonLd(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...flattenJsonLd(record["@graph"])];
}

interface ResponseDetail {
  hostname: string;
  httpStatus: number;
  contentLength: number;
}

function result(
  title: string | null,
  description: string,
  body: string,
  method: ExtractedArticle["method"],
  detail: ResponseDetail,
): ExtractedArticle {
  return {
    title: title?.slice(0, MAX_TITLE_CHARACTERS) || null,
    description: description.slice(0, MAX_DESCRIPTION_CHARACTERS),
    body,
    excerpt: makeExcerpt(description || body),
    method,
    httpStatus: detail.httpStatus,
    contentLength: detail.contentLength,
    hostname: detail.hostname,
  };
}

function detailFor(url: URL, httpStatus: number | null = null, contentLength: number | null = null) {
  return { hostname: url.hostname, httpStatus, contentLength };
}

function transportFailureClass(error: unknown): "timeout" | "network_error" {
  const name = error instanceof Error ? error.name : "";
  return name === "AbortError" || name === "TimeoutError" || /timed out|aborted/i.test(messageOf(error))
    ? "timeout"
    : "network_error";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
