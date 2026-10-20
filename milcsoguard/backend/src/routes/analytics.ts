import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/validate.js';

export async function dashboardStats(app: FastifyInstance, serverId: string) {
  const r = (
    await app.db.query(
      `SELECT
         (SELECT count(*) FROM player_sessions WHERE server_id = $1 AND disconnected_at IS NULL) AS online_players,
         (SELECT count(*) FROM detections WHERE server_id = $1 AND occurred_at >= date_trunc('day', now())) AS detections_today,
         (SELECT count(*) FROM detections WHERE server_id = $1 AND review_status = 'pending' AND severity >= 'HIGH') AS open_alerts,
         (SELECT count(*) FROM bans WHERE server_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())) AS active_bans,
         (SELECT count(*) FROM bans WHERE server_id = $1 AND created_at >= date_trunc('day', now())) AS bans_today,
         (SELECT count(*) FROM players WHERE server_id = $1) AS known_players`,
      [serverId],
    )
  ).rows[0];
  return r;
}

export default async function analyticsRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/stats', { preHandler: app.requireServer('detections.view') }, async (req) => {
    const sid = req.access!.serverId;
    const server = (await app.db.query<{ last_heartbeat_at: Date | null }>('SELECT last_heartbeat_at FROM servers WHERE id = $1', [sid])).rows[0]!;
    const online = !!server.last_heartbeat_at && Date.now() - server.last_heartbeat_at.getTime() < app.cfg.GAME_HEARTBEAT_STALE_SECONDS * 1000;
    const stats = await dashboardStats(app, sid);
    return { ...stats, online_players: online ? stats.online_players : 0, server_online: online };
  });

  app.get('/servers/:serverId/analytics', { preHandler: app.requireServer('analytics.view') }, async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const sid = req.access!.serverId;
    const since = `now() - make_interval(days => $2)`;
    const perDay = (
      await app.db.query(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day,
                COALESCE((SELECT count(*) FROM detections x WHERE x.server_id = $1 AND x.occurred_at >= d AND x.occurred_at < d + interval '1 day'), 0) AS detections,
                COALESCE((SELECT count(*) FROM bans b WHERE b.server_id = $1 AND b.created_at >= d AND b.created_at < d + interval '1 day'), 0) AS bans,
                COALESCE((SELECT count(*) FROM detections x WHERE x.server_id = $1 AND x.review_status = 'false_positive' AND x.occurred_at >= d AND x.occurred_at < d + interval '1 day'), 0) AS false_positives
           FROM generate_series(date_trunc('day', ${since}), date_trunc('day', now()), interval '1 day') AS d ORDER BY d`,
        [sid, q.days],
      )
    ).rows;
    const byType = (
      await app.db.query(
        `SELECT type, count(*) AS n, count(*) FILTER (WHERE review_status = 'false_positive') AS false_positives
           FROM detections WHERE server_id = $1 AND occurred_at >= ${since} GROUP BY type ORDER BY n DESC LIMIT 20`,
        [sid, q.days],
      )
    ).rows;
    const bySeverity = (
      await app.db.query(`SELECT severity, count(*) AS n FROM detections WHERE server_id = $1 AND occurred_at >= ${since} GROUP BY severity`, [sid, q.days])
    ).rows;
    const bySource = (
      await app.db.query(`SELECT source, count(*) AS n FROM detections WHERE server_id = $1 AND occurred_at >= ${since} GROUP BY source`, [sid, q.days])
    ).rows;
    const actions = (
      await app.db.query(`SELECT action, count(*) AS n FROM detections WHERE server_id = $1 AND occurred_at >= ${since} GROUP BY action`, [sid, q.days])
    ).rows;
    const topPlayers = (
      await app.db.query(
        `SELECT player_id, max(player_name) AS player_name, count(*) AS n, max(risk_score) AS max_risk
           FROM detections WHERE server_id = $1 AND occurred_at >= ${since} AND player_id IS NOT NULL
          GROUP BY player_id ORDER BY n DESC LIMIT 10`,
        [sid, q.days],
      )
    ).rows;
    return { days: q.days, perDay, byType, bySeverity, bySource, actions, topPlayers };
  });
}
