import crypto from 'node:crypto';
import type { Db, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { audit, type Actor } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { formatIdentifier, type Identifier } from '../lib/identifiers.js';
import { publish } from '../lib/realtime.js';
import { resolvePlayer } from './players.js';
import { enqueueCommand } from './commands.js';

export interface BanRow {
  id: string;
  public_code: string;
  player_id: string | null;
  player_name: string;
  reason: string;
  source: string;
  created_by_label: string;
  created_at: Date;
  expires_at: Date | null;
  status: string;
  revoked_at: Date | null;
  revoked_by_label: string | null;
  revoke_reason: string | null;
  review_status: string;
  review_note: string | null;
  updated_at: Date;
  identifiers?: string[];
  detection_ids?: string[];
}

export const BAN_COLUMNS = `b.id, b.public_code, b.player_id, b.player_name, b.reason, b.source, b.created_by_label, b.created_at,
  b.expires_at, CASE WHEN b.status = 'active' AND b.expires_at IS NOT NULL AND b.expires_at <= now() THEN 'expired' ELSE b.status END AS status,
  b.revoked_at, b.revoked_by_label, b.revoke_reason, b.review_status, b.review_note, b.updated_at`;

function publicCode(): string {
  // 8 chars from an unambiguous alphabet, shown to banned players so they can appeal.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  return 'MG-' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export interface CreateBanInput {
  serverId: string;
  identifiers: Identifier[];
  playerName: string;
  reason: string;
  expiresAt: Date | null;
  source: 'web' | 'ingame' | 'system';
  actor: Actor;
  detectionIds?: string[];
  localId?: string | null;
  playerId?: string | null;
}

export async function createBan(db: Db, input: CreateBanInput): Promise<BanRow & { created: boolean }> {
  const matchable = input.identifiers.filter((i) => i.type !== 'ip');
  if (matchable.length === 0 && !input.playerId) {
    throw conflict('A ban needs at least one non-IP identifier');
  }
  const result = await withTx(db, async (tx) => {
    if (input.localId) {
      const existing = await tx.query<BanRow>(`SELECT ${BAN_COLUMNS} FROM bans b WHERE server_id = $1 AND local_id = $2`, [input.serverId, input.localId]);
      if (existing.rows[0]) return { ...existing.rows[0], created: false };
    }
    let playerId = input.playerId ?? null;
    if (!playerId) {
      playerId = (await resolvePlayer(tx, input.serverId, matchable, input.playerName, { create: true, touch: false })).playerId;
    }
    // Ban every identifier we know for this player, not only the ones in the request.
    const known = playerId
      ? (await tx.query<{ type: string; value: string }>('SELECT type, value FROM player_identifiers WHERE player_id = $1', [playerId])).rows
      : [];
    const all = new Map<string, Identifier>();
    for (const i of [...matchable, ...(known as Identifier[])]) if (i.type !== 'ip') all.set(formatIdentifier(i), i);

    let ban: BanRow | undefined;
    for (let attempt = 0; attempt < 3 && !ban; attempt++) {
      const r = await tx.query<BanRow>(
        `INSERT INTO bans (server_id, local_id, public_code, player_id, player_name, reason, source, created_by, created_by_label, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (server_id, public_code) DO NOTHING
         RETURNING ${BAN_COLUMNS.replaceAll('b.', '')}`,
        [
          input.serverId, input.localId ?? null, publicCode(), playerId, input.playerName.slice(0, 64), input.reason,
          input.source, input.actor.userId ?? null, input.actor.label, input.expiresAt,
        ],
      );
      ban = r.rows[0];
    }
    if (!ban) throw new Error('could not allocate ban code');

    await tx.query(
      `INSERT INTO ban_identifiers (ban_id, server_id, type, value) SELECT $1, $2, t, v FROM unnest($3::text[], $4::text[]) AS x(t, v)`,
      [ban.id, input.serverId, [...all.values()].map((i) => i.type), [...all.values()].map((i) => i.value)],
    );
    if (input.detectionIds?.length) {
      await tx.query(
        `INSERT INTO ban_detections (ban_id, detection_id)
         SELECT $1, d.id FROM detections d WHERE d.server_id = $2 AND d.id = ANY($3::uuid[]) ON CONFLICT DO NOTHING`,
        [ban.id, input.serverId, input.detectionIds],
      );
    }
    await audit(tx, input.actor, {
      serverId: input.serverId,
      action: 'ban.create',
      targetType: 'ban',
      targetId: ban.id,
      details: {
        code: ban.public_code, player: input.playerName, reason: input.reason,
        expiresAt: input.expiresAt?.toISOString() ?? null, source: input.source, identifiers: [...all.keys()],
      },
    });
    await publish(tx, { serverId: input.serverId, type: 'ban.created', data: { id: ban.id, code: ban.public_code, player: input.playerName } });
    // The game server enforces the ban immediately for players that are online right now.
    if (input.source !== 'ingame') await enqueueCommand(tx, input.serverId, 'ban_sync', { banId: ban.id }, input.actor.userId ?? null);
    return { ...ban, identifiers: [...all.keys()], created: true };
  });
  return result;
}

export async function revokeBan(
  db: Db,
  serverId: string,
  banId: string,
  reason: string,
  actor: Actor,
  opts: { notifyGame: boolean } = { notifyGame: true },
): Promise<BanRow> {
  return withTx(db, async (tx) => {
    const cur = (await tx.query<{ status: string }>('SELECT status FROM bans WHERE id = $1 AND server_id = $2 FOR UPDATE', [banId, serverId])).rows[0];
    if (!cur) throw notFound('Ban not found');
    if (cur.status === 'revoked') throw conflict('Ban is already revoked');
    const r = await tx.query<BanRow>(
      `UPDATE bans SET status = 'revoked', revoked_at = now(), revoked_by = $3, revoked_by_label = $4, revoke_reason = $5, updated_at = now()
        WHERE id = $1 AND server_id = $2 RETURNING ${BAN_COLUMNS.replaceAll('b.', '')}`,
      [banId, serverId, actor.userId ?? null, actor.label, reason],
    );
    await audit(tx, actor, { serverId, action: 'ban.revoke', targetType: 'ban', targetId: banId, details: { reason } });
    await publish(tx, { serverId, type: 'ban.revoked', data: { id: banId } });
    if (opts.notifyGame) await enqueueCommand(tx, serverId, 'ban_sync', { banId }, actor.userId ?? null);
    return r.rows[0]!;
  });
}

/** Active ban matching any identifier whose type is enabled for ban matching on this server. */
export async function findActiveBan(db: Queryable, serverId: string, identifiers: Identifier[]): Promise<BanRow | null> {
  if (identifiers.length === 0) return null;
  const r = await db.query<BanRow>(
    `SELECT ${BAN_COLUMNS}
       FROM bans b
       JOIN ban_identifiers bi ON bi.ban_id = b.id
       JOIN servers s ON s.id = b.server_id
      WHERE b.server_id = $1 AND b.status = 'active' AND (b.expires_at IS NULL OR b.expires_at > now())
        AND bi.type = ANY(s.ban_match_types)
        AND (bi.type, bi.value) IN (SELECT * FROM unnest($2::text[], $3::text[]))
      ORDER BY b.expires_at IS NULL DESC, b.expires_at DESC
      LIMIT 1`,
    [serverId, identifiers.map((i) => i.type), identifiers.map((i) => i.value)],
  );
  return r.rows[0] ?? null;
}

export async function banIdentifiers(db: Queryable, banIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!banIds.length) return map;
  const r = await db.query<{ ban_id: string; i: string }>(
    "SELECT ban_id, type || ':' || value AS i FROM ban_identifiers WHERE ban_id = ANY($1::uuid[]) ORDER BY type",
    [banIds],
  );
  for (const row of r.rows) {
    const list = map.get(row.ban_id) ?? [];
    list.push(row.i);
    map.set(row.ban_id, list);
  }
  return map;
}

/** Marks elapsed temporary bans as expired so that sync deltas pick them up. */
export async function expireBans(db: Queryable): Promise<number> {
  const r = await db.query(
    "UPDATE bans SET status = 'expired', updated_at = now() WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()",
  );
  return r.rowCount ?? 0;
}
