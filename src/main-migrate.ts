import { resolve } from 'node:path';
import { db, closeDb } from './infra/db/pool.js';
import { migrate } from './infra/db/migrate.js';

const dir = resolve(process.env.MIGRATIONS_DIR ?? 'migrations');
try {
  const applied = await migrate(db(), dir, (m) => console.log(m));
  console.log(applied.length ? `done (${applied.length} applied)` : 'already up to date');
} finally {
  await closeDb();
}
