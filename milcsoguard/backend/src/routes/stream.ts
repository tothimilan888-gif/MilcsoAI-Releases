import type { FastifyInstance } from 'fastify';
import type { RealtimeEvent } from '../lib/realtime.js';

const EVENT_PERMISSION: Record<string, string> = {
  'detection.created': 'detections.view',
  'detection.reviewed': 'detections.view',
  'ban.created': 'bans.view',
  'ban.revoked': 'bans.view',
  'server.status': 'system.view',
  'players.changed': 'players.view',
  'config.changed': 'settings.view',
  'whitelist.changed': 'whitelist.view',
};

export default async function streamRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/stream', { preHandler: app.requireServer(), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, (req, reply) => {
    const access = req.access!;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const send = (ev: RealtimeEvent) => {
      if (ev.serverId !== access.serverId) return;
      const perm = EVENT_PERMISSION[ev.type];
      if (!perm || !access.permissions.has(perm as never)) return;
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    };
    const unsubscribe = app.realtime.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    // Sessions can be revoked while a stream is open; re-validate periodically.
    const recheck = setInterval(async () => {
      const ok = await app.db.query('SELECT 1 FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()', [req.user!.sessionId]).catch(() => null);
      if (!ok?.rowCount) res.end();
    }, 60_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      clearInterval(recheck);
      unsubscribe();
    });
  });
}
