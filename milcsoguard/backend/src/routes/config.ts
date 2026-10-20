import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../db/pool.js';
import { audit, type Actor } from '../lib/audit.js';
import { configSchemaDescriptor, validateOverrides } from '../lib/configSchema.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { publish } from '../lib/realtime.js';
import { parse } from '../lib/validate.js';
import { enqueueCommand } from '../services/commands.js';

export async function getConfig(app: FastifyInstance, serverId: string) {
  const row = (
    await app.db.query<{ version: number; overrides: unknown; schema: unknown; effective: unknown; updated_at: Date }>(
      'SELECT version, overrides, schema, effective, updated_at FROM server_configs WHERE server_id = $1',
      [serverId],
    )
  ).rows[0];
  if (!row) throw notFound('Config not found');
  return row;
}

export async function saveConfig(
  app: FastifyInstance,
  serverId: string,
  overrides: unknown,
  expectedVersion: number,
  note: string,
  actor: Actor,
) {
  return withTx(app.db, async (tx) => {
    const cur = (
      await tx.query<{ version: number; schema: unknown; overrides: unknown }>('SELECT version, schema, overrides FROM server_configs WHERE server_id = $1 FOR UPDATE', [serverId])
    ).rows[0];
    if (!cur) throw notFound('Config not found');
    if (cur.version !== expectedVersion) throw conflict(`Config was changed by someone else (current version ${cur.version}); reload and retry`);
    const schema = configSchemaDescriptor.safeParse(cur.schema);
    if (!schema.success) throw conflict('The game server has not reported its settings schema yet. Start the resource once with the API connection configured.');
    const v = validateOverrides(schema.data, overrides);
    if (!v.ok) throw unprocessable('Invalid configuration', v.issues);
    const version = cur.version + 1;
    await tx.query('UPDATE server_configs SET version = $2, overrides = $3, updated_by = $4, updated_at = now() WHERE server_id = $1', [
      serverId, version, JSON.stringify(v.value), actor.userId ?? null,
    ]);
    await tx.query(
      'INSERT INTO server_config_history (server_id, version, overrides, changed_by, changed_by_label, note) VALUES ($1,$2,$3,$4,$5,$6)',
      [serverId, version, JSON.stringify(v.value), actor.userId ?? null, actor.label, note],
    );
    await audit(tx, actor, { serverId, action: 'config.update', targetType: 'config', targetId: String(version), details: { note, before: cur.overrides, after: v.value } });
    await tx.query(
      "INSERT INTO system_events (server_id, type, severity, message, data) VALUES ($1, 'config_change', 'INFO', $2, $3)",
      [serverId, `Konfiguráció módosítva (v${version}) – ${actor.label}`, JSON.stringify({ version })],
    );
    await enqueueCommand(tx, serverId, 'config_sync', { version }, actor.userId ?? null);
    await publish(tx, { serverId, type: 'config.changed', data: { version } });
    return { version, overrides: v.value };
  });
}

export default async function configRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/config', { preHandler: app.requireServer('settings.view') }, async (req) => {
    const row = await getConfig(app, req.access!.serverId);
    const history = (
      await app.db.query('SELECT version, changed_by_label, note, created_at FROM server_config_history WHERE server_id = $1 ORDER BY version DESC LIMIT 25', [req.access!.serverId])
    ).rows;
    return { ...row, history, canEdit: req.access!.permissions.has('settings.manage') };
  });

  app.put('/servers/:serverId/config', { preHandler: app.requireServer('settings.manage') }, async (req) => {
    const body = parse(
      z.object({ overrides: z.unknown(), expectedVersion: z.number().int().min(0), note: z.string().trim().min(3, 'Indoklás kötelező').max(500) }),
      req.body,
    );
    return saveConfig(app, req.access!.serverId, body.overrides, body.expectedVersion, body.note, req.actor());
  });

  app.post('/servers/:serverId/config/rollback', { preHandler: app.requireServer('settings.manage') }, async (req) => {
    const body = parse(z.object({ version: z.number().int().min(1), expectedVersion: z.number().int().min(0) }), req.body);
    const h = (
      await app.db.query<{ overrides: unknown }>('SELECT overrides FROM server_config_history WHERE server_id = $1 AND version = $2', [req.access!.serverId, body.version])
    ).rows[0];
    if (!h) throw notFound('Version not found');
    return saveConfig(app, req.access!.serverId, h.overrides, body.expectedVersion, `Visszaállítás a v${body.version} verzióra`, req.actor());
  });
}
