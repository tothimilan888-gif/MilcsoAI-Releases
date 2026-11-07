import type { Queryable } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { passwordSchema } from '../routes/auth.js';

export type ResetResult = { ok: true; userId: string } | { ok: false; error: string };

/**
 * Operator recovery: sets a new password for an existing user, forces a change at the next login,
 * clears the lockout and ends every session. Only reachable from a shell with DATABASE_URL.
 */
export async function resetPassword(db: Queryable, username: string, password: string): Promise<ResetResult> {
  const strength = passwordSchema.safeParse(password);
  if (!strength.success) return { ok: false, error: strength.error.issues.map((i) => i.message).join(', ') };
  const found = await db.query<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
  if (found.rowCount === 0) return { ok: false, error: `no user named "${username}"` };
  if (found.rowCount! > 1) return { ok: false, error: 'more than one user matches' };
  const userId = found.rows[0]!.id;
  await db.query(
    `UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL,
            password_changed_at = now(), updated_at = now() WHERE id = $1`,
    [userId, await hashPassword(password)],
  );
  await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  await audit(db, { type: 'system', label: 'operator:set-password' }, { serverId: null, action: 'user.password_reset_cli', targetType: 'user', targetId: userId, details: {} });
  return { ok: true, userId };
}
