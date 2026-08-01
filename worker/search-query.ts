const MAX_QUERY_LENGTH = 200;
const MAX_TERMS = 12;
const MAX_OFFSET = 100_000;

export function toFtsQuery(input: string): string | null {
  const terms = input
    .normalize("NFKC")
    .slice(0, MAX_QUERY_LENGTH)
    .match(/[\p{L}\p{N}]+/gu)
    ?.slice(0, MAX_TERMS);

  if (!terms?.length) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}

/** A cursor is just a row offset; it holds nothing worth hiding from the client. */
export function encodeCursor(offset: number): string {
  return String(offset);
}

export function decodeCursor(cursor: string | null): number {
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_OFFSET ? value : 0;
}
