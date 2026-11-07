import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetPassword } from '../src/services/passwordReset.js';
import { Client, createUser, PASSWORD, setupApp, teardown, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupApp();
  await createUser(ctx.db, 'recovery', { platformAdmin: true });
});
afterAll(() => teardown(ctx));

describe('operator password reset', () => {
  it('rejects weak passwords and unknown users without changing anything', async () => {
    expect((await resetPassword(ctx.db, 'recovery', 'short')).ok).toBe(false);
    expect((await resetPassword(ctx.db, 'nobody', 'Recovery-Pass-1234')).ok).toBe(false);
    const c = new Client(ctx.app);
    expect((await c.login('recovery', PASSWORD)).statusCode).toBe(200);
  });

  it('sets the new password, clears the lockout, ends sessions and forces a change', async () => {
    await ctx.db.query("UPDATE users SET failed_logins = 3, locked_until = now() + interval '1 hour' WHERE username = 'recovery'");
    const session = new Client(ctx.app);
    await session.login('recovery', PASSWORD);
    const r = await resetPassword(ctx.db, 'RECOVERY', 'Recovery-Pass-1234');
    expect(r.ok).toBe(true);
    expect((await session.req('GET', '/api/v1/auth/me')).statusCode).toBe(401);
    const old = await new Client(ctx.app).login('recovery', PASSWORD);
    expect(old.statusCode).toBe(401);
    const fresh = await new Client(ctx.app).login('recovery', 'Recovery-Pass-1234');
    expect(fresh.statusCode).toBe(200);
    const me = await new Client(ctx.app).login('recovery', 'Recovery-Pass-1234');
    expect(me.statusCode).toBe(200);
    const row = (await ctx.db.query("SELECT must_change_password, locked_until FROM users WHERE username = 'recovery'")).rows[0];
    expect(row).toMatchObject({ must_change_password: true, locked_until: null });
    const audit = await ctx.db.query("SELECT 1 FROM audit_logs WHERE action = 'user.password_reset_cli'");
    expect(audit.rowCount).toBe(1);
  });
});
