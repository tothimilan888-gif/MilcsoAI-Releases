import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx, type Queryable } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { isPermission, PERMISSION_DESCRIPTIONS, PERMISSIONS, type MemberAccess } from '../lib/permissions.js';
import { parse } from '../lib/validate.js';

interface RoleInfo {
  id: string;
  key: string;
  name: string;
  level: number;
  is_system: boolean;
  server_id: string | null;
  permissions: string[];
}

async function loadRole(db: Queryable, serverId: string, roleId: string): Promise<RoleInfo> {
  const r = (
    await db.query<RoleInfo>(
      `SELECT r.id, r.key, r.name, r.level, r.is_system, r.server_id,
              COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.id = $1 AND (r.server_id IS NULL OR r.server_id = $2) GROUP BY r.id`,
      [roleId, serverId],
    )
  ).rows[0];
  if (!r) throw notFound('Role not found');
  return r;
}

/**
 * Privilege-escalation guard shared by every membership change:
 *  - nobody changes their own role;
 *  - only members strictly below the actor can be modified (owners excepted);
 *  - the assigned role must be strictly below the actor (owners may assign owner);
 *  - the assigned role may not carry permissions the actor does not have.
 */
export function assertCanAssign(actor: MemberAccess, actorUserId: string, targetUserId: string, targetLevel: number | null, role: { level: number; permissions: string[] } | null) {
  const isOwner = actor.level >= 100;
  if (actorUserId === targetUserId) throw forbidden('You cannot change your own role');
  if (targetLevel !== null && targetLevel >= actor.level && !isOwner) throw forbidden('You can only manage members below your own level');
  if (role) {
    if (role.level >= actor.level && !isOwner) throw forbidden('You can only assign roles below your own level');
    const missing = role.permissions.filter((p) => !actor.permissions.has(p as never));
    if (missing.length) throw forbidden(`Role grants permissions you do not have: ${missing.join(', ')}`);
  }
}

async function ownerCount(db: Queryable, serverId: string): Promise<number> {
  return (
    await db.query<{ n: number }>(
      "SELECT count(*) AS n FROM server_members m JOIN roles r ON r.id = m.role_id WHERE m.server_id = $1 AND r.key = 'owner' AND r.server_id IS NULL",
      [serverId],
    )
  ).rows[0]!.n;
}

export default async function memberRoutes(app: FastifyInstance) {
  app.get('/permissions', { preHandler: app.authenticate }, async () => ({
    items: PERMISSIONS.map((p) => ({ key: p, description: PERMISSION_DESCRIPTIONS[p] })),
  }));

  app.get('/servers/:serverId/roles', { preHandler: app.requireServer('admins.view') }, async (req) => {
    const rows = (
      await app.db.query<RoleInfo>(
        `SELECT r.id, r.key, r.name, r.level, r.is_system, r.server_id,
                COALESCE(array_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.server_id IS NULL OR r.server_id = $1 GROUP BY r.id ORDER BY r.level DESC, r.name`,
        [req.access!.serverId],
      )
    ).rows;
    return {
      items: rows.map((r) => ({
        ...r,
        assignable: (r.level < req.access!.level || req.access!.level >= 100) && r.permissions.every((p) => req.access!.permissions.has(p as never)),
      })),
    };
  });

  const roleBody = z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    name: z.string().trim().min(2).max(40),
    level: z.number().int().min(1).max(99),
    permissions: z.array(z.string()).max(PERMISSIONS.length),
  });

  app.post('/servers/:serverId/roles', { preHandler: app.requireServer('roles.manage') }, async (req) => {
    const body = parse(roleBody, req.body);
    const access = req.access!;
    const perms = [...new Set(body.permissions)];
    const bad = perms.filter((p) => !isPermission(p));
    if (bad.length) throw badRequest(`Unknown permissions: ${bad.join(', ')}`);
    if (body.level >= access.level) throw forbidden('Custom role level must be below your own level');
    const missing = perms.filter((p) => !access.permissions.has(p as never));
    if (missing.length) throw forbidden(`You cannot grant permissions you do not have: ${missing.join(', ')}`);
    const role = await withTx(app.db, async (tx) => {
      const clash = await tx.query('SELECT 1 FROM roles WHERE key = $1 AND (server_id IS NULL OR server_id = $2)', [body.key, access.serverId]);
      if (clash.rowCount) throw conflict('Role key already exists');
      const r = (await tx.query<{ id: string }>('INSERT INTO roles (server_id, key, name, level) VALUES ($1,$2,$3,$4) RETURNING id', [access.serverId, body.key, body.name, body.level])).rows[0]!;
      await tx.query('INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [r.id, perms]);
      await audit(tx, req.actor(), { serverId: access.serverId, action: 'role.create', targetType: 'role', targetId: r.id, details: { ...body, permissions: perms } });
      return loadRole(tx, access.serverId, r.id);
    });
    return { role };
  });

  app.put('/servers/:serverId/roles/:roleId', { preHandler: app.requireServer('roles.manage') }, async (req) => {
    const { roleId } = parse(z.object({ roleId: z.uuid() }), req.params);
    const body = parse(roleBody.omit({ key: true }), req.body);
    const access = req.access!;
    const role = await withTx(app.db, async (tx) => {
      const cur = await loadRole(tx, access.serverId, roleId);
      if (cur.is_system || cur.server_id !== access.serverId) throw forbidden('Built-in roles cannot be edited');
      if (cur.level >= access.level || body.level >= access.level) throw forbidden('You can only edit roles below your own level');
      const perms = [...new Set(body.permissions)];
      const missing = perms.filter((p) => !isPermission(p) || !access.permissions.has(p as never));
      if (missing.length) throw forbidden(`Invalid or ungrantable permissions: ${missing.join(', ')}`);
      await tx.query('UPDATE roles SET name = $2, level = $3, updated_at = now() WHERE id = $1', [roleId, body.name, body.level]);
      await tx.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      await tx.query('INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [roleId, perms]);
      await audit(tx, req.actor(), {
        serverId: access.serverId, action: 'role.update', targetType: 'role', targetId: roleId,
        details: { before: { name: cur.name, level: cur.level, permissions: cur.permissions }, after: { ...body, permissions: perms } },
      });
      return loadRole(tx, access.serverId, roleId);
    });
    return { role };
  });

  app.delete('/servers/:serverId/roles/:roleId', { preHandler: app.requireServer('roles.manage') }, async (req) => {
    const { roleId } = parse(z.object({ roleId: z.uuid() }), req.params);
    const access = req.access!;
    await withTx(app.db, async (tx) => {
      const cur = await loadRole(tx, access.serverId, roleId);
      if (cur.is_system || cur.server_id !== access.serverId) throw forbidden('Built-in roles cannot be deleted');
      if (cur.level >= access.level) throw forbidden('You can only delete roles below your own level');
      const used = await tx.query('SELECT 1 FROM server_members WHERE role_id = $1 LIMIT 1', [roleId]);
      if (used.rowCount) throw conflict('Role is still assigned to members');
      await tx.query('DELETE FROM roles WHERE id = $1', [roleId]);
      await audit(tx, req.actor(), { serverId: access.serverId, action: 'role.delete', targetType: 'role', targetId: roleId, details: { key: cur.key } });
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- members
  app.get('/servers/:serverId/members', { preHandler: app.requireServer('admins.view') }, async (req) => {
    const rows = (
      await app.db.query(
        `SELECT u.id AS user_id, u.username, u.email, u.totp_enabled, u.last_login_at, u.disabled_at, m.created_at AS added_at,
                r.id AS role_id, r.key AS role_key, r.name AS role_name, r.level,
                COALESCE((SELECT array_agg(ui.type || ':' || ui.value) FROM user_identifiers ui WHERE ui.user_id = u.id), '{}') AS identifiers
           FROM server_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
          WHERE m.server_id = $1 ORDER BY r.level DESC, u.username`,
        [req.access!.serverId],
      )
    ).rows;
    const canSeeEmail = req.access!.permissions.has('admins.manage');
    return {
      items: rows.map((r) => ({
        ...r,
        email: canSeeEmail ? r.email : undefined,
        manageable: r.user_id !== req.user!.userId && (r.level < req.access!.level || req.access!.level >= 100) && req.access!.permissions.has('admins.manage'),
      })),
    };
  });

  app.post('/servers/:serverId/members', { preHandler: app.requireServer('admins.manage') }, async (req) => {
    const body = parse(
      z.object({ email: z.email().max(200), username: z.string().regex(/^[A-Za-z0-9_.-]{2,32}$/), roleId: z.uuid() }),
      req.body,
    );
    const access = req.access!;
    const result = await withTx(app.db, async (tx) => {
      const role = await loadRole(tx, access.serverId, body.roleId);
      let user = (await tx.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE lower(email) = lower($1)', [body.email])).rows[0];
      let temporaryPassword: string | undefined;
      if (user) {
        const already = await tx.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [access.serverId, user.id]);
        if (already.rowCount) throw conflict('User is already a member of this server');
      }
      assertCanAssign(access, req.user!.userId, user?.id ?? 'new', null, role);
      if (!user) {
        const nameTaken = await tx.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [body.username]);
        if (nameTaken.rowCount) throw conflict('Username already taken');
        temporaryPassword = `${randomToken(12)}Aa1`;
        user = (
          await tx.query<{ id: string; username: string }>(
            'INSERT INTO users (email, username, password_hash, must_change_password) VALUES ($1, $2, $3, true) RETURNING id, username',
            [body.email, body.username, await hashPassword(temporaryPassword)],
          )
        ).rows[0]!;
      }
      await tx.query('INSERT INTO server_members (server_id, user_id, role_id, added_by) VALUES ($1, $2, $3, $4)', [access.serverId, user.id, role.id, req.user!.userId]);
      await audit(tx, req.actor(), {
        serverId: access.serverId, action: 'member.add', targetType: 'user', targetId: user.id,
        details: { username: user.username, role: role.key, newAccount: !!temporaryPassword },
      });
      return { userId: user.id, temporaryPassword };
    });
    // The temporary password is shown exactly once; it must be changed on first login.
    return result;
  });

  app.patch('/servers/:serverId/members/:userId', { preHandler: app.requireServer('admins.manage') }, async (req) => {
    const { userId } = parse(z.object({ userId: z.uuid() }), req.params);
    const body = parse(z.object({ roleId: z.uuid() }), req.body);
    const access = req.access!;
    await withTx(app.db, async (tx) => {
      const cur = (
        await tx.query<{ level: number; key: string; role_id: string }>(
          'SELECT r.level, r.key, r.id AS role_id FROM server_members m JOIN roles r ON r.id = m.role_id WHERE m.server_id = $1 AND m.user_id = $2 FOR UPDATE OF m',
          [access.serverId, userId],
        )
      ).rows[0];
      if (!cur) throw notFound('Member not found');
      const role = await loadRole(tx, access.serverId, body.roleId);
      assertCanAssign(access, req.user!.userId, userId, cur.level, role);
      if (cur.key === 'owner' && role.key !== 'owner' && (await ownerCount(tx, access.serverId)) <= 1) throw conflict('The last owner cannot be demoted');
      await tx.query('UPDATE server_members SET role_id = $3, updated_at = now() WHERE server_id = $1 AND user_id = $2', [access.serverId, userId, role.id]);
      await audit(tx, req.actor(), {
        serverId: access.serverId, action: 'member.role_change', targetType: 'user', targetId: userId,
        details: { from: cur.key, to: role.key },
      });
    });
    return { ok: true };
  });

  app.delete('/servers/:serverId/members/:userId', { preHandler: app.requireServer('admins.manage') }, async (req) => {
    const { userId } = parse(z.object({ userId: z.uuid() }), req.params);
    const access = req.access!;
    await withTx(app.db, async (tx) => {
      const cur = (
        await tx.query<{ level: number; key: string }>(
          'SELECT r.level, r.key FROM server_members m JOIN roles r ON r.id = m.role_id WHERE m.server_id = $1 AND m.user_id = $2 FOR UPDATE OF m',
          [access.serverId, userId],
        )
      ).rows[0];
      if (!cur) throw notFound('Member not found');
      assertCanAssign(access, req.user!.userId, userId, cur.level, null);
      if (cur.key === 'owner' && (await ownerCount(tx, access.serverId)) <= 1) throw conflict('The last owner cannot be removed');
      await tx.query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [access.serverId, userId]);
      await audit(tx, req.actor(), { serverId: access.serverId, action: 'member.remove', targetType: 'user', targetId: userId, details: { role: cur.key } });
    });
    return { ok: true };
  });
}
