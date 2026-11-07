/**
 * Operator recovery for a platform admin who cannot log in. Run from a shell with DATABASE_URL set:
 *   MG_NEW_PASSWORD='…' node dist/scripts/set-password.js --username <name>
 * The new password must meet the normal policy and is changed again at the first login.
 */
import { parseArgs } from 'node:util';
import { createPool } from '../src/db/pool.js';
import { migrateUp } from '../src/db/migrate.js';
import { resetPassword } from '../src/services/passwordReset.js';

const { values } = parseArgs({ options: { username: { type: 'string' } } });
const url = process.env.DATABASE_URL;
const password = process.env.MG_NEW_PASSWORD;
if (!values.username || !url || !password) {
  console.error('usage: MG_NEW_PASSWORD=… DATABASE_URL=… node dist/scripts/set-password.js --username <name>');
  process.exit(1);
}

const db = createPool(url, 2);
try {
  await migrateUp(db, () => undefined);
  const r = await resetPassword(db, values.username, password);
  if (r.ok) console.log(`Password for "${values.username}" set. Log in and change it again.`);
  else {
    console.error(`Not changed: ${r.error}`);
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
