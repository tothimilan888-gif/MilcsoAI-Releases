import type { FastifyInstance } from 'fastify';

export default async function healthRoutes(app: FastifyInstance) {
  // Liveness: the process is up. No dependencies checked.
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  // Readiness: the database is reachable and migrated.
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await app.db.query('SELECT 1 FROM schema_migrations LIMIT 1');
      return { status: 'ready' };
    } catch (err) {
      return reply.status(503).send({ status: 'unavailable', error: (err as Error).message });
    }
  });

  app.get('/api/v1/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const start = Date.now();
    try {
      await app.db.query('SELECT 1');
      return { status: 'ok', db: 'ok', dbLatencyMs: Date.now() - start, time: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: 'degraded', db: 'down', time: new Date().toISOString() });
    }
  });
}
