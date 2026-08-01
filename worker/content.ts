const MAX_BODY_BYTES = 32 * 1024;

export function titleFromMarkdown(markdown: string): string | null {
  const heading = markdown.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim();
  return heading ? stripMarkdown(heading).slice(0, 300) : null;
}

export function markdownToPlainText(markdown: string): string {
  const text = stripMarkdown(markdown)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= MAX_BODY_BYTES) return text;
  // Truncating mid-character leaves an invalid sequence; a non-fatal decoder
  // turns that tail into U+FFFD, which the trailing-junk strip then removes.
  return new TextDecoder()
    .decode(bytes.slice(0, MAX_BODY_BYTES))
    .replace(/�+$/, "")
    .trimEnd();
}

export function makeExcerpt(text: string, length = 320): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= length) return compact;
  const truncated = compact.slice(0, length + 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, boundary > length * 0.7 ? boundary : length).trimEnd()}…`;
}

function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~]+/g, "");
}
