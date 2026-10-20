import type { Queryable } from '../db/pool.js';

export const PERMISSIONS = [
  'players.view',
  'players.identifiers',
  'players.kick',
  'detections.view',
  'detections.review',
  'bans.view',
  'bans.create',
  'bans.permanent',
  'bans.remove',
  'whitelist.view',
  'whitelist.manage',
  'admins.view',
  'admins.manage',
  'roles.manage',
  'settings.view',
  'settings.manage',
  'audit.view',
  'analytics.view',
  'system.view',
  'apikeys.manage',
  'integrations.manage',
  'servers.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'players.view': 'Játékosok listázása és profiljuk megtekintése',
  'players.identifiers': 'Teljes azonosítók (license, discord, steam…) megtekintése',
  'players.kick': 'Játékos kickelése',
  'detections.view': 'Detektálások megtekintése',
  'detections.review': 'Detektálások felülvizsgálata, téves riasztás jelölése',
  'bans.view': 'Banok megtekintése',
  'bans.create': 'Időszakos ban kiadása',
  'bans.permanent': 'Végleges ban kiadása',
  'bans.remove': 'Ban feloldása',
  'whitelist.view': 'Whitelist megtekintése',
  'whitelist.manage': 'Whitelist bejegyzések kezelése',
  'admins.view': 'Adminok listázása',
  'admins.manage': 'Adminok hozzáadása, szerepkör módosítása (csak alacsonyabb szintig)',
  'roles.manage': 'Egyedi szerepkörök kezelése',
  'settings.view': 'Anticheat konfiguráció megtekintése',
  'settings.manage': 'Anticheat konfiguráció módosítása',
  'audit.view': 'Auditnapló megtekintése',
  'analytics.view': 'Statisztikák megtekintése',
  'system.view': 'Rendszerállapot megtekintése',
  'apikeys.manage': 'Játékszerver API-kulcsok kezelése',
  'integrations.manage': 'Integrációk (Discord webhook) kezelése',
  'servers.manage': 'Szerver beállításai, adatmegőrzés, törlés',
};

const ALL = [...PERMISSIONS];
const without = (...p: Permission[]) => ALL.filter((x) => !p.includes(x));

export interface SystemRole {
  key: string;
  name: string;
  level: number;
  permissions: Permission[];
}

export const SYSTEM_ROLES: SystemRole[] = [
  { key: 'owner', name: 'Owner', level: 100, permissions: ALL },
  { key: 'developer', name: 'Developer', level: 90, permissions: without('servers.manage') },
  {
    key: 'server_manager',
    name: 'Server Manager',
    level: 80,
    permissions: without('servers.manage', 'apikeys.manage', 'roles.manage'),
  },
  {
    key: 'admin_controller',
    name: 'AdminController',
    level: 70,
    permissions: [
      'players.view', 'players.identifiers', 'players.kick',
      'detections.view', 'detections.review',
      'bans.view', 'bans.create', 'bans.permanent', 'bans.remove',
      'whitelist.view', 'whitelist.manage',
      'admins.view', 'admins.manage',
      'settings.view', 'audit.view', 'analytics.view', 'system.view',
    ],
  },
  {
    key: 'administrator',
    name: 'Administrator',
    level: 60,
    permissions: [
      'players.view', 'players.identifiers', 'players.kick',
      'detections.view', 'detections.review',
      'bans.view', 'bans.create', 'bans.permanent', 'bans.remove',
      'whitelist.view', 'whitelist.manage',
      'settings.view', 'analytics.view', 'system.view',
    ],
  },
  {
    key: 'moderator',
    name: 'Moderator',
    level: 40,
    permissions: [
      'players.view', 'players.kick',
      'detections.view', 'detections.review',
      'bans.view', 'bans.create',
      'whitelist.view', 'analytics.view',
    ],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    level: 10,
    permissions: ['players.view', 'detections.view', 'bans.view', 'whitelist.view', 'analytics.view', 'system.view'],
  },
];

export function isPermission(p: string): p is Permission {
  return (PERMISSIONS as readonly string[]).includes(p);
}

/** Idempotently creates the built-in roles and resets their permission sets to the code definition. */
export async function seedSystemRoles(db: Queryable): Promise<void> {
  for (const r of SYSTEM_ROLES) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO roles (server_id, key, name, level, is_system) VALUES (NULL, $1, $2, $3, true)
       ON CONFLICT (key) WHERE server_id IS NULL DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level, updated_at = now()
       RETURNING id`,
      [r.key, r.name, r.level],
    );
    const id = res.rows[0]!.id;
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
    await db.query(
      'INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[])',
      [id, r.permissions],
    );
  }
}

export interface MemberAccess {
  serverId: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  level: number;
  permissions: Set<Permission>;
  viaPlatformAdmin: boolean;
}

/**
 * Resolves a user's effective access on a server. Platform admins are treated as owners
 * on every server (they bootstrap the installation).
 */
export async function resolveAccess(
  db: Queryable,
  userId: string,
  isPlatformAdmin: boolean,
  serverId: string,
): Promise<MemberAccess | null> {
  const server = await db.query('SELECT 1 FROM servers WHERE id = $1 AND deleted_at IS NULL', [serverId]);
  if (server.rowCount === 0) return null;

  const res = await db.query<{ role_id: string; key: string; name: string; level: number; perms: string[] }>(
    `SELECT r.id AS role_id, r.key, r.name, r.level,
            COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS perms
       FROM server_members m
       JOIN roles r ON r.id = m.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE m.server_id = $1 AND m.user_id = $2
      GROUP BY r.id`,
    [serverId, userId],
  );
  const row = res.rows[0];
  if (row) {
    return {
      serverId,
      roleId: row.role_id,
      roleKey: row.key,
      roleName: row.name,
      level: isPlatformAdmin ? 100 : row.level,
      permissions: new Set(isPlatformAdmin ? PERMISSIONS : row.perms.filter(isPermission)),
      viaPlatformAdmin: isPlatformAdmin,
    };
  }
  if (isPlatformAdmin) {
    const owner = await db.query<{ id: string }>("SELECT id FROM roles WHERE key = 'owner' AND server_id IS NULL");
    return {
      serverId,
      roleId: owner.rows[0]!.id,
      roleKey: 'owner',
      roleName: 'Owner',
      level: 100,
      permissions: new Set(PERMISSIONS),
      viaPlatformAdmin: true,
    };
  }
  return null;
}
