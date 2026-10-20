import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from '../lib/fp.js';
import { parseApiKey, safeEqual, sha256 } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export default fp(async function gamePlugin(app: FastifyInstance) {
  app.decorateRequest('game', undefined);

  app.decorate('requireGame', async function requireGame(req: FastifyRequest) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw unauthorized('Missing API key');
    const full = header.slice(7).trim();
    const parsed = parseApiKey(full);
    if (!parsed) throw unauthorized('Malformed API key');

    if (app.cfg.NODE_ENV === 'production' && req.protocol !== 'https' && !app.cfg.ALLOW_INSECURE_GAME_HTTP) {
      throw forbidden('Game API requires HTTPS (configure TLS or TRUST_PROXY behind a TLS terminating proxy)');
    }

    const row = (
      await app.db.query<{ id: string; server_id: string; key_hash: string; name: string; scopes: string[]; last_used_at: Date | null }>(
        `SELECT k.id, k.server_id, k.key_hash, k.name, k.scopes, k.last_used_at
           FROM api_keys k JOIN servers s ON s.id = k.server_id
          WHERE k.prefix = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
            AND s.deleted_at IS NULL`,
        [parsed.prefix],
      )
    ).rows[0];
    // Constant-ish time: always hash and compare, even when the prefix is unknown.
    const candidate = sha256(full);
    if (!row || !safeEqual(candidate, row.key_hash)) throw unauthorized('Invalid or revoked API key');
    if (!row.scopes.includes('game')) throw forbidden('API key lacks the game scope');

    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) {
      await app.db.query('UPDATE api_keys SET last_used_at = now(), last_used_ip = $2 WHERE id = $1', [row.id, req.ip]);
    }
    req.game = { serverId: row.server_id, apiKeyId: row.id, keyName: row.name };
  });
});
