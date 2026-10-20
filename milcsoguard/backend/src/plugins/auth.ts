import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from '../lib/fp.js';
import { randomToken, sha256, safeEqual } from '../lib/crypto.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import { resolveAccess, type Permission } from '../lib/permissions.js';
import type { SessionUser } from '../types.js';

export function sessionCookieName(secure: boolean) {
  // The __Host- prefix forces Secure, Path=/ and no Domain attribute in browsers.
  return secure ? '__Host-mg_session' : 'mg_session';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Routes reachable while MFA or a forced password change is pending.
const PENDING_ALLOWED = new Set(['/api/v1/auth/me', '/api/v1/auth/logout', '/api/v1/auth/mfa', '/api/v1/auth/password']);

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(
  app: FastifyInstance,
  userId: string,
  mfaPassed: boolean,
  req: FastifyRequest,
): Promise<CreatedSession> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + app.cfg.SESSION_ABSOLUTE_HOURS * 3600_000);
  await app.db.query(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, mfa_passed, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, sha256(token), csrfToken, mfaPassed, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), expiresAt],
  );
  return { token, csrfToken, expiresAt };
}

export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, s: CreatedSession) {
  reply.setCookie(sessionCookieName(app.cfg.cookieSecure), s.token, {
    httpOnly: true,
    secure: app.cfg.cookieSecure,
    sameSite: 'strict',
    path: '/',
    expires: s.expiresAt,
  });
}

export function clearSessionCookie(app: FastifyInstance, reply: FastifyReply) {
  reply.clearCookie(sessionCookieName(app.cfg.cookieSecure), { path: '/' });
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', undefined);
  app.decorateRequest('access', undefined);

  app.decorate('authenticate', async function authenticate(req: FastifyRequest) {
    const token = req.cookies[sessionCookieName(app.cfg.cookieSecure)];
    if (!token) throw unauthorized();
    const idleCutoff = new Date(Date.now() - app.cfg.SESSION_IDLE_MINUTES * 60_000);
    const row = (
      await app.db.query<{
        id: string; user_id: string; csrf_token: string; mfa_passed: boolean; last_seen_at: Date;
        email: string; username: string; is_platform_admin: boolean; totp_enabled: boolean; must_change_password: boolean;
      }>(
        `SELECT s.id, s.user_id, s.csrf_token, s.mfa_passed, s.last_seen_at,
                u.email, u.username, u.is_platform_admin, u.totp_enabled, u.must_change_password
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
            AND s.last_seen_at > $2 AND u.disabled_at IS NULL`,
        [sha256(token), idleCutoff],
      )
    ).rows[0];
    if (!row) throw unauthorized('Session expired or invalid');

    const user: SessionUser = {
      sessionId: row.id,
      userId: row.user_id,
      email: row.email,
      username: row.username,
      isPlatformAdmin: row.is_platform_admin,
      totpEnabled: row.totp_enabled,
      mfaPassed: row.mfa_passed,
      mustChangePassword: row.must_change_password,
      csrfToken: row.csrf_token,
    };

    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, row.csrf_token)) {
        throw forbidden('Missing or invalid CSRF token');
      }
    }

    const path = req.routeOptions.url ?? '';
    const pending = (user.totpEnabled && !user.mfaPassed) || user.mustChangePassword;
    if (pending && !PENDING_ALLOWED.has(path)) {
      throw forbidden(user.mustChangePassword ? 'Password change required' : 'Two-factor verification required');
    }

    // Throttle last_seen updates to one write per minute per session.
    if (Date.now() - row.last_seen_at.getTime() > 60_000) {
      await app.db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.id]);
    }
    req.user = user;
  });

  app.decorate('requireServer', function requireServer(perm?: Permission | Permission[]) {
    return async function (req: FastifyRequest) {
      await app.authenticate(req);
      const serverId = (req.params as { serverId?: string }).serverId;
      if (!serverId || !/^[0-9a-f-]{36}$/i.test(serverId)) throw notFound('Server not found');
      const access = await resolveAccess(app.db, req.user!.userId, req.user!.isPlatformAdmin, serverId);
      // Non-members get 404 rather than 403 so server ids cannot be probed.
      if (!access) throw notFound('Server not found');
      const needed = perm === undefined ? [] : Array.isArray(perm) ? perm : [perm];
      for (const p of needed) {
        if (!access.permissions.has(p)) throw forbidden(`Missing permission: ${p}`);
      }
      req.access = access;
    };
  });
});
