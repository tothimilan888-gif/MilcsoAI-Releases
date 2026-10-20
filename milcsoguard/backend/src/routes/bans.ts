import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { maskIdentifier, normaliseIdentifiers } from '../lib/identifiers.js';
import { Where } from '../lib/pagination.js';
import { parse } from '../lib/validate.js';
import { BAN_COLUMNS, banIdentifiers, createBan, revokeBan, type BanRow } from '../services/bans.js';
import { escapeLike } from '../services/detections.js';
import { playerIdentifiers } from '../services/players.js';
import { REPLAY_COLUMNS } from '../services/replays.js';

export const MAX_TEMP_BAN_SECONDS = 365 * 86400;

export const banCreateBody = z
  .object({
    playerId: z.uuid().optional(),
    identifiers: z.array(z.string().max(100)).max(32).default([]),
    playerName: z.string().max(64).default(''),
    reason: z.string().trim().min(3, 'Indoklás kötelező').max(500),
    durationSeconds: z.number().int().min(60).max(MAX_TEMP_BAN_SECONDS).nullable(),
    detectionIds: z.array(z.uuid()).max(50).default([]),
  })
  .refine((b) => b.playerId || b.identifiers.length > 0, 'playerId or identifiers required');

export default async function banRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/bans', { preHandler: app.requireServer('bans.view') }, async (req) => {
    const q = parse(
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        status: z.enum(['active', 'expired', 'revoked', 'all']).default('active'),
        q: z.string().max(100).optional(),
        review: z.enum(['none', 'under_review', 'upheld', 'overturned']).optional(),
        source: z.enum(['web', 'ingame', 'system']).optional(),
      }),
      req.query,
    );
    const w = new Where().add('b.server_id = ?', req.access!.serverId);
    if (q.status === 'active') w.add("b.status = 'active' AND (b.expires_at IS NULL OR b.expires_at > now())");
    if (q.status === 'expired') w.add("(b.status = 'expired' OR (b.status = 'active' AND b.expires_at <= now()))");
    if (q.status === 'revoked') w.add("b.status = 'revoked'");
    if (q.review) w.add('b.review_status = ?', q.review);
    if (q.source) w.add('b.source = ?', q.source);
    if (q.q) {
      const like = `%${escapeLike(q.q.toLowerCase())}%`;
      w.add(
        `(lower(b.player_name) LIKE ? OR lower(b.reason) LIKE ? OR lower(b.public_code) LIKE ?
          OR EXISTS (SELECT 1 FROM ban_identifiers bi WHERE bi.ban_id = b.id AND (bi.type || ':' || bi.value) LIKE ?))`,
        like, like, like, like,
      );
    }
    const total = (await app.db.query<{ n: number }>(`SELECT count(*) AS n FROM bans b ${w}`, w.params)).rows[0]!.n;
    const limit = w.next(q.pageSize);
    const offset = w.next((q.page - 1) * q.pageSize);
    const items = (await app.db.query<BanRow>(`SELECT ${BAN_COLUMNS} FROM bans b ${w} ORDER BY b.created_at DESC LIMIT ${limit} OFFSET ${offset}`, w.params)).rows;
    const ids = await banIdentifiers(app.db, items.map((b) => b.id));
    const show = req.access!.permissions.has('players.identifiers');
    return {
      items: items.map((b) => ({ ...b, identifiers: (ids.get(b.id) ?? []).map((i) => (show ? i : maskIdentifier(i))) })),
      total, page: q.page, pageSize: q.pageSize,
    };
  });

  app.get('/servers/:serverId/bans/:banId', { preHandler: app.requireServer('bans.view') }, async (req) => {
    const { banId } = parse(z.object({ banId: z.uuid() }), req.params);
    const ban = (await app.db.query<BanRow>(`SELECT ${BAN_COLUMNS} FROM bans b WHERE b.id = $1 AND b.server_id = $2`, [banId, req.access!.serverId])).rows[0];
    if (!ban) throw notFound('Ban not found');
    const show = req.access!.permissions.has('players.identifiers');
    const ids = (await banIdentifiers(app.db, [banId])).get(banId) ?? [];
    const detections = (
      await app.db.query(
        'SELECT d.id, d.type, d.severity, d.occurred_at, d.review_status FROM ban_detections bd JOIN detections d ON d.id = bd.detection_id WHERE bd.ban_id = $1 ORDER BY d.occurred_at',
        [banId],
      )
    ).rows;
    const history = (
      await app.db.query(
        "SELECT action, actor_label, details, created_at FROM audit_logs WHERE server_id = $1 AND target_type = 'ban' AND target_id = $2 ORDER BY created_at",
        [req.access!.serverId, banId],
      )
    ).rows;
    const replays = req.access!.permissions.has('replays.view')
      ? (await app.db.query(`SELECT ${REPLAY_COLUMNS} FROM replays r WHERE r.ban_id = $1 ORDER BY r.created_at`, [banId])).rows
      : [];
    return { ban: { ...ban, identifiers: ids.map((i) => (show ? i : maskIdentifier(i))) }, detections, history, replays };
  });

  app.post('/servers/:serverId/bans', { preHandler: app.requireServer('bans.create') }, async (req) => {
    const body = parse(banCreateBody, req.body);
    const access = req.access!;
    if (body.durationSeconds === null && !access.permissions.has('bans.permanent')) throw forbidden('Missing permission: bans.permanent');
    let identifiers = normaliseIdentifiers(body.identifiers);
    let playerName = body.playerName;
    if (body.playerId) {
      const p = (await app.db.query<{ last_name: string }>('SELECT last_name FROM players WHERE id = $1 AND server_id = $2', [body.playerId, access.serverId])).rows[0];
      if (!p) throw notFound('Player not found');
      playerName ||= p.last_name;
      identifiers = [...identifiers, ...normaliseIdentifiers(await playerIdentifiers(app.db, body.playerId))];
    }
    if (!identifiers.some((i) => i.type !== 'ip')) throw badRequest('At least one valid non-IP identifier is required');
    const ban = await createBan(app.db, {
      serverId: access.serverId,
      identifiers,
      playerName,
      playerId: body.playerId ?? null,
      reason: body.reason,
      expiresAt: body.durationSeconds === null ? null : new Date(Date.now() + body.durationSeconds * 1000),
      source: 'web',
      actor: req.actor(),
      detectionIds: body.detectionIds,
    });
    return { ban };
  });

  app.post('/servers/:serverId/bans/:banId/revoke', { preHandler: app.requireServer('bans.remove') }, async (req) => {
    const { banId } = parse(z.object({ banId: z.uuid() }), req.params);
    const body = parse(z.object({ reason: z.string().trim().min(3, 'Indoklás kötelező').max(500) }), req.body);
    const ban = await revokeBan(app.db, req.access!.serverId, banId, body.reason, req.actor());
    return { ban };
  });

  app.post('/servers/:serverId/bans/:banId/review', { preHandler: app.requireServer('bans.remove') }, async (req) => {
    const { banId } = parse(z.object({ banId: z.uuid() }), req.params);
    const body = parse(
      z.object({ status: z.enum(['under_review', 'upheld', 'overturned']), note: z.string().trim().min(3, 'Indoklás kötelező').max(1000) }),
      req.body,
    );
    const sid = req.access!.serverId;
    const r = await app.db.query<BanRow>(
      `UPDATE bans b SET review_status = $3, review_note = $4, updated_at = now() WHERE id = $1 AND server_id = $2 RETURNING ${BAN_COLUMNS}`,
      [banId, sid, body.status, body.note],
    );
    if (!r.rows[0]) throw notFound('Ban not found');
    await audit(app.db, req.actor(), { serverId: sid, action: 'ban.review', targetType: 'ban', targetId: banId, details: body });
    // Overturning a ban (wrongful ban) revokes it in the same step if still active.
    if (body.status === 'overturned' && r.rows[0].status === 'active') {
      const revoked = await revokeBan(app.db, sid, banId, `Felülvizsgálat: téves ban – ${body.note}`, req.actor());
      return { ban: revoked };
    }
    return { ban: r.rows[0] };
  });
}
