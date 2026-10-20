import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrateUp } from './db/migrate.js';
import { scheduleMaintenance } from './jobs/maintenance.js';
import { bootstrapOwner } from './services/bootstrap.js';

async function main() {
  const config = loadConfig();
  const db = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  await migrateUp(db);
  await bootstrapOwner(db, process.env, (m) => console.log(`[bootstrap] ${m}`));
  const app = await buildApp({ config, db });
  const stopJobs = scheduleMaintenance(app);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    stopJobs();
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
