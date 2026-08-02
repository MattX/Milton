import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { Readability } from "@mozilla/readability";
import ipaddr from "ipaddr.js";
import { JSDOM } from "jsdom";
import { limitBody, makeExcerpt } from "./content.js";
import { isSafeUrl } from "./urls.js";

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MIN_READABLE_CHARACTERS = 120;

export type ExtractionFailureClass =
  | "invalid_url" | "private_address" | "dns_failure" | "timeout" | "redirect_limit"
  | "http_error" | "bot_block" | "non_html" | "body_too_large" | "malformed_html"
  | "insufficient_content" | "network_error";

export class ExtractionError extends Error {
  constructor(
    readonly failureClass: ExtractionFailureClass,
    message: string,
    readonly metadata: { hostname: string; httpStatus: number | null; contentLength: number | null },
    readonly permanent = false,
  ) { super(message); }
}

export interface ExtractedArticle {
  title: string | null;
  body: string;
  excerpt: string;
  method: "readability" | "json-ld" | "metadata";
  httpStatus: number;
  contentLength: number;
  hostname: string;
}

interface HtmlResponse { url: URL; status: number; contentType: string; body: Buffer }

export async function extractArticle(rawUrl: string): Promise<ExtractedArticle> {
  const response = await fetchHtml(rawUrl);
  return parseArticleHtml(response.body.toString("utf8"), response.url, response.status, response.body.byteLength);
}

export function parseArticleHtml(html: string, url = new URL("https://example.com/"), status = 200, contentLength = Buffer.byteLength(html)): ExtractedArticle {
  const response: HtmlResponse = { body: Buffer.from(html), url, status, contentType: "text/html" };
  if (looksLikeBotBlock(html)) {
    throw new ExtractionError("bot_block", "Page returned a browser challenge or CAPTCHA", {
      hostname: url.hostname, httpStatus: status, contentLength,
    });
  }
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url: response.url.toString() });
  } catch (error) {
    throw failure("malformed_html", `Could not parse HTML: ${messageOf(error)}`, response, true);
  }

  const readable = new Readability(dom.window.document.cloneNode(true) as Document).parse();
  const readableText = readable?.textContent ? limitBody(readable.textContent) : "";
  if (readableText.length >= MIN_READABLE_CHARACTERS) {
    return result(readable?.title || documentTitle(dom), readableText, "readability", response);
  }

  const structured = jsonLdArticle(dom);
  if (structured?.body && structured.body.length >= 40) {
    return result(structured.title || documentTitle(dom), limitBody(structured.body), "json-ld", response);
  }

  const metadata = metadataArticle(dom);
  if (metadata.body.length >= 20) {
    return result(metadata.title, limitBody(metadata.body), "metadata", response);
  }
  throw failure("insufficient_content", "Page contained no useful article text or metadata", response, true);
}

export async function fetchHtml(rawUrl: string): Promise<HtmlResponse> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new ExtractionError("invalid_url", "URL is invalid", { hostname: "", httpStatus: null, contentLength: null }, true); }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!isSafeUrl(url)) throw new ExtractionError("private_address", "URL target is not public HTTP(S)", metadata(url), true);
    const response = await requestOnce(url);
    if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      if (redirects === MAX_REDIRECTS) throw new ExtractionError("redirect_limit", "Page exceeded five redirects", metadata(url, response.statusCode), true);
      url = resolveRedirect(url, response.headers.location);
      response.resume();
      continue;
    }
    const body = await readLimited(response, url);
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    const detail = { hostname: url.hostname, httpStatus: response.statusCode || null, contentLength: body.byteLength };
    if (response.statusCode === 403 || response.statusCode === 429) {
      throw new ExtractionError("bot_block", `Origin returned HTTP ${response.statusCode}`, detail);
    }
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      throw new ExtractionError("http_error", `Origin returned HTTP ${response.statusCode || "unknown"}`, detail);
    }
    if (!isHtmlContentType(contentType)) {
      throw new ExtractionError("non_html", `Unsupported content type: ${contentType || "missing"}`, detail, true);
    }
    return { url, status: response.statusCode, contentType, body };
  }
  throw new ExtractionError("redirect_limit", "Page exceeded five redirects", metadata(url), true);
}

async function requestOnce(url: URL): Promise<http.IncomingMessage> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await withTimeout(
      dnsLookup(url.hostname, { all: true, verbatim: true }) as unknown as Promise<Array<{ address: string; family: number }>>,
      TIMEOUT_MS,
      "DNS lookup timed out",
    );
  }
  catch (error) {
    const message = messageOf(error);
    throw new ExtractionError(message.includes("timed out") ? "timeout" : "dns_failure", `DNS lookup failed: ${message}`, metadata(url));
  }
  const publicAddress = addresses.find((entry) => isPublicAddress(entry.address));
  if (!publicAddress || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new ExtractionError("private_address", "Hostname resolves to a non-public address", metadata(url), true);
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
      headers: { "user-agent": "Milton/3.0 (+https://github.com/MattX/milton)", accept: "text/html,application/xhtml+xml", "accept-encoding": "identity" },
      lookup: pinnedLookup,
    }, resolve);
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error("request timed out")));
    request.on("error", (error) => reject(new ExtractionError(
      error.message.includes("timed out") ? "timeout" : "network_error",
      error.message,
      metadata(url),
    )));
    request.end();
  });
}

async function readLimited(response: http.IncomingMessage, url: URL): Promise<Buffer> {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && bodyIsOversized(declared)) {
    response.destroy();
    throw new ExtractionError("body_too_large", "Response exceeds the 2 MiB limit", metadata(url, response.statusCode || null, declared), true);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const raw of response) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.byteLength;
      if (bodyIsOversized(size)) {
        response.destroy();
        throw new ExtractionError("body_too_large", "Response exceeds the 2 MiB limit", metadata(url, response.statusCode || null, size), true);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError("network_error", messageOf(error), metadata(url, response.statusCode || null, size));
  }
  return Buffer.concat(chunks, size);
}

export function isPublicAddress(address: string): boolean {
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  return parsed.range() === "unicast";
}

export function resolveRedirect(current: URL, location: string): URL { return new URL(location, current); }
export function bodyIsOversized(bytes: number): boolean { return bytes > MAX_BODY_BYTES; }
export function isHtmlContentType(value: string): boolean { return /^text\/html\b|^application\/xhtml\+xml\b/i.test(value); }
export function failureClassForHttpStatus(status: number): "bot_block" | "http_error" | null {
  if (status === 403 || status === 429) return "bot_block";
  if (status < 200 || status >= 300) return "http_error";
  return null;
}

export function looksLikeBotBlock(html: string): boolean {
  const sample = html.slice(0, 100_000);
  return /<title>\s*(?:just a moment|attention required|checking your browser)/i.test(sample)
    || /(?:cf-chl-|g-recaptcha|hcaptcha-container)/i.test(sample);
}

function jsonLdArticle(dom: JSDOM): { title: string | null; body: string } | null {
  for (const script of dom.window.document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const root = JSON.parse(script.textContent || "") as unknown;
      for (const value of flattenJsonLd(root)) {
        if (typeof value.articleBody === "string") {
          return { title: stringValue(value.headline) || stringValue(value.name), body: value.articleBody };
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
  return [record, ...flattenJsonLd(record["@graph"] )];
}

function metadataArticle(dom: JSDOM): { title: string | null; body: string } {
  const value = (selector: string) => dom.window.document.querySelector(selector)?.getAttribute("content")?.trim() || "";
  return {
    title: value('meta[property="og:title"]') || value('meta[name="twitter:title"]') || documentTitle(dom),
    body: value('meta[property="og:description"]') || value('meta[name="description"]') || value('meta[name="twitter:description"]'),
  };
}

function documentTitle(dom: JSDOM): string | null { return dom.window.document.title.trim().slice(0, 300) || null; }
function stringValue(value: unknown): string | null { return typeof value === "string" ? value.slice(0, 300) : null; }
function result(title: string | null, body: string, method: ExtractedArticle["method"], response: HtmlResponse): ExtractedArticle {
  return { title: title?.slice(0, 300) || null, body, excerpt: makeExcerpt(body), method, httpStatus: response.status, contentLength: response.body.byteLength, hostname: response.url.hostname };
}
function failure(failureClass: ExtractionFailureClass, message: string, response: HtmlResponse, permanent: boolean): ExtractionError {
  return new ExtractionError(failureClass, message, { hostname: response.url.hostname, httpStatus: response.status, contentLength: response.body.byteLength }, permanent);
}
function metadata(url: URL, httpStatus: number | null = null, contentLength: number | null = null) { return { hostname: url.hostname, httpStatus, contentLength }; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Unknown error"; }
async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
