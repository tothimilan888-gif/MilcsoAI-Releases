import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import {
  generateTotpSecret, getDummyHash, hashPassword, totpUri, verifyPassword, verifyTotp,
} from '../lib/crypto.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { PERMISSIONS } from '../lib/permissions.js';
import { parseIdentifier } from '../lib/identifiers.js';
import { clearSessionCookie, createSession, setSessionCookie } from '../plugins/auth.js';

export const passwordSchema = z
  .string()
  .min(12, 'Legalább 12 karakter')
  .max(200)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Tartalmazzon kis- és nagybetűt, valamint számot');

// One message for unknown user, wrong password and locked account, so accounts cannot be enumerated.
const LOGIN_FAILED = 'Hibás bejelentkezési adatok, vagy a fiók átmenetileg zárolva van';

export default async function authRoutes(app: FastifyInstance) {
  const loginLimit = { rateLimit: { max: app.cfg.LOGIN_RATE_LIMIT, timeWindow: '5 minutes' } };

  app.post('/login', { config: loginLimit }, async (req, reply) => {
    const body = parse(z.object({ login: z.string().min(1).max(200), password: z.string().min(1).max(200) }), req.body);
    const user = (
      await app.db.query<{
        id: string; username: string; password_hash: string; totp_enabled: boolean; failed_logins: number;
        locked_until: Date | null; disabled_at: Date | null;
      }>(
        `SELECT id, username, password_hash, totp_enabled, failed_logins, locked_until, disabled_at
           FROM users WHERE lower(email) = lower($1) OR lower(username) = lower($1)`,
        [body.login],
      )
    ).rows[0];

    if (!user) {
      await verifyPassword(body.password, await getDummyHash()); // equalise timing
      throw unauthorized(LOGIN_FAILED);
    }
    if (user.locked_until && user.locked_until > new Date()) {
      throw unauthorized(LOGIN_FAILED);
    }
    const ok = await verifyPassword(body.password, user.password_hash);
    if (!ok || user.disabled_at) {
      const fails = user.failed_logins + 1;
      const lock = fails >= app.cfg.LOGIN_MAX_ATTEMPTS ? new Date(Date.now() + app.cfg.LOGIN_LOCK_MINUTES * 60_000) : null;
      await app.db.query('UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1', [user.id, lock ? 0 : fails, lock]);
      await audit(app.db, { type: 'user', userId: user.id, label: user.username, ip: req.ip }, {
        serverId: null, action: lock ? 'auth.lockout' : 'auth.login_failed', details: {},
      });
      throw unauthorized(LOGIN_FAILED);
    }
    await app.db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    const session = await createSession(app, user.id, !user.totp_enabled, req);
    setSessionCookie(app, reply, session);
    await audit(app.db, { type: 'user', userId: user.id, label: user.username, ip: req.ip }, { serverId: null, action: 'auth.login', details: {} });
    return { mfaRequired: user.totp_enabled, csrfToken: session.csrfToken };
  });

  app.post('/mfa', { config: loginLimit, preHandler: app.authenticate }, async (req) => {
    const body = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    const u = req.user!;
    if (!u.totpEnabled) throw badRequest('Two-factor authentication is not enabled');
    if (u.mfaPassed) return { ok: true };
    const row = (await app.db.query<{ totp_secret_enc: string }>('SELECT totp_secret_enc FROM users WHERE id = $1', [u.userId])).rows[0];
    if (!row?.totp_secret_enc || !verifyTotp(app.enc.decrypt(row.totp_secret_enc), body.code)) {
      await audit(app.db, req.actor(), { serverId: null, action: 'auth.mfa_failed' });
      throw unauthorized('Hibás kód');
    }
    await app.db.query('UPDATE sessions SET mfa_passed = true WHERE id = $1', [u.sessionId]);
    return { ok: true };
  });

  app.post('/logout', { preHandler: app.authenticate }, async (req, reply) => {
    await app.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.user!.sessionId]);
    clearSessionCookie(app, reply);
    return { ok: true };
  });

  app.get('/me', { preHandler: app.authenticate }, async (req) => {
    const u = req.user!;
    const servers = (
      await app.db.query<{ id: string; name: string; slug: string; role_key: string; role_name: string; level: number; permissions: string[] }>(
        u.isPlatformAdmin
          ? `SELECT s.id, s.name, s.slug, 'owner' AS role_key, 'Owner' AS role_name, 100 AS level, '{}'::text[] AS permissions
               FROM servers s WHERE s.deleted_at IS NULL ORDER BY s.name`
          : `SELECT s.id, s.name, s.slug, r.key AS role_key, r.name AS role_name, r.level,
                    COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
               FROM server_members m JOIN servers s ON s.id = m.server_id AND s.deleted_at IS NULL
               JOIN roles r ON r.id = m.role_id LEFT JOIN role_permissions rp ON rp.role_id = r.id
              WHERE m.user_id = $1 GROUP BY s.id, r.id ORDER BY s.name`,
        u.isPlatformAdmin ? [] : [u.userId],
      )
    ).rows;
    return {
      user: { id: u.userId, email: u.email, username: u.username, isPlatformAdmin: u.isPlatformAdmin, totpEnabled: u.totpEnabled },
      mfaPending: u.totpEnabled && !u.mfaPassed,
      mustChangePassword: u.mustChangePassword,
      csrfToken: u.csrfToken,
      servers: servers.map((s) => ({
        id: s.id, name: s.name, slug: s.slug,
        role: { key: s.role_key, name: s.role_name, level: s.level },
        permissions: u.isPlatformAdmin ? [...PERMISSIONS] : s.permissions,
      })),
    };
  });

  app.post('/password', { config: loginLimit, preHandler: app.authenticate }, async (req) => {
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema }), req.body);
    const u = req.user!;
    const row = (await app.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [u.userId])).rows[0]!;
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) throw unauthorized('A jelenlegi jelszó hibás');
    if (body.currentPassword === body.newPassword) throw badRequest('Az új jelszó nem egyezhet a régivel');
    await app.db.query(
      'UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now(), updated_at = now() WHERE id = $1',
      [u.userId, await hashPassword(body.newPassword)],
    );
    // All other sessions are invalidated after a password change.
    await app.db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [u.userId, u.sessionId]);
    await audit(app.db, req.actor(), { serverId: null, action: 'auth.password_change' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- TOTP enrolment
  app.post('/totp/setup', { preHandler: app.authenticate }, async (req) => {
    const u = req.user!;
    if (u.totpEnabled) throw badRequest('Two-factor authentication is already enabled');
    const secret = generateTotpSecret();
    await app.db.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [u.userId, app.enc.encrypt(secret)]);
    return { secret, uri: totpUri(secret, u.email) };
  });

  app.post('/totp/enable', { config: loginLimit, preHandler: app.authenticate }, async (req) => {
    const body = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    const u = req.user!;
    const row = (await app.db.query<{ totp_secret_enc: string | null; totp_enabled: boolean }>('SELECT totp_secret_enc, totp_enabled FROM users WHERE id = $1', [u.userId])).rows[0]!;
    if (row.totp_enabled) throw badRequest('Already enabled');
    if (!row.totp_secret_enc) throw badRequest('Run setup first');
    if (!verifyTotp(app.enc.decrypt(row.totp_secret_enc), body.code)) throw unauthorized('Hibás kód');
    await app.db.query('UPDATE users SET totp_enabled = true, updated_at = now() WHERE id = $1', [u.userId]);
    await app.db.query('UPDATE sessions SET mfa_passed = true WHERE id = $1', [u.sessionId]);
    await audit(app.db, req.actor(), { serverId: null, action: 'auth.totp_enabled' });
    return { ok: true };
  });

  app.post('/totp/disable', { config: loginLimit, preHandler: app.authenticate }, async (req) => {
    const body = parse(z.object({ password: z.string().min(1).max(200), code: z.string().regex(/^\d{6}$/) }), req.body);
    const u = req.user!;
    const row = (await app.db.query<{ password_hash: string; totp_secret_enc: string | null }>('SELECT password_hash, totp_secret_enc FROM users WHERE id = $1', [u.userId])).rows[0]!;
    if (!(await verifyPassword(body.password, row.password_hash))) throw unauthorized('Hibás jelszó');
    if (!row.totp_secret_enc || !verifyTotp(app.enc.decrypt(row.totp_secret_enc), body.code)) throw unauthorized('Hibás kód');
    await app.db.query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, updated_at = now() WHERE id = $1', [u.userId]);
    await audit(app.db, req.actor(), { serverId: null, action: 'auth.totp_disabled' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- sessions
  app.get('/sessions', { preHandler: app.authenticate }, async (req) => {
    const rows = (
      await app.db.query(
        `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
        [req.user!.userId],
      )
    ).rows;
    return { items: rows.map((r) => ({ ...r, current: r.id === req.user!.sessionId })) };
  });

  app.delete('/sessions/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const r = await app.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, req.user!.userId]);
    if (!r.rowCount) throw notFound('Session not found');
    await audit(app.db, req.actor(), { serverId: null, action: 'auth.session_revoked', targetType: 'session', targetId: id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- linked FiveM identifiers
  app.get('/identifiers', { preHandler: app.authenticate }, async (req) => {
    const rows = (await app.db.query("SELECT type || ':' || value AS identifier, created_at FROM user_identifiers WHERE user_id = $1", [req.user!.userId])).rows;
    return { items: rows };
  });

  app.post('/identifiers', { preHandler: app.authenticate }, async (req) => {
    const body = parse(z.object({ identifier: z.string().max(100) }), req.body);
    const id = parseIdentifier(body.identifier);
    if (!id || id.type === 'ip' || id.type === 'token') throw badRequest('Csak license, license2, discord, fivem, steam, xbl vagy live azonosító köthető');
    const r = await app.db.query('INSERT INTO user_identifiers (user_id, type, value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [req.user!.userId, id.type, id.value]);
    if (!r.rowCount) throw forbidden('Ez az azonosító már egy fiókhoz van kötve');
    await audit(app.db, req.actor(), { serverId: null, action: 'auth.identifier_linked', details: { identifier: `${id.type}:${id.value}` } });
    return { ok: true };
  });

  app.delete('/identifiers/:identifier', { preHandler: app.authenticate }, async (req) => {
    const { identifier } = parse(z.object({ identifier: z.string().max(100) }), req.params);
    const id = parseIdentifier(identifier);
    if (!id) throw badRequest('Invalid identifier');
    const r = await app.db.query('DELETE FROM user_identifiers WHERE user_id = $1 AND type = $2 AND value = $3', [req.user!.userId, id.type, id.value]);
    if (!r.rowCount) throw notFound();
    await audit(app.db, req.actor(), { serverId: null, action: 'auth.identifier_unlinked', details: { identifier } });
    return { ok: true };
  });
}
