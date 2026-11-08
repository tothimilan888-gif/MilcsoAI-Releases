import type { Queryable } from '../db/pool.js';
import { audit, type Actor } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { formatIdentifier, parseIdentifier, type Identifier } from '../lib/identifiers.js';
import { isPermission } from '../lib/permissions.js';
import { enqueueCommand } from './commands.js';

/** Identifier types that identify a person reliably enough to carry admin rights (never ip / token). */
export const GAME_ADMIN_TYPES = ['license', 'license2', 'fivem', 'discord', 'steam'] as const;

export function parseAdminIdentifier(raw: string): Identifier | null {
  const id = parseIdentifier(raw.trim());
  return id && (GAME_ADMIN_TYPES as readonly string[]).includes(id.type) ? id : null;
}

export interface GameAdminRow {
  id: string;
  identifier: string;
  name: string;
  note: string;
  role_id: string;
  role_key: string;
  role_name: string;
  level: number;
  created_by_label: string;
  created_at: Date;
}

export async function listGameAdmins(db: Queryable, serverId: string): Promise<GameAdminRow[]> {
  return (
    await db.query<GameAdminRow>(
      `SELECT g.id, g.identifier_type || ':' || g.identifier_value AS identifier, g.name, g.note, g.role_id,
              r.key AS role_key, r.name AS role_name, r.level, g.created_by_label, g.created_at
         FROM game_admins g JOIN roles r ON r.id = g.role_id
        WHERE g.server_id = $1 ORDER BY r.level DESC, g.name, g.created_at`,
      [serverId],
    )
  ).rows;
}

export interface ResolvedAdmin {
  userId: string | null;
  username: string;
  roleKey: string;
  roleName: string;
  level: number;
  permissions: string[];
}

/** The strongest identifier-based admin grant matching any of the player's identifiers. */
export async function resolveGameAdmin(db: Queryable, serverId: string, ids: Identifier[]): Promise<ResolvedAdmin | null> {
  const usable = ids.filter((i) => (GAME_ADMIN_TYPES as readonly string[]).includes(i.type));
  if (!usable.length) return null;
  const row = (
    await db.query<{ name: string; ident: string; key: string; role_name: string; level: number; permissions: string[] }>(
      `SELECT g.name, g.identifier_type || ':' || g.identifier_value AS ident, r.key, r.name AS role_name, r.level,
              COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
         FROM game_admins g JOIN roles r ON r.id = g.role_id LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE g.server_id = $1 AND (g.identifier_type, g.identifier_value) IN (SELECT * FROM unnest($2::text[], $3::text[]))
        GROUP BY g.id, r.id ORDER BY r.level DESC LIMIT 1`,
      [serverId, usable.map((i) => i.type), usable.map((i) => i.value)],
    )
  ).rows[0];
  if (!row) return null;
  return { userId: null, username: row.name || row.ident, roleKey: row.key, roleName: row.role_name, level: row.level, permissions: row.permissions.filter(isPermission) };
}

interface RoleRef { id: string; key: string; name: string; level: number; permissions: string[] }

export async function findRole(db: Queryable, serverId: string, by: { id?: string; key?: string }): Promise<RoleRef> {
  const r = (
    await db.query<RoleRef>(
      `SELECT r.id, r.key, r.name, r.level, COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE (r.server_id IS NULL OR r.server_id = $1) AND ($2::uuid IS NULL OR r.id = $2) AND ($3::text IS NULL OR r.key = $3)
        GROUP BY r.id ORDER BY r.server_id NULLS LAST LIMIT 1`,
      [serverId, by.id ?? null, by.key ?? null],
    )
  ).rows[0];
  if (!r) throw notFound('Role not found');
  return r;
}

/** Who is acting, for the escalation guard. `permissions` null = trust the game server's own check. */
export interface Assigner { level: number; permissions: Set<string> | null }

function assertBelow(actor: Assigner, level: number, what: string) {
  if (actor.level < 100 && level >= actor.level) throw forbidden(`You can only manage ${what} below your own level`);
}

/** Adds or changes an identifier-based admin. Same escalation rules as web members. */
export async function upsertGameAdmin(
  db: Queryable,
  serverId: string,
  input: { identifier: string; name: string; note: string; role: RoleRef },
  assigner: Assigner,
  actor: Actor,
) {
  const id = parseAdminIdentifier(input.identifier);
  if (!id) throw badRequest(`Invalid identifier. Use one of: ${GAME_ADMIN_TYPES.map((t) => `${t}:…`).join(', ')}`);
  assertBelow(assigner, input.role.level, 'roles');
  if (assigner.permissions) {
    const missing = input.role.permissions.filter((p) => !assigner.permissions!.has(p));
    if (missing.length) throw forbidden(`Role grants permissions you do not have: ${missing.join(', ')}`);
  }
  const existing = (
    await db.query<{ level: number }>(
      'SELECT r.level FROM game_admins g JOIN roles r ON r.id = g.role_id WHERE g.server_id = $1 AND g.identifier_type = $2 AND g.identifier_value = $3',
      [serverId, id.type, id.value],
    )
  ).rows[0];
  if (existing) assertBelow(assigner, existing.level, 'admins');
  const row = (
    await db.query<{ id: string }>(
      `INSERT INTO game_admins (server_id, identifier_type, identifier_value, name, role_id, note, created_by, created_by_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (server_id, identifier_type, identifier_value)
       DO UPDATE SET role_id = EXCLUDED.role_id, name = CASE WHEN EXCLUDED.name = '' THEN game_admins.name ELSE EXCLUDED.name END,
                     note = EXCLUDED.note, updated_at = now()
       RETURNING id`,
      [serverId, id.type, id.value, input.name.slice(0, 64), input.role.id, input.note.slice(0, 300), actor.userId ?? null, actor.label.slice(0, 120)],
    )
  ).rows[0]!;
  const identifier = formatIdentifier(id);
  await audit(db, actor, { serverId, action: existing ? 'game_admin.update' : 'game_admin.add', targetType: 'game_admin', targetId: row.id, details: { identifier, name: input.name, role: input.role.key } });
  // Online players with this identifier get their new rights without reconnecting.
  await enqueueCommand(db, serverId, 'admin_refresh', { identifiers: [identifier] }, actor.userId ?? null);
  return { id: row.id, identifier, created: !existing };
}

export async function removeGameAdmin(db: Queryable, serverId: string, where: { id?: string; identifier?: string }, assigner: Assigner, actor: Actor) {
  let typeValue: [string, string] | null = null;
  if (where.identifier) {
    const id = parseAdminIdentifier(where.identifier);
    if (!id) throw badRequest('Invalid identifier');
    typeValue = [id.type, id.value];
  }
  const row = (
    await db.query<{ id: string; ident: string; level: number; name: string }>(
      `SELECT g.id, g.identifier_type || ':' || g.identifier_value AS ident, r.level, g.name
         FROM game_admins g JOIN roles r ON r.id = g.role_id
        WHERE g.server_id = $1 AND ($2::uuid IS NULL OR g.id = $2) AND ($3::text IS NULL OR (g.identifier_type = $3 AND g.identifier_value = $4))`,
      [serverId, where.id ?? null, typeValue?.[0] ?? null, typeValue?.[1] ?? null],
    )
  ).rows[0];
  if (!row) throw notFound('Admin not found');
  assertBelow(assigner, row.level, 'admins');
  await db.query('DELETE FROM game_admins WHERE id = $1', [row.id]);
  await audit(db, actor, { serverId, action: 'game_admin.remove', targetType: 'game_admin', targetId: row.id, details: { identifier: row.ident, name: row.name } });
  await enqueueCommand(db, serverId, 'admin_refresh', { identifiers: [row.ident] }, actor.userId ?? null);
  return { removed: row.ident };
}
