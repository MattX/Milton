const MAX_QUERY_LENGTH = 200;
const MAX_TERMS = 12;
/** Firestore bills every document an offset skips, so pagination stops well short of runaway cost. */
const MAX_OFFSET = 2_000;

/** Preserve Firestore's phrase and exclusion syntax while dropping unsupported punctuation. */
export function normalizeSearchQuery(input: string): string | null {
  const source = input.normalize("NFKC").slice(0, MAX_QUERY_LENGTH);
  const tokens = source.match(/-?"[^"\r\n]+"|-?[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)?.slice(0, MAX_TERMS);
  if (!tokens?.length) return null;
  return tokens.map((token) => token.replace(/[\\:()]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean).join(" ") || null;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function encodeNextCursor(offset: number, pageSize: number, hasMore: boolean): string | null {
  const nextOffset = offset + pageSize;
  return hasMore && nextOffset <= MAX_OFFSET ? encodeCursor(nextOffset) : null;
}

export function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const value = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown }).offset;
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_OFFSET ? Number(value) : 0;
  } catch {
    return 0;
  }
}
