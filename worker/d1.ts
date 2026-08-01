/** D1 rejects oversized batches, so long statement lists are sent in slices. */
const MAX_STATEMENTS_PER_BATCH = 50;

export async function runBatched(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let index = 0; index < statements.length; index += MAX_STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(index, index + MAX_STATEMENTS_PER_BATCH));
  }
}

export function chunk<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}
