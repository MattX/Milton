const MAX_BODY_BYTES = 32 * 1024;

export function limitBody(text: string): string {
  const cleaned = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  const bytes = new TextEncoder().encode(cleaned);
  if (bytes.byteLength <= MAX_BODY_BYTES) return cleaned;
  return new TextDecoder().decode(bytes.slice(0, MAX_BODY_BYTES)).replace(/�+$/, "").trimEnd();
}

export function makeExcerpt(text: string, length = 320): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= length) return compact;
  const truncated = compact.slice(0, length + 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, boundary > length * 0.7 ? boundary : length).trimEnd()}…`;
}
