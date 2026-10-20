import pg from 'pg';

// Return bigint/numeric COUNT(*) results as JS numbers (safe for our value ranges).
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  // An idle client error must not crash the process; the pool replaces the client.
  pool.on('error', (err) => {
    console.error('[db] idle client error', err.message);
  });
  return pool;
}

/** Runs fn inside a transaction. Rolls back on any thrown error. */
export async function withTx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
