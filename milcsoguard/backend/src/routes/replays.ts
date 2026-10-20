import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { Where } from '../lib/pagination.js';
import { publish } from '../lib/realtime.js';
import { parse } from '../lib/validate.js';
import { enqueueCommand } from '../services/commands.js';
import { REPLAY_COLUMNS, REPLAY_MAX_PARTS, getReplay, replayParts, type ReplayRow } from '../services/replays.js';

export default async function replayRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/replays', { preHandler: app.requireServer('replays.view') }, async (req) => {
    const q = parse(
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        kind: z.enum(['ban', 'manual']).optional(),
        status: z.enum(['requested', 'uploading', 'ready', 'failed']).optional(),
        playerId: z.uuid().optional(),
        banId: z.uuid().optional(),
      }),
      req.query,
    );
    const w = new Where().add('r.server_id = ?', req.access!.serverId);
    if (q.kind) w.add('r.kind = ?', q.kind);
    if (q.status) w.add('r.status = ?', q.status);
    if (q.playerId) w.add('r.player_id = ?', q.playerId);
    if (q.banId) w.add('r.ban_id = ?', q.banId);
    const total = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM replays r ${w}`, w.params)).rows[0]!.n;
    const limit = w.next(q.pageSize);
    const offset = w.next((q.page - 1) * q.pageSize);
    const items = (await app.db.query<ReplayRow>(`SELECT ${REPLAY_COLUMNS} FROM replays r ${w} ORDER BY r.created_at DESC LIMIT ${limit} OFFSET ${offset}`, w.params)).rows;
    const usage = (await app.db.query<{ n: string }>('SELECT COALESCE(sum(size_bytes), 0) AS n FROM replays WHERE server_id = $1', [req.access!.serverId])).rows[0]!.n;
    return { items, total, page: q.page, pageSize: q.pageSize, storage: { usedBytes: Number(usage), limitBytes: app.cfg.REPLAY_STORAGE_LIMIT_MB * 1024 * 1024 } };
  });

  // Opening a replay is audited: it shows a player's own screen.
  app.get('/servers/:serverId/replays/:replayId', { preHandler: app.requireServer('replays.view') }, async (req) => {
    const { replayId } = parse(z.object({ replayId: z.uuid() }), req.params);
    const sid = req.access!.serverId;
    const replay = await getReplay(app.db, sid, replayId);
    if (replay.status === 'ready') {
      await audit(app.db, req.actor(), { serverId: sid, action: 'replay.view', targetType: 'replay', targetId: replayId, details: { player: replay.player_name } });
    }
    return { replay, parts: await replayParts(app.db, replayId) };
  });

  app.get('/servers/:serverId/replays/:replayId/parts/:idx', { preHandler: app.requireServer('replays.view') }, async (req, reply) => {
    const { replayId, idx } = parse(z.object({ replayId: z.uuid(), idx: z.coerce.number().int().min(0).max(REPLAY_MAX_PARTS - 1) }), req.params);
    const replay = await getReplay(app.db, req.access!.serverId, replayId);
    const part = (await app.db.query<{ data: Buffer }>('SELECT data FROM replay_parts WHERE replay_id = $1 AND idx = $2', [replayId, idx])).rows[0];
    if (!part) throw notFound('Replay part not found');
    return reply
      .header('content-type', replay.mime)
      .header('cache-control', 'private, max-age=3600')
      .header('content-disposition', `inline; filename="replay-${replayId.slice(0, 8)}-${idx}.webm"`)
      .send(part.data);
  });

  app.delete('/servers/:serverId/replays/:replayId', { preHandler: app.requireServer('servers.manage') }, async (req) => {
    const { replayId } = parse(z.object({ replayId: z.uuid() }), req.params);
    const sid = req.access!.serverId;
    const replay = await getReplay(app.db, sid, replayId);
    await app.db.query('DELETE FROM replays WHERE id = $1', [replayId]);
    await audit(app.db, req.actor(), { serverId: sid, action: 'replay.delete', targetType: 'replay', targetId: replayId, details: { player: replay.player_name, kind: replay.kind } });
    return { ok: true };
  });

  /** Asks the game server for the last seconds of an online player's view. */
  app.post('/servers/:serverId/players/:playerId/replay', { preHandler: app.requireServer('replays.request') }, async (req) => {
    const { playerId } = parse(z.object({ playerId: z.uuid() }), req.params);
    const body = parse(z.object({ reason: z.string().trim().min(3, 'Indoklás kötelező').max(300) }), req.body);
    const sid = req.access!.serverId;
    const session = (
      await app.db.query<{ net_id: number; name: string }>(
        'SELECT net_id, name FROM player_sessions WHERE player_id = $1 AND server_id = $2 AND disconnected_at IS NULL ORDER BY connected_at DESC LIMIT 1',
        [playerId, sid],
      )
    ).rows[0];
    if (!session) throw conflict('Player is not online');
    const identifiers = (await app.db.query<{ i: string }>("SELECT type || ':' || value AS i FROM player_identifiers WHERE player_id = $1", [playerId])).rows.map((r) => r.i);
    const id = crypto.randomUUID();
    await app.db.query(
      `INSERT INTO replays (id, server_id, player_id, player_name, kind, status, reason, requested_by, requested_by_label)
       VALUES ($1, $2, $3, $4, 'manual', 'requested', $5, $6, $7)`,
      [id, sid, playerId, session.name, body.reason, req.user!.userId, req.user!.username],
    );
    // Same identity check as kick: the net id must still belong to this player when the game runs it.
    const commandId = await enqueueCommand(app.db, sid, 'replay_request', { replayId: id, netId: session.net_id, identifiers, reason: body.reason, by: req.user!.username }, req.user!.userId);
    await audit(app.db, req.actor(), { serverId: sid, action: 'replay.request', targetType: 'replay', targetId: id, details: { player: session.name, reason: body.reason, commandId } });
    await publish(app.db, { serverId: sid, type: 'replay.updated', data: { id, status: 'requested' } });
    return { replay: { id, status: 'requested' } };
  });
}
