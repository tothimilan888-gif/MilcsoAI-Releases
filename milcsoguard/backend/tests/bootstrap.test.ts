import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapOwner } from '../src/services/bootstrap.js';
import { Client, createUser, setupApp, teardown, type TestCtx } from './helpers.js';

let ctx: TestCtx;
const logs: string[] = [];
const log = (m: string) => logs.push(m);
const good = { BOOTSTRAP_OWNER_EMAIL: 'first@owner.test', BOOTSTRAP_OWNER_USERNAME: 'first', BOOTSTRAP_OWNER_PASSWORD: 'Str0ngBootstrapPw!' };

beforeAll(async () => { ctx = await setupApp(); });
afterAll(() => teardown(ctx));

describe('bootstrap owner (hosts without a shell)', () => {
  it('does nothing without variables, with partial variables or with a weak password', async () => {
    expect(await bootstrapOwner(ctx.db, {}, log)).toBe(false);
    expect(await bootstrapOwner(ctx.db, { BOOTSTRAP_OWNER_EMAIL: 'a@b.c' }, log)).toBe(false);
    expect(await bootstrapOwner(ctx.db, { ...good, BOOTSTRAP_OWNER_PASSWORD: 'weak' }, log)).toBe(false);
    expect((await ctx.db.query('SELECT count(*) AS n FROM users')).rows[0].n).toBe(0);
  });
  it('creates a platform owner that must change the password at first login', async () => {
    expect(await bootstrapOwner(ctx.db, good, log)).toBe(true);
    const c = new Client(ctx.app);
    expect((await c.login('first', good.BOOTSTRAP_OWNER_PASSWORD)).statusCode).toBe(200);
    const me = (await c.req('GET', '/api/v1/auth/me')).json();
    expect(me.user.isPlatformAdmin).toBe(true);
    expect(me.mustChangePassword).toBe(true);
    expect((await c.req('POST', '/api/v1/servers', { name: 'X server', slug: 'x-server' })).statusCode).toBe(403); // password change first
  });
  it('never runs again once a platform admin exists, and never touches existing accounts', async () => {
    expect(await bootstrapOwner(ctx.db, { ...good, BOOTSTRAP_OWNER_USERNAME: 'second', BOOTSTRAP_OWNER_EMAIL: 'second@owner.test' }, log)).toBe(false);
    await createUser(ctx.db, 'someone');
    expect((await ctx.db.query('SELECT count(*) AS n FROM users')).rows[0].n).toBe(2);
    expect(logs.join(' ')).not.toContain(good.BOOTSTRAP_OWNER_PASSWORD);
  });
});
