import { extractArticle, ExtractionError } from "./extractor.js";
import type { ExtractedArticle } from "./types.js";

const AVAILABILITY_ENDPOINT = "https://archive.org/wayback/available";
const LOOKUP_TIMEOUT_MS = 15_000;
const MAX_LOOKUP_BYTES = 64 * 1024;

interface AvailabilityResponse {
  archived_snapshots?: {
    closest?: {
      available?: boolean;
      url?: string;
      timestamp?: string;
      status?: string;
    };
  };
}

export interface ArchiveExtractionOptions {
  fetcher?: typeof fetch;
  extractor?: typeof extractArticle;
}

/** Looks up the Wayback capture nearest the Discord share time, then extracts that replay. */
export async function extractArchivedArticle(
  originalUrl: string,
  sharedAt: string,
  options: ArchiveExtractionOptions = {},
): Promise<ExtractedArticle> {
  const lookupUrl = availabilityUrl(originalUrl, sharedAt);
  const metadata = { hostname: "archive.org", httpStatus: null, contentLength: null };
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(lookupUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ExtractionError(
      "network_error",
      `Internet Archive lookup failed: ${messageOf(error)}`,
      metadata,
    );
  }

  if (!response.ok) {
    throw new ExtractionError(
      "network_error",
      `Internet Archive lookup returned HTTP ${response.status}`,
      { ...metadata, httpStatus: response.status },
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOOKUP_BYTES) {
    throw invalidLookup("Internet Archive lookup response was too large", declaredLength);
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_LOOKUP_BYTES) {
    throw invalidLookup("Internet Archive lookup response was too large", Buffer.byteLength(body));
  }

  let payload: AvailabilityResponse;
  try {
    payload = JSON.parse(body) as AvailabilityResponse;
  } catch {
    throw invalidLookup("Internet Archive lookup returned invalid JSON", Buffer.byteLength(body));
  }
  const closest = payload.archived_snapshots?.closest;
  if (!closest?.available || closest.status !== "200" || !closest.url || !/^\d{14}$/.test(closest.timestamp || "")) {
    throw new ExtractionError(
      "archive_unavailable",
      "No accessible Internet Archive capture was found near the Discord share time",
      metadata,
      true,
    );
  }

  let snapshot: URL;
  try {
    snapshot = new URL(closest.url);
  } catch {
    throw invalidLookup("Internet Archive returned an invalid capture URL", Buffer.byteLength(body));
  }
  if ((snapshot.protocol !== "https:" && snapshot.protocol !== "http:")
    || snapshot.hostname !== "web.archive.org"
    || !snapshot.pathname.startsWith(`/web/${closest.timestamp}/`)) {
    throw invalidLookup("Internet Archive returned an untrusted capture URL", Buffer.byteLength(body));
  }

  return (options.extractor ?? extractArticle)(snapshot.toString());
}

export function availabilityUrl(originalUrl: string, sharedAt: string): string {
  const sharedDate = new Date(sharedAt);
  if (!Number.isFinite(sharedDate.getTime())) {
    throw new ExtractionError(
      "archive_unavailable",
      "The Discord share time is invalid, so an archived capture cannot be selected",
      { hostname: "archive.org", httpStatus: null, contentLength: null },
      true,
    );
  }
  const timestamp = sharedDate.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const url = new URL(AVAILABILITY_ENDPOINT);
  url.searchParams.set("url", originalUrl);
  url.searchParams.set("timestamp", timestamp);
  return url.toString();
}

function invalidLookup(message: string, contentLength: number): ExtractionError {
  return new ExtractionError(
    "network_error",
    message,
    { hostname: "archive.org", httpStatus: 200, contentLength },
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
