import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/validate.js';

export default async function systemRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/system', { preHandler: app.requireServer('system.view') }, async (req) => {
    const sid = req.access!.serverId;
    const s = (await app.db.query<{ last_heartbeat_at: Date | null; status_info: Record<string, unknown> }>('SELECT last_heartbeat_at, status_info FROM servers WHERE id = $1', [sid])).rows[0]!;
    const dbStart = Date.now();
    await app.db.query('SELECT 1');
    const dbLatencyMs = Date.now() - dbStart;
    const queue = (
      await app.db.query("SELECT count(*) FILTER (WHERE status = 'pending') AS pending, count(*) FILTER (WHERE status = 'delivered') AS delivered FROM server_commands WHERE server_id = $1", [sid])
    ).rows[0];
    const keys = (await app.db.query('SELECT count(*) AS n, max(last_used_at) AS last_used FROM api_keys WHERE server_id = $1 AND revoked_at IS NULL', [sid])).rows[0];
    const config = (await app.db.query('SELECT version, updated_at, (schema IS NOT NULL) AS has_schema FROM server_configs WHERE server_id = $1', [sid])).rows[0];
    const online = !!s.last_heartbeat_at && Date.now() - s.last_heartbeat_at.getTime() < app.cfg.GAME_HEARTBEAT_STALE_SECONDS * 1000;
    return {
      game: { online, lastHeartbeatAt: s.last_heartbeat_at, ...s.status_info },
      backend: { version: process.env.npm_package_version ?? '1.0.0', uptimeSeconds: Math.round(process.uptime()), dbLatencyMs, realtimeSubscribers: app.realtime.subscriberCount },
      commands: queue,
      apiKeys: keys,
      config,
    };
  });

  app.get('/servers/:serverId/system/events', { preHandler: app.requireServer('system.view') }, async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), type: z.string().max(40).optional() }), req.query);
    const rows = (
      await app.db.query(
        'SELECT id, type, severity, message, data, created_at FROM system_events WHERE server_id = $1 AND ($3::text IS NULL OR type = $3) ORDER BY created_at DESC LIMIT $2',
        [req.access!.serverId, q.limit, q.type ?? null],
      )
    ).rows;
    return { items: rows };
  });
}
