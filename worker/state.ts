export const BACKFILL_ENABLED = "backfill_enabled";
export const BROWSER_NEXT_SLOT = "browser_next_allowed_at";

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM system_state WHERE key = ?")
    .bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    `INSERT INTO system_state(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, value, new Date().toISOString()).run();
}

export async function getNumber(db: D1Database, key: string): Promise<number> {
  const value = Number(await getState(db, key));
  return Number.isFinite(value) ? value : 0;
}

export function setNumber(db: D1Database, key: string, value: number): Promise<void> {
  return setState(db, key, String(value));
}
