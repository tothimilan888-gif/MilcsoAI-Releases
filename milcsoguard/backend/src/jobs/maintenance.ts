import type { FastifyInstance } from 'fastify';
import { expireBans } from '../services/bans.js';
import { pruneReplays } from '../services/replays.js';

/**
 * Periodic housekeeping: expires temporary bans, closes sessions of servers that stopped sending
 * heartbeats, and enforces each server's data retention settings. Bans and ban history are never
 * deleted by retention.
 */
export async function runMaintenance(app: FastifyInstance): Promise<Record<string, number>> {
  const db = app.db;
  const out: Record<string, number> = {};
  out.expiredBans = await expireBans(db);

  const stale = await db.query<{ id: string }>(
    `UPDATE servers SET status_info = status_info || jsonb_build_object('lostAt', now())
      WHERE deleted_at IS NULL AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - make_interval(secs => $1)
        AND (status_info->>'lostAt' IS NULL OR (status_info->>'lostAt')::timestamptz < last_heartbeat_at)
      RETURNING id`,
    [app.cfg.GAME_HEARTBEAT_STALE_SECONDS],
  );
  for (const s of stale.rows) {
    await db.query("UPDATE player_sessions SET disconnected_at = now(), disconnect_reason = 'heartbeat lost' WHERE server_id = $1 AND disconnected_at IS NULL", [s.id]);
    await db.query("INSERT INTO system_events (server_id, type, severity, message) VALUES ($1, 'heartbeat_lost', 'HIGH', 'A játékszerver nem küld heartbeatet')", [s.id]);
  }
  out.staleServers = stale.rowCount ?? 0;

  const del = async (sql: string) => (await db.query(sql)).rowCount ?? 0;
  out.detections = await del(`DELETE FROM detections d USING servers s WHERE s.id = d.server_id
    AND d.occurred_at < now() - make_interval(days => (s.retention->>'detectionsDays')::int)
    AND NOT EXISTS (SELECT 1 FROM ban_detections bd WHERE bd.detection_id = d.id)`);
  out.audit = await del(`DELETE FROM audit_logs a USING servers s WHERE s.id = a.server_id
    AND a.created_at < now() - make_interval(days => (s.retention->>'auditDays')::int)`);
  out.systemEvents = await del(`DELETE FROM system_events e USING servers s WHERE s.id = e.server_id
    AND e.created_at < now() - make_interval(days => (s.retention->>'systemEventsDays')::int)`);
  out.playerSessions = await del(`DELETE FROM player_sessions p USING servers s WHERE s.id = p.server_id
    AND p.disconnected_at IS NOT NULL AND p.disconnected_at < now() - make_interval(days => (s.retention->>'sessionsDays')::int)`);
  const replays = await pruneReplays(db);
  out.replays = replays.deleted;
  out.replaysFailed = replays.failed;
  out.webSessions = await del("DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'");
  out.commands = await del("DELETE FROM server_commands WHERE created_at < now() - interval '7 days'");
  return out;
}

export function scheduleMaintenance(app: FastifyInstance): () => void {
  const tick = async () => {
    try {
      const r = await runMaintenance(app);
      if (Object.values(r).some((n) => n > 0)) app.log.info({ maintenance: r }, 'maintenance run');
    } catch (err) {
      app.log.error({ err }, 'maintenance failed');
    }
  };
  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, app.cfg.RETENTION_JOB_MINUTES * 60_000);
  // Ban expiry is time sensitive; run it every minute regardless of the retention interval.
  const banTimer = setInterval(() => void expireBans(app.db).catch(() => undefined), 60_000);
  for (const t of [first, timer, banTimer]) t.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    clearInterval(banTimer);
  };
}
