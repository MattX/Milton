const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
]);

const DISCORD_HOSTS = new Set([
  "discord.com",
  "www.discord.com",
  "discord.gg",
  "discordapp.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

const URL_PATTERN = /https?:\/\/[^\s<>]+/giu;
const TRAILING_PUNCTUATION = new Set([")", ",", ".", "!", "?", ";", ":", "'", '"', "]", "}"]);

export interface NormalizedLink {
  normalizedUrl: string;
  domain: string;
}

/**
 * Prose runs into URLs ("see https://example.com/x."), so trailing punctuation is
 * dropped -- except a ")" that closes a "(" belonging to the URL itself, as in
 * https://en.wikipedia.org/wiki/Foo_(bar).
 */
function trimUrlPunctuation(raw: string): string {
  let url = raw;
  while (url.length) {
    const last = url.at(-1)!;
    if (!TRAILING_PUNCTUATION.has(last)) break;
    if (last === ")" && count(url, "(") >= count(url, ")")) break;
    url = url.slice(0, -1);
  }
  return url;
}

function count(value: string, character: string): number {
  let total = 0;
  for (const item of value) if (item === character) total += 1;
  return total;
}

export function normalizeUrl(raw: string): NormalizedLink | null {
  const cleaned = trimUrlPunctuation(raw);
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const hostname = url.hostname.toLowerCase();
  if (DISCORD_HOSTS.has(hostname)) return null;
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) return null;

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }

  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  return { normalizedUrl: url.toString(), domain: hostname };
}

export function extractLinks(content: string): NormalizedLink[] {
  const links = new Map<string, NormalizedLink>();
  for (const match of content.matchAll(URL_PATTERN)) {
    const link = normalizeUrl(match[0]);
    if (link) links.set(link.normalizedUrl, link);
  }
  return [...links.values()];
}

export function fallbackTitle(url: string): string {
  const parsed = new URL(url);
  const lastSegment = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (!lastSegment) return parsed.hostname;
  try {
    return decodeURIComponent(lastSegment).replace(/[-_]+/g, " ");
  } catch {
    return lastSegment.replace(/[-_]+/g, " ");
  }
}
