import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

/** 依檔名順序執行 migrations/*.sql，每個檔案一個 transaction，紀錄在 schema_migrations。 */
export async function migrate(pool: pg.Pool, dir: string, log: (msg: string) => void = () => {}): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // 多個實例同時啟動時只讓一個跑 migration
    await client.query('SELECT pg_advisory_lock(727272)');
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727272)').catch(() => undefined);
    client.release();
  }
  return applied;
}
