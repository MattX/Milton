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

  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= MAX_BODY_BYTES) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, middle)).byteLength <= MAX_BODY_BYTES) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).trimEnd();
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
