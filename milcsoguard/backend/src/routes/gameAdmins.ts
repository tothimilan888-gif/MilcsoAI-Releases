import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { maskIdentifier } from '../lib/identifiers.js';
import { parse } from '../lib/validate.js';
import { findRole, listGameAdmins, removeGameAdmin, upsertGameAdmin } from '../services/gameAdmins.js';

/** In-game admins by FiveM identifier (no web account). */
export default async function gameAdminRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/game-admins', { preHandler: app.requireServer('admins.view') }, async (req) => {
    const show = req.access!.permissions.has('players.identifiers') || req.access!.permissions.has('admins.manage');
    const items = await listGameAdmins(app.db, req.access!.serverId);
    return {
      items: items.map((g) => ({
        ...g,
        identifier: show ? g.identifier : maskIdentifier(g.identifier),
        manageable: req.access!.permissions.has('admins.manage') && (req.access!.level >= 100 || g.level < req.access!.level),
      })),
    };
  });

  app.post('/servers/:serverId/game-admins', { preHandler: app.requireServer('admins.manage') }, async (req) => {
    const body = parse(
      z.object({ identifier: z.string().trim().min(3).max(100), name: z.string().trim().max(64).default(''), roleId: z.uuid(), note: z.string().trim().max(300).default('') }),
      req.body,
    );
    const access = req.access!;
    const role = await findRole(app.db, access.serverId, { id: body.roleId });
    const r = await upsertGameAdmin(app.db, access.serverId, { identifier: body.identifier, name: body.name, note: body.note, role }, { level: access.level, permissions: access.permissions as Set<string> }, req.actor());
    return { admin: r };
  });

  app.delete('/servers/:serverId/game-admins/:id', { preHandler: app.requireServer('admins.manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const access = req.access!;
    return removeGameAdmin(app.db, access.serverId, { id }, { level: access.level, permissions: access.permissions as Set<string> }, req.actor());
  });
}
