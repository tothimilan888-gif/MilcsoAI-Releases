import type { Queryable } from '../db/pool.js';
import type { Identifier } from '../lib/identifiers.js';

/**
 * Finds the player owning any of the given identifiers, or creates one. Identifiers are optional and
 * can change (Discord unlinked, Steam not running), so matching uses every identifier available.
 * When identifiers point at several players we keep the most recently seen one and do not steal
 * identifiers from the others (that would silently merge histories); a system event is recorded.
 */
export async function resolvePlayer(
  db: Queryable,
  serverId: string,
  identifiers: Identifier[],
  name: string,
  opts: { create: boolean; touch: boolean } = { create: true, touch: true },
): Promise<{ playerId: string | null; conflict: string[] }> {
  const matchable = identifiers.filter((i) => i.type !== 'ip');
  if (matchable.length === 0 && !opts.create) return { playerId: null, conflict: [] };

  const found = matchable.length
    ? (
        await db.query<{ player_id: string; last_seen: Date }>(
          `SELECT DISTINCT pi.player_id, p.last_seen
             FROM player_identifiers pi JOIN players p ON p.id = pi.player_id
            WHERE pi.server_id = $1 AND (pi.type, pi.value) IN (SELECT * FROM unnest($2::text[], $3::text[]))
            ORDER BY p.last_seen DESC`,
          [serverId, matchable.map((i) => i.type), matchable.map((i) => i.value)],
        )
      ).rows
    : [];

  let playerId = found[0]?.player_id ?? null;
  const conflict = found.slice(1).map((r) => r.player_id);

  if (!playerId) {
    if (!opts.create) return { playerId: null, conflict: [] };
    playerId = (
      await db.query<{ id: string }>('INSERT INTO players (server_id, last_name) VALUES ($1, $2) RETURNING id', [serverId, name.slice(0, 64)])
    ).rows[0]!.id;
  } else if (opts.touch) {
    await db.query('UPDATE players SET last_seen = now(), last_name = $2 WHERE id = $1', [playerId, name.slice(0, 64)]);
  }

  if (opts.touch && matchable.length) {
    await db.query(
      `INSERT INTO player_identifiers (server_id, player_id, type, value)
       SELECT $1, $2, t, v FROM unnest($3::text[], $4::text[]) AS x(t, v)
       ON CONFLICT (server_id, type, value) DO UPDATE SET last_seen = now()
         WHERE player_identifiers.player_id = EXCLUDED.player_id`,
      [serverId, playerId, matchable.map((i) => i.type), matchable.map((i) => i.value)],
    );
  }

  if (conflict.length) {
    await db.query(
      `INSERT INTO system_events (server_id, type, severity, message, data)
       VALUES ($1, 'identifier_conflict', 'LOW', 'Identifiers of a connecting player belong to several player records', $2)`,
      [serverId, JSON.stringify({ chosen: playerId, others: conflict })],
    );
  }
  return { playerId, conflict };
}

export async function playerIdentifiers(db: Queryable, playerId: string): Promise<string[]> {
  return (
    await db.query<{ i: string }>("SELECT type || ':' || value AS i FROM player_identifiers WHERE player_id = $1 ORDER BY type", [playerId])
  ).rows.map((r) => r.i);
}
