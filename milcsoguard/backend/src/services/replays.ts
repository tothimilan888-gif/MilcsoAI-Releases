import type { Queryable } from '../db/pool.js';
import { AppError, conflict, notFound } from '../lib/errors.js';

export const REPLAY_MAX_PARTS = 16;
/** One recorder segment; at the default 700 kbit/s a 5 s segment is ~0.5 MB. */
export const REPLAY_MAX_PART_BYTES = 4 * 1024 * 1024;
export const REPLAY_MAX_TOTAL_BYTES = 24 * 1024 * 1024;

export interface ReplayRow {
  id: string;
  player_id: string | null;
  player_name: string;
  kind: 'ban' | 'manual';
  status: 'requested' | 'uploading' | 'ready' | 'failed';
  error: string | null;
  reason: string;
  ban_id: string | null;
  ban_code: string | null;
  requested_by_label: string;
  mime: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  duration_ms: number;
  size_bytes: number;
  part_count: number;
  created_at: Date;
  completed_at: Date | null;
}

export const REPLAY_COLUMNS = `r.id, r.player_id, r.player_name, r.kind, r.status, r.error, r.reason, r.ban_id,
  (SELECT b.public_code FROM bans b WHERE b.id = r.ban_id) AS ban_code, r.requested_by_label, r.mime, r.width, r.height, r.fps,
  r.duration_ms, r.size_bytes, r.part_count, r.created_at, r.completed_at`;

export async function getReplay(db: Queryable, serverId: string, id: string): Promise<ReplayRow> {
  const r = (await db.query<ReplayRow>(`SELECT ${REPLAY_COLUMNS} FROM replays r WHERE r.id = $1 AND r.server_id = $2`, [id, serverId])).rows[0];
  if (!r) throw notFound('Replay not found');
  return r;
}

export async function replayParts(db: Queryable, replayId: string) {
  return (
    await db.query<{ idx: number; duration_ms: number; size_bytes: number }>(
      'SELECT idx, duration_ms, size_bytes FROM replay_parts WHERE replay_id = $1 ORDER BY idx',
      [replayId],
    )
  ).rows;
}

/** Replays whose ban is still active are evidence for an appeal and are never evicted for space. */
const EVICTABLE = `NOT EXISTS (SELECT 1 FROM bans b WHERE b.id = r.ban_id AND b.status = 'active' AND (b.expires_at IS NULL OR b.expires_at > now()))`;

/**
 * Makes room for `incoming` bytes within the per-server storage limit by deleting the oldest
 * replays that are not evidence for an active ban. Throws 507 when that is not enough.
 */
export async function ensureStorage(db: Queryable, serverId: string, incoming: number, limitBytes: number, keepId: string): Promise<number> {
  const used = async () =>
    Number((await db.query<{ n: string }>('SELECT COALESCE(sum(p.size_bytes), 0) AS n FROM replay_parts p JOIN replays r ON r.id = p.replay_id WHERE r.server_id = $1', [serverId])).rows[0]!.n);
  let total = await used();
  let evicted = 0;
  while (total + incoming > limitBytes) {
    const victim = (
      await db.query<{ id: string }>(
        `SELECT r.id FROM replays r WHERE r.server_id = $1 AND r.id <> $2 AND ${EVICTABLE} ORDER BY r.created_at LIMIT 1`,
        [serverId, keepId],
      )
    ).rows[0];
    if (!victim) throw new AppError(507, 'storage_full', 'Replay storage limit reached (all stored replays belong to active bans)');
    await db.query('DELETE FROM replays WHERE id = $1', [victim.id]);
    evicted++;
    total = await used();
  }
  return evicted;
}

/** Links replays that were recorded for a game-side ban once that ban reaches the backend. */
export async function linkReplaysToBan(db: Queryable, serverId: string, localId: string, banId: string) {
  await db.query('UPDATE replays SET ban_id = $3 WHERE server_id = $1 AND ban_local_id = $2 AND ban_id IS NULL', [serverId, localId, banId]);
}

export async function assertUploadable(db: Queryable, serverId: string, id: string) {
  const r = (await db.query<{ status: string }>('SELECT status FROM replays WHERE id = $1 AND server_id = $2', [id, serverId])).rows[0];
  if (!r) throw notFound('Replay not found');
  if (r.status !== 'requested' && r.status !== 'uploading') throw conflict(`Replay is already ${r.status}`);
}

/** Deletes replays past the server's retention, except evidence for active bans; fails stuck uploads. */
export async function pruneReplays(db: Queryable): Promise<{ deleted: number; failed: number }> {
  const failed =
    (
      await db.query(
        "UPDATE replays SET status = 'failed', error = COALESCE(error, 'upload did not finish'), completed_at = now() WHERE status IN ('requested','uploading') AND created_at < now() - interval '30 minutes'",
      )
    ).rowCount ?? 0;
  const deleted =
    (
      await db.query(
        `DELETE FROM replays r USING servers s WHERE s.id = r.server_id
          AND r.created_at < now() - make_interval(days => COALESCE((s.retention->>'replaysDays')::int, 30)) AND ${EVICTABLE}`,
      )
    ).rowCount ?? 0;
  return { deleted, failed };
}
