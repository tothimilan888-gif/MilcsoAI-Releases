/**
 * Bootstraps the first platform administrator.
 *   npm run create-owner -- --email owner@example.com --username owner
 * The password is read from MG_OWNER_PASSWORD or generated and printed once.
 */
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { createPool } from '../src/db/pool.js';
import { migrateUp } from '../src/db/migrate.js';
import { hashPassword } from '../src/lib/crypto.js';
import { passwordSchema } from '../src/routes/auth.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, username: { type: 'string' } } });
if (!values.email || !values.username) {
  console.error('usage: npm run create-owner -- --email <email> --username <name>');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const generated = !process.env.MG_OWNER_PASSWORD;
const password = process.env.MG_OWNER_PASSWORD ?? `${crypto.randomBytes(12).toString('base64url')}Aa1`;
const check = passwordSchema.safeParse(password);
if (!check.success) {
  console.error(`Weak password: ${check.error.issues.map((i) => i.message).join(', ')}`);
  process.exit(1);
}

const db = createPool(url, 2);
try {
  await migrateUp(db, () => undefined);
  const existing = await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1) OR lower(username) = lower($2)', [values.email, values.username]);
  if (existing.rowCount) {
    console.error('A user with this email or username already exists');
    process.exitCode = 1;
  } else {
    await db.query(
      'INSERT INTO users (email, username, password_hash, is_platform_admin, must_change_password) VALUES ($1, $2, $3, true, $4)',
      [values.email, values.username, await hashPassword(password), generated],
    );
    console.log(`Platform owner "${values.username}" created.`);
    if (generated) console.log(`Temporary password (change it on first login): ${password}`);
  }
} finally {
  await db.end();
}
