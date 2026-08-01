const MAX_QUERY_LENGTH = 200;
const MAX_TERMS = 12;

export function toFtsQuery(input: string): string | null {
  const terms = input
    .normalize("NFKC")
    .slice(0, MAX_QUERY_LENGTH)
    .match(/[\p{L}\p{N}]+/gu)
    ?.slice(0, MAX_TERMS);

  if (!terms?.length) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}

export function encodeCursor(offset: number): string {
  return btoa(String(offset)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const value = Number.parseInt(atob(normalized), 10);
    return Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : 0;
  } catch {
    return 0;
  }
}
