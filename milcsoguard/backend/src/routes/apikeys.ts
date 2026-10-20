import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { generateApiKey } from '../lib/crypto.js';
import { conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const KEY_COLUMNS = 'id, name, prefix, scopes, created_at, expires_at, last_used_at, last_used_ip, revoked_at, rotated_from';

export default async function apiKeyRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/api-keys', { preHandler: app.requireServer('apikeys.manage') }, async (req) => {
    const rows = (await app.db.query(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE server_id = $1 ORDER BY created_at DESC`, [req.access!.serverId])).rows;
    return { items: rows };
  });

  app.post('/servers/:serverId/api-keys', { preHandler: app.requireServer('apikeys.manage') }, async (req) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(64), expiresInDays: z.number().int().min(1).max(3650).nullable().default(null) }), req.body);
    const key = generateApiKey();
    const row = (
      await app.db.query(
        `INSERT INTO api_keys (server_id, name, prefix, key_hash, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END) RETURNING ${KEY_COLUMNS}`,
        [req.access!.serverId, body.name, key.prefix, key.hash, req.user!.userId, body.expiresInDays],
      )
    ).rows[0];
    await audit(app.db, req.actor(), { serverId: req.access!.serverId, action: 'apikey.create', targetType: 'api_key', targetId: row.id, details: { name: body.name, prefix: key.prefix } });
    // The plaintext key is returned exactly once and never stored.
    return { key: row, secret: key.full };
  });

  app.post('/servers/:serverId/api-keys/:keyId/revoke', { preHandler: app.requireServer('apikeys.manage') }, async (req) => {
    const { keyId } = parse(z.object({ keyId: z.uuid() }), req.params);
    const r = await app.db.query(
      'UPDATE api_keys SET revoked_at = now(), revoked_by = $3 WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL RETURNING prefix',
      [keyId, req.access!.serverId, req.user!.userId],
    );
    if (!r.rowCount) throw notFound('Active key not found');
    await audit(app.db, req.actor(), { serverId: req.access!.serverId, action: 'apikey.revoke', targetType: 'api_key', targetId: keyId, details: { prefix: r.rows[0].prefix } });
    return { ok: true };
  });

  app.post('/servers/:serverId/api-keys/:keyId/rotate', { preHandler: app.requireServer('apikeys.manage') }, async (req) => {
    const { keyId } = parse(z.object({ keyId: z.uuid() }), req.params);
    // graceMinutes lets the old key keep working until the new one is deployed to server.cfg.
    const body = parse(z.object({ graceMinutes: z.number().int().min(0).max(24 * 60).default(60) }), req.body ?? {});
    const sid = req.access!.serverId;
    const result = await withTx(app.db, async (tx) => {
      const old = (await tx.query<{ name: string; revoked_at: Date | null }>('SELECT name, revoked_at FROM api_keys WHERE id = $1 AND server_id = $2 FOR UPDATE', [keyId, sid])).rows[0];
      if (!old) throw notFound('Key not found');
      if (old.revoked_at) throw conflict('Key already revoked');
      const key = generateApiKey();
      const row = (
        await tx.query(
          `INSERT INTO api_keys (server_id, name, prefix, key_hash, created_by, rotated_from) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${KEY_COLUMNS}`,
          [sid, old.name, key.prefix, key.hash, req.user!.userId, keyId],
        )
      ).rows[0];
      if (body.graceMinutes === 0) {
        await tx.query('UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [keyId, req.user!.userId]);
      } else {
        await tx.query(
          'UPDATE api_keys SET expires_at = LEAST(COALESCE(expires_at, now() + make_interval(mins => $2)), now() + make_interval(mins => $2)) WHERE id = $1',
          [keyId, body.graceMinutes],
        );
      }
      await audit(tx, req.actor(), { serverId: sid, action: 'apikey.rotate', targetType: 'api_key', targetId: row.id, details: { from: keyId, graceMinutes: body.graceMinutes } });
      return { key: row, secret: key.full };
    });
    return result;
  });
}
