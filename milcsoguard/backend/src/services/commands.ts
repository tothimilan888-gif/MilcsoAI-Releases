import type { Queryable } from '../db/pool.js';

export type CommandType = 'kick' | 'ban_sync' | 'config_sync' | 'announce_admins' | 'replay_request';

/** Queues a command for the game server. Commands not picked up within ttlSeconds expire. */
export async function enqueueCommand(
  db: Queryable,
  serverId: string,
  type: CommandType,
  payload: Record<string, unknown>,
  createdBy: string | null,
  ttlSeconds = 120,
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO server_commands (server_id, type, payload, created_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) RETURNING id`,
    [serverId, type, JSON.stringify(payload), createdBy, ttlSeconds],
  );
  return r.rows[0]!.id;
}

export async function takePendingCommands(db: Queryable, serverId: string, limit = 25) {
  await db.query(
    "UPDATE server_commands SET status = 'expired' WHERE server_id = $1 AND status IN ('pending','delivered') AND expires_at <= now()",
    [serverId],
  );
  // Delivered-but-unacknowledged commands are re-sent; the game side de-duplicates by id.
  const r = await db.query<{ id: string; type: string; payload: unknown; created_at: Date }>(
    `UPDATE server_commands SET status = 'delivered', delivered_at = COALESCE(delivered_at, now())
      WHERE id IN (SELECT id FROM server_commands WHERE server_id = $1 AND status IN ('pending','delivered')
                   ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, type, payload, created_at`,
    [serverId, limit],
  );
  return r.rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
}
