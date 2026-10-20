import type { Queryable } from '../db/pool.js';

export type ActorType = 'user' | 'game_admin' | 'system' | 'api_key';

export interface Actor {
  type: ActorType;
  userId?: string | null;
  label: string;
  ip?: string | null;
}

export interface AuditEntry {
  serverId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

export async function audit(db: Queryable, actor: Actor, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (server_id, actor_type, actor_user_id, actor_label, action, target_type, target_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.serverId,
      actor.type,
      actor.userId ?? null,
      actor.label.slice(0, 120),
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(entry.details ?? {}),
      actor.ip ?? null,
    ],
  );
}

export const SYSTEM_ACTOR: Actor = { type: 'system', label: 'system' };
