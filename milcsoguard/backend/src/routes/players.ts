import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { maskIdentifier } from '../lib/identifiers.js';
import { Where } from '../lib/pagination.js';
import { parse } from '../lib/validate.js';
import { BAN_COLUMNS } from '../services/bans.js';
import { enqueueCommand } from '../services/commands.js';
import { DETECTION_COLUMNS, escapeLike, type DetectionRow } from '../services/detections.js';
import { presentDetection } from './detections.js';

export default async function playerRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/players/online', { preHandler: app.requireServer('players.view') }, async (req) => {
    const sid = req.access!.serverId;
    const server = (await app.db.query<{ last_heartbeat_at: Date | null }>('SELECT last_heartbeat_at FROM servers WHERE id = $1', [sid])).rows[0]!;
    const online = !!server.last_heartbeat_at && Date.now() - server.last_heartbeat_at.getTime() < app.cfg.GAME_HEARTBEAT_STALE_SECONDS * 1000;
    if (!online) return { serverOnline: false, items: [] };
    const rows = (
      await app.db.query(
        `SELECT ps.id AS session_id, ps.player_id, ps.net_id, ps.name, ps.connected_at, ps.last_ping, ps.risk_score, ps.monitored,
                (SELECT count(*) FROM detections d WHERE d.player_id = ps.player_id AND d.occurred_at >= ps.connected_at) AS session_detections
           FROM player_sessions ps WHERE ps.server_id = $1 AND ps.disconnected_at IS NULL ORDER BY ps.net_id`,
        [sid],
      )
    ).rows;
    return { serverOnline: true, items: rows };
  });

  app.get('/servers/:serverId/players', { preHandler: app.requireServer('players.view') }, async (req) => {
    const q = parse(
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        q: z.string().max(100).optional(),
        flagged: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    const w = new Where().add('p.server_id = ?', req.access!.serverId);
    if (q.q) {
      const like = `%${escapeLike(q.q.toLowerCase())}%`;
      w.add(`(lower(p.last_name) LIKE ? OR EXISTS (SELECT 1 FROM player_identifiers pi WHERE pi.player_id = p.id AND (pi.type || ':' || pi.value) LIKE ?))`, like, like);
    }
    if (q.flagged === 'true') w.add('EXISTS (SELECT 1 FROM detections d WHERE d.player_id = p.id)');
    const total = (await app.db.query<{ n: number }>(`SELECT count(*) AS n FROM players p ${w}`, w.params)).rows[0]!.n;
    const limit = w.next(q.pageSize);
    const offset = w.next((q.page - 1) * q.pageSize);
    const items = (
      await app.db.query(
        `SELECT p.id, p.last_name, p.first_seen, p.last_seen,
                (SELECT count(*) FROM detections d WHERE d.player_id = p.id) AS detections,
                (SELECT count(*) FROM bans b WHERE b.player_id = p.id AND b.status = 'active' AND (b.expires_at IS NULL OR b.expires_at > now())) AS active_bans,
                EXISTS (SELECT 1 FROM player_sessions s WHERE s.player_id = p.id AND s.disconnected_at IS NULL) AS online
           FROM players p ${w} ORDER BY p.last_seen DESC LIMIT ${limit} OFFSET ${offset}`,
        w.params,
      )
    ).rows;
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/servers/:serverId/players/:playerId', { preHandler: app.requireServer('players.view') }, async (req) => {
    const { playerId } = parse(z.object({ playerId: z.uuid() }), req.params);
    const sid = req.access!.serverId;
    const player = (await app.db.query('SELECT id, last_name, first_seen, last_seen, notes FROM players WHERE id = $1 AND server_id = $2', [playerId, sid])).rows[0];
    if (!player) throw notFound('Player not found');
    const show = req.access!.permissions.has('players.identifiers');
    const identifiers = (
      await app.db.query<{ identifier: string; first_seen: Date; last_seen: Date }>(
        "SELECT type || ':' || value AS identifier, first_seen, last_seen FROM player_identifiers WHERE player_id = $1 ORDER BY type",
        [playerId],
      )
    ).rows.map((r) => ({ ...r, identifier: show ? r.identifier : maskIdentifier(r.identifier) }));
    const sessions = (
      await app.db.query(
        'SELECT id, net_id, name, connected_at, disconnected_at, disconnect_reason, risk_score FROM player_sessions WHERE player_id = $1 ORDER BY connected_at DESC LIMIT 25',
        [playerId],
      )
    ).rows;
    const detections = req.access!.permissions.has('detections.view')
      ? (await app.db.query<DetectionRow>(`SELECT ${DETECTION_COLUMNS} FROM detections WHERE player_id = $1 ORDER BY occurred_at DESC LIMIT 100`, [playerId])).rows.map((d) => presentDetection(d, show))
      : [];
    const bans = req.access!.permissions.has('bans.view')
      ? (await app.db.query(`SELECT ${BAN_COLUMNS} FROM bans b WHERE b.player_id = $1 ORDER BY b.created_at DESC`, [playerId])).rows
      : [];
    const stats = (
      await app.db.query(
        `SELECT count(*) AS total, count(*) FILTER (WHERE severity >= 'HIGH') AS high,
                count(*) FILTER (WHERE review_status = 'false_positive') AS false_positives
           FROM detections WHERE player_id = $1`,
        [playerId],
      )
    ).rows[0];
    const online = sessions.find((s) => !s.disconnected_at) ?? null;
    return { player, identifiers, sessions, detections, bans, stats, online };
  });

  app.patch('/servers/:serverId/players/:playerId', { preHandler: app.requireServer(['players.view', 'detections.review']) }, async (req) => {
    const { playerId } = parse(z.object({ playerId: z.uuid() }), req.params);
    const body = parse(z.object({ notes: z.string().max(4000) }), req.body);
    const r = await app.db.query('UPDATE players SET notes = $3 WHERE id = $1 AND server_id = $2', [playerId, req.access!.serverId, body.notes]);
    if (!r.rowCount) throw notFound('Player not found');
    await audit(app.db, req.actor(), { serverId: req.access!.serverId, action: 'player.notes_update', targetType: 'player', targetId: playerId });
    return { ok: true };
  });

  app.post('/servers/:serverId/players/:playerId/kick', { preHandler: app.requireServer('players.kick') }, async (req) => {
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
    // The game side verifies that the net id still belongs to one of these identifiers before kicking.
    const commandId = await enqueueCommand(app.db, sid, 'kick', { netId: session.net_id, identifiers, reason: body.reason, by: req.user!.username }, req.user!.userId);
    await audit(app.db, req.actor(), { serverId: sid, action: 'player.kick', targetType: 'player', targetId: playerId, details: { reason: body.reason, name: session.name, commandId } });
    return { ok: true, commandId };
  });
}
