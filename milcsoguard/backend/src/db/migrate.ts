import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';
import { createPool } from './pool.js';
import { seedSystemRoles } from '../lib/permissions.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locates the migrations directory both from src/ (tsx) and dist/src/ (compiled). */
async function migrationsDir(): Promise<string> {
  for (const candidate of [path.resolve(here, '../../migrations'), path.resolve(here, '../../../migrations')]) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error('migrations directory not found');
}

interface Migration {
  id: string;
  up: string;
  down: string | null;
}

async function loadMigrations(): Promise<Migration[]> {
  const dir = await migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.up.sql')).sort();
  const out: Migration[] = [];
  for (const f of files) {
    const id = f.replace(/\.up\.sql$/, '');
    const up = await readFile(path.join(dir, f), 'utf8');
    let down: string | null = null;
    try {
      down = await readFile(path.join(dir, `${id}.down.sql`), 'utf8');
    } catch {
      down = null;
    }
    out.push({ id, up, down });
  }
  return out;
}

async function ensureTable(db: Db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
}

export async function migrateUp(db: Db, log: (m: string) => void = console.log): Promise<string[]> {
  await ensureTable(db);
  const client = await db.connect();
  const applied: string[] = [];
  try {
    // Serialise concurrent migrators (e.g. two containers starting at once).
    await client.query('SELECT pg_advisory_lock(7349001)');
    const done = new Set((await client.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    for (const m of await loadMigrations()) {
      if (done.has(m.id)) continue;
      log(`[migrate] applying ${m.id}`);
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        applied.push(m.id);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.id} failed: ${(err as Error).message}`);
      }
    }
    await seedSystemRoles(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock(7349001)').catch(() => undefined);
    client.release();
  }
  return applied;
}

export async function migrateDown(db: Db, log: (m: string) => void = console.log): Promise<string | null> {
  await ensureTable(db);
  const last = (await db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1')).rows[0];
  if (!last) return null;
  const m = (await loadMigrations()).find((x) => x.id === last.id);
  if (!m?.down) throw new Error(`migration ${last.id} has no down script`);
  log(`[migrate] reverting ${m.id}`);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(m.down);
    await client.query('DELETE FROM schema_migrations WHERE id = $1', [m.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return m.id;
}

// CLI entry: tsx src/db/migrate.ts up|down
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2] ?? 'up';
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const db = createPool(url, 2);
  const run = cmd === 'down' ? migrateDown(db).then((r) => console.log(r ? `reverted ${r}` : 'nothing to revert')) : migrateUp(db).then((r) => console.log(r.length ? `applied: ${r.join(', ')}` : 'database is up to date'));
  run
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}
