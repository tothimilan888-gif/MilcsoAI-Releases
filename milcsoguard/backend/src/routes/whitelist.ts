import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../db/pool.js';
import { audit, type Actor } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { formatIdentifier, parseIdentifier } from '../lib/identifiers.js';
import { parse } from '../lib/validate.js';
import { publish } from '../lib/realtime.js';
import { enqueueCommand } from '../services/commands.js';
import { WL_COLUMNS, type WhitelistRow } from '../services/whitelist.js';

export const whitelistBody = z.object({
  kind: z.enum(['player', 'resource', 'model']),
  value: z.string().trim().min(1).max(128),
  modules: z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/)).max(100).default([]),
  note: z.string().max(500).default(''),
  expiresAt: z.coerce.date().nullable().default(null),
});

/** Normalises the value per kind; throws on invalid input. */
export function normaliseWhitelistValue(kind: 'player' | 'resource' | 'model', value: string): string {
  if (kind === 'player') {
    const id = parseIdentifier(value);
    if (!id || id.type === 'ip' || id.type === 'token') throw badRequest('Player whitelist needs a license/discord/fivem/steam/xbl/live identifier');
    return formatIdentifier(id);
  }
  if (kind === 'resource') {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value)) throw badRequest('Invalid resource name');
    return value;
  }
  // model: name (e.g. "adder") or numeric hash
  if (!/^(-?\d{1,10}|[A-Za-z0-9_]{1,64})$/.test(value)) throw badRequest('Invalid model name or hash');
  return value.toLowerCase();
}

export async function addWhitelist(app: FastifyInstance, serverId: string, raw: unknown, actor: Actor): Promise<WhitelistRow> {
  const body = parse(whitelistBody, raw);
  const value = normaliseWhitelistValue(body.kind, body.value);
  if (body.expiresAt && body.expiresAt.getTime() <= Date.now()) throw badRequest('expiresAt must be in the future');
  return withTx(app.db, async (tx) => {
    const r = await tx.query<WhitelistRow>(
      `INSERT INTO whitelist_entries (server_id, kind, value, modules, note, created_by, created_by_label, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (server_id, kind, value) DO NOTHING RETURNING ${WL_COLUMNS}`,
      [serverId, body.kind, value, [...new Set(body.modules)], body.note, actor.userId ?? null, actor.label, body.expiresAt],
    );
    if (!r.rows[0]) throw conflict('Entry already exists');
    await audit(tx, actor, { serverId, action: 'whitelist.add', targetType: 'whitelist', targetId: r.rows[0].id, details: { ...body, value } });
    await publish(tx, { serverId, type: 'whitelist.changed', data: {} });
    await enqueueCommand(tx, serverId, 'config_sync', { reason: 'whitelist' }, actor.userId ?? null);
    return r.rows[0];
  });
}

export async function removeWhitelist(app: FastifyInstance, serverId: string, id: string, actor: Actor): Promise<void> {
  await withTx(app.db, async (tx) => {
    const r = await tx.query<WhitelistRow>(`DELETE FROM whitelist_entries WHERE id = $1 AND server_id = $2 RETURNING ${WL_COLUMNS}`, [id, serverId]);
    if (!r.rows[0]) throw notFound('Entry not found');
    await audit(tx, actor, { serverId, action: 'whitelist.remove', targetType: 'whitelist', targetId: id, details: { kind: r.rows[0].kind, value: r.rows[0].value } });
    await publish(tx, { serverId, type: 'whitelist.changed', data: {} });
    await enqueueCommand(tx, serverId, 'config_sync', { reason: 'whitelist' }, actor.userId ?? null);
  });
}

export default async function whitelistRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/whitelist', { preHandler: app.requireServer('whitelist.view') }, async (req) => {
    const q = parse(z.object({ kind: z.enum(['player', 'resource', 'model']).optional() }), req.query);
    const rows = (
      await app.db.query<WhitelistRow>(
        `SELECT ${WL_COLUMNS} FROM whitelist_entries WHERE server_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY created_at DESC`,
        [req.access!.serverId, q.kind ?? null],
      )
    ).rows;
    return { items: rows.map((r) => ({ ...r, expired: !!r.expires_at && r.expires_at.getTime() <= Date.now() })) };
  });

  app.post('/servers/:serverId/whitelist', { preHandler: app.requireServer('whitelist.manage') }, async (req) => {
    return { entry: await addWhitelist(app, req.access!.serverId, req.body, req.actor()) };
  });

  app.delete('/servers/:serverId/whitelist/:id', { preHandler: app.requireServer('whitelist.manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await removeWhitelist(app, req.access!.serverId, id, req.actor());
    return { ok: true };
  });
}
