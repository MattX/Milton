const DISCORD_HOSTS = new Set([
  "discord.com", "www.discord.com", "discord.gg", "discordapp.com",
  "cdn.discordapp.com", "media.discordapp.net",
]);
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i, /^127\./, /^10\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^\[?::1\]?$/, /^\[?f[cd][0-9a-f]{2}:/i, /^\[?fe80:/i,
];
const URL_PATTERN = /https?:\/\/[^\s<>]+/giu;
const TRAILING_PUNCTUATION = new Set([")", ",", ".", "!", "?", ";", ":", "'", '"', "]", "}"]);

export interface NormalizedLink { normalizedUrl: string; domain: string }

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
  let url: URL;
  try { url = new URL(trimUrlPunctuation(raw)); } catch { return null; }
  if (!isSafeUrl(url)) return null;
  const hostname = url.hostname.toLowerCase();
  if (DISCORD_HOSTS.has(hostname)) return null;
  url.hash = "";
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  return { normalizedUrl: url.toString(), domain: hostname };
}

export function isSafeUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return !PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname.toLowerCase()));
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
  try { return decodeURIComponent(lastSegment).replace(/[-_]+/g, " "); }
  catch { return lastSegment.replace(/[-_]+/g, " "); }
}
