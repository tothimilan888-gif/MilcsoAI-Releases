import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { conflict, forbidden } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const MATCH_TYPES = ['license', 'license2', 'discord', 'fivem', 'steam', 'xbl', 'live', 'ip', 'token'] as const;

const retentionSchema = z.object({
  detectionsDays: z.number().int().min(7).max(3650),
  auditDays: z.number().int().min(30).max(3650),
  systemEventsDays: z.number().int().min(7).max(3650),
  sessionsDays: z.number().int().min(7).max(3650),
  replaysDays: z.number().int().min(1).max(3650).default(30),
});

const SERVER_COLUMNS = 'id, name, slug, description, ban_match_types, retention, status_info, last_heartbeat_at, created_at, updated_at';

export default async function serverRoutes(app: FastifyInstance) {
  app.get('/servers', { preHandler: app.authenticate }, async (req) => {
    const u = req.user!;
    const rows = (
      await app.db.query(
        u.isPlatformAdmin
          ? `SELECT ${SERVER_COLUMNS} FROM servers WHERE deleted_at IS NULL ORDER BY name`
          : `SELECT ${SERVER_COLUMNS.split(', ').map((c) => 's.' + c).join(', ')} FROM servers s
               JOIN server_members m ON m.server_id = s.id AND m.user_id = $1 WHERE s.deleted_at IS NULL ORDER BY s.name`,
        u.isPlatformAdmin ? [] : [u.userId],
      )
    ).rows;
    return { items: rows.map(withOnline(app)) };
  });

  app.post('/servers', { preHandler: app.authenticate }, async (req) => {
    if (!req.user!.isPlatformAdmin) throw forbidden('Only platform administrators can create servers');
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(64),
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/),
        description: z.string().max(500).default(''),
      }),
      req.body,
    );
    const server = await withTx(app.db, async (tx) => {
      const exists = await tx.query('SELECT 1 FROM servers WHERE slug = $1', [body.slug]);
      if (exists.rowCount) throw conflict('Slug already in use');
      const s = (
        await tx.query<{ id: string }>(`INSERT INTO servers (name, slug, description) VALUES ($1, $2, $3) RETURNING ${SERVER_COLUMNS}`, [body.name, body.slug, body.description])
      ).rows[0]!;
      const owner = (await tx.query<{ id: string }>("SELECT id FROM roles WHERE key = 'owner' AND server_id IS NULL")).rows[0]!;
      await tx.query('INSERT INTO server_members (server_id, user_id, role_id, added_by) VALUES ($1, $2, $3, $2)', [s.id, req.user!.userId, owner.id]);
      await tx.query('INSERT INTO server_configs (server_id) VALUES ($1)', [s.id]);
      await tx.query('INSERT INTO server_integrations (server_id) VALUES ($1)', [s.id]);
      await audit(tx, req.actor(), { serverId: s.id, action: 'server.create', targetType: 'server', targetId: s.id, details: body });
      return s;
    });
    return { server };
  });

  app.get('/servers/:serverId', { preHandler: app.requireServer() }, async (req) => {
    const row = (await app.db.query(`SELECT ${SERVER_COLUMNS} FROM servers WHERE id = $1`, [req.access!.serverId])).rows[0];
    return {
      server: withOnline(app)(row),
      access: { role: { key: req.access!.roleKey, name: req.access!.roleName, level: req.access!.level }, permissions: [...req.access!.permissions] },
    };
  });

  app.patch('/servers/:serverId', { preHandler: app.requireServer('servers.manage') }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(64).optional(),
        description: z.string().max(500).optional(),
        banMatchTypes: z.array(z.enum(MATCH_TYPES)).min(1).max(MATCH_TYPES.length).optional(),
        retention: retentionSchema.optional(),
      }),
      req.body,
    );
    const sets: string[] = [];
    const params: unknown[] = [req.access!.serverId];
    const push = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.name !== undefined) push('name', body.name);
    if (body.description !== undefined) push('description', body.description);
    if (body.banMatchTypes !== undefined) push('ban_match_types', [...new Set(body.banMatchTypes)]);
    if (body.retention !== undefined) push('retention', JSON.stringify(body.retention));
    if (!sets.length) return { ok: true };
    const row = (await app.db.query(`UPDATE servers SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${SERVER_COLUMNS}`, params)).rows[0];
    await audit(app.db, req.actor(), { serverId: req.access!.serverId, action: 'server.update', targetType: 'server', targetId: req.access!.serverId, details: body });
    return { server: withOnline(app)(row) };
  });

  app.delete('/servers/:serverId', { preHandler: app.requireServer('servers.manage') }, async (req) => {
    const body = parse(z.object({ confirmSlug: z.string() }), req.body);
    const s = (await app.db.query<{ slug: string }>('SELECT slug FROM servers WHERE id = $1', [req.access!.serverId])).rows[0]!;
    if (body.confirmSlug !== s.slug) throw conflict('Confirmation slug does not match');
    // Soft delete: data stays for the retention job / manual restore; API keys stop working immediately.
    await withTx(app.db, async (tx) => {
      await tx.query('UPDATE servers SET deleted_at = now() WHERE id = $1', [req.access!.serverId]);
      await tx.query('UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE server_id = $1 AND revoked_at IS NULL', [req.access!.serverId, req.user!.userId]);
      await audit(tx, req.actor(), { serverId: req.access!.serverId, action: 'server.delete', targetType: 'server', targetId: req.access!.serverId });
    });
    return { ok: true };
  });
}

function withOnline(app: FastifyInstance) {
  return (row: Record<string, unknown> & { last_heartbeat_at?: Date | null }) => ({
    ...row,
    online: !!row.last_heartbeat_at && Date.now() - row.last_heartbeat_at.getTime() < app.cfg.GAME_HEARTBEAT_STALE_SECONDS * 1000,
  });
}
