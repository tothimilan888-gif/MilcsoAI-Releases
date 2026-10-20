import type { Db } from '../db/pool.js';
import { hashPassword } from '../lib/crypto.js';
import { passwordSchema } from '../routes/auth.js';

export interface BootstrapEnv {
  BOOTSTRAP_OWNER_EMAIL?: string;
  BOOTSTRAP_OWNER_USERNAME?: string;
  BOOTSTRAP_OWNER_PASSWORD?: string;
}

/**
 * Creates the first platform owner from environment variables, for hosts without a shell (e.g. Render).
 * It only acts while NO platform admin exists, forces a password change at first login, and never
 * touches existing accounts – so leaving the variables set is harmless, but they should be removed.
 */
export async function bootstrapOwner(db: Db, env: BootstrapEnv, log: (m: string) => void): Promise<boolean> {
  const { BOOTSTRAP_OWNER_EMAIL: email, BOOTSTRAP_OWNER_USERNAME: username, BOOTSTRAP_OWNER_PASSWORD: password } = env;
  if (!email && !username && !password) return false;
  if (!email || !username || !password) {
    log('bootstrap owner skipped: BOOTSTRAP_OWNER_EMAIL, _USERNAME and _PASSWORD must all be set');
    return false;
  }
  const exists = await db.query('SELECT 1 FROM users WHERE is_platform_admin = true LIMIT 1');
  if (exists.rowCount) return false;
  const strength = passwordSchema.safeParse(password);
  if (!strength.success) {
    log(`bootstrap owner skipped: weak password (${strength.error.issues.map((i) => i.message).join(', ')})`);
    return false;
  }
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username) || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    log('bootstrap owner skipped: invalid username or email');
    return false;
  }
  await db.query(
    'INSERT INTO users (email, username, password_hash, is_platform_admin, must_change_password) VALUES ($1, $2, $3, true, true)',
    [email, username, await hashPassword(password)],
  );
  log(`bootstrap owner "${username}" created; change the password at first login and remove the BOOTSTRAP_OWNER_* variables`);
  return true;
}
