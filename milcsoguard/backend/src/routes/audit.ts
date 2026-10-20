import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Where } from '../lib/pagination.js';
import { parse } from '../lib/validate.js';
import { escapeLike } from '../services/detections.js';

export const auditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().max(64).optional(),
  actor: z.string().max(100).optional(),
  actorType: z.enum(['user', 'game_admin', 'system', 'api_key']).optional(),
  targetType: z.string().max(32).optional(),
  targetId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export async function listAudit(app: FastifyInstance, serverId: string, q: z.infer<typeof auditQuery>) {
  const w = new Where().add('server_id = ?', serverId);
  if (q.action) w.add('action LIKE ?', `${escapeLike(q.action)}%`);
  if (q.actor) w.add('actor_label ILIKE ?', `%${escapeLike(q.actor)}%`);
  if (q.actorType) w.add('actor_type = ?', q.actorType);
  if (q.targetType) w.add('target_type = ?', q.targetType);
  if (q.targetId) w.add('target_id = ?', q.targetId);
  if (q.from) w.add('created_at >= ?', q.from);
  if (q.to) w.add('created_at <= ?', q.to);
  const total = (await app.db.query<{ n: number }>(`SELECT count(*) AS n FROM audit_logs ${w}`, w.params)).rows[0]!.n;
  const limit = w.next(q.pageSize);
  const offset = w.next((q.page - 1) * q.pageSize);
  const items = (
    await app.db.query(
      `SELECT id, actor_type, actor_label, action, target_type, target_id, details, ip, created_at FROM audit_logs ${w}
        ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
      w.params,
    )
  ).rows;
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export default async function auditRoutes(app: FastifyInstance) {
  // Audit logs are append-only: there is intentionally no update or delete endpoint.
  app.get('/servers/:serverId/audit', { preHandler: app.requireServer('audit.view') }, async (req) => {
    return listAudit(app, req.access!.serverId, parse(auditQuery, req.query));
  });
}
