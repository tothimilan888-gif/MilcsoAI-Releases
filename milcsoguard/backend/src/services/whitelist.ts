import type { Queryable } from '../db/pool.js';
import type { Identifier } from '../lib/identifiers.js';
import { formatIdentifier } from '../lib/identifiers.js';

export interface WhitelistRow {
  id: string;
  kind: 'player' | 'resource' | 'model';
  value: string;
  modules: string[];
  note: string;
  created_by_label: string;
  created_at: Date;
  expires_at: Date | null;
}

export const WL_COLUMNS = 'id, kind, value, modules, note, created_by_label, created_at, expires_at';

export async function activeWhitelist(db: Queryable, serverId: string): Promise<WhitelistRow[]> {
  return (
    await db.query<WhitelistRow>(
      `SELECT ${WL_COLUMNS} FROM whitelist_entries WHERE server_id = $1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY kind, value`,
      [serverId],
    )
  ).rows;
}

export async function playerWhitelist(db: Queryable, serverId: string, identifiers: Identifier[]): Promise<WhitelistRow[]> {
  if (!identifiers.length) return [];
  return (
    await db.query<WhitelistRow>(
      `SELECT ${WL_COLUMNS} FROM whitelist_entries
        WHERE server_id = $1 AND kind = 'player' AND value = ANY($2::text[]) AND (expires_at IS NULL OR expires_at > now())`,
      [serverId, identifiers.map(formatIdentifier)],
    )
  ).rows;
}
