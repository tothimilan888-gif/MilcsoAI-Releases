import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { maskIdentifier } from '../lib/identifiers.js';
import { parse } from '../lib/validate.js';
import { publish } from '../lib/realtime.js';
import { DETECTION_COLUMNS, detectionListQuery, listDetections, reviewDetection, type DetectionRow } from '../services/detections.js';

export function presentDetection(d: DetectionRow, showIdentifiers: boolean) {
  return { ...d, identifiers: showIdentifiers ? d.identifiers : d.identifiers.map(maskIdentifier) };
}

export default async function detectionRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/detections', { preHandler: app.requireServer('detections.view') }, async (req) => {
    const q = parse(detectionListQuery, req.query);
    const page = await listDetections(app.db, req.access!.serverId, q);
    const show = req.access!.permissions.has('players.identifiers');
    return { ...page, items: page.items.map((d) => presentDetection(d, show)) };
  });

  app.get('/servers/:serverId/detections/:id', { preHandler: app.requireServer('detections.view') }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const row = (await app.db.query<DetectionRow>(`SELECT ${DETECTION_COLUMNS} FROM detections WHERE id = $1 AND server_id = $2`, [id, req.access!.serverId])).rows[0];
    if (!row) throw notFound('Detection not found');
    const bans = (
      await app.db.query('SELECT b.id, b.public_code, b.status, b.reason FROM ban_detections bd JOIN bans b ON b.id = bd.ban_id WHERE bd.detection_id = $1', [id])
    ).rows;
    return { detection: presentDetection(row, req.access!.permissions.has('players.identifiers')), bans };
  });

  app.post('/servers/:serverId/detections/:id/review', { preHandler: app.requireServer('detections.review') }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(
      z.object({ status: z.enum(['confirmed', 'false_positive', 'dismissed', 'pending']), note: z.string().trim().min(3, 'Indoklás kötelező').max(1000) }),
      req.body,
    );
    const row = await reviewDetection(app.db, req.access!.serverId, id, body.status, body.note, req.actor());
    await publish(app.db, { serverId: req.access!.serverId, type: 'detection.reviewed', data: { id, status: body.status } });
    return { detection: presentDetection(row, req.access!.permissions.has('players.identifiers')) };
  });

  app.get('/servers/:serverId/detections-meta', { preHandler: app.requireServer('detections.view') }, async (req) => {
    const rows = (
      await app.db.query<{ type: string; module: string; n: number }>(
        "SELECT type, module, count(*) AS n FROM detections WHERE server_id = $1 AND occurred_at > now() - interval '90 days' GROUP BY type, module ORDER BY n DESC",
        [req.access!.serverId],
      )
    ).rows;
    return { types: rows };
  });
}
