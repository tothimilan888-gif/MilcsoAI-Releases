import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../src/lib/crypto.js';
import { Client, createUser, PASSWORD, setupApp, teardown, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupApp({ LOGIN_MAX_ATTEMPTS: '3' });
  await createUser(ctx.db, 'alice');
  await createUser(ctx.db, 'bob');
  await createUser(ctx.db, 'carol');
});
afterAll(() => teardown(ctx));

describe('login', () => {
  it('logs in with username or email and returns an httpOnly strict cookie', async () => {
    const c = new Client(ctx.app);
    const res = await c.login('alice@test.local');
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const me = await c.req('GET', '/api/v1/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe('alice');
    expect(me.json()).not.toHaveProperty('user.password_hash');
  });

  it('uses one generic message for unknown user and wrong password', async () => {
    const a = await new Client(ctx.app).login('nobody', 'whatever');
    const b = await new Client(ctx.app).login('alice', 'wrong-password');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error.message).toBe(b.json().error.message);
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    for (let i = 0; i < 3; i++) await new Client(ctx.app).login('bob', 'wrong-password');
    const res = await new Client(ctx.app).login('bob', PASSWORD);
    expect(res.statusCode).toBe(401);
    const row = (await ctx.db.query('SELECT locked_until FROM users WHERE username = $1', ['bob'])).rows[0];
    expect(row.locked_until).not.toBeNull();
    const audit = await ctx.db.query("SELECT 1 FROM audit_logs WHERE action = 'auth.lockout'");
    expect(audit.rowCount).toBe(1);
  });

  it('rejects requests without a session', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects forged session cookies', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: 'mg_session=forged' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('CSRF', () => {
  it('requires the CSRF header on state-changing requests', async () => {
    const c = new Client(ctx.app);
    await c.login('alice');
    const noCsrf = await c.req('POST', '/api/v1/auth/totp/setup', {}, { csrf: false });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.message).toMatch(/CSRF/);
    c.csrf = 'wrong';
    const wrong = await c.req('POST', '/api/v1/auth/totp/setup', {});
    expect(wrong.statusCode).toBe(403);
  });
});

describe('session lifecycle', () => {
  it('expires idle sessions', async () => {
    const c = new Client(ctx.app);
    await c.login('alice');
    await ctx.db.query("UPDATE sessions SET last_seen_at = now() - interval '1 day'");
    const res = await c.req('GET', '/api/v1/auth/me');
    expect(res.statusCode).toBe(401);
  });

  it('expires sessions at their absolute lifetime', async () => {
    const c = new Client(ctx.app);
    await c.login('alice');
    await ctx.db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE revoked_at IS NULL");
    expect((await c.req('GET', '/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('logout revokes the session server-side', async () => {
    const c = new Client(ctx.app);
    await c.login('alice');
    const cookie = c.cookie;
    expect((await c.req('POST', '/api/v1/auth/logout', {})).statusCode).toBe(200);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('password change revokes other sessions and enforces strength', async () => {
    const a = new Client(ctx.app);
    const b = new Client(ctx.app);
    await a.login('carol');
    await b.login('carol');
    const weak = await a.req('POST', '/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.statusCode).toBe(400);
    const ok = await a.req('POST', '/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: 'AnotherStrong9Password' });
    expect(ok.statusCode).toBe(200);
    expect((await a.req('GET', '/api/v1/auth/me')).statusCode).toBe(200);
    expect((await b.req('GET', '/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('forces a password change before anything else when flagged', async () => {
    await ctx.db.query("UPDATE users SET must_change_password = true WHERE username = 'alice'");
    const c = new Client(ctx.app);
    await c.login('alice');
    expect((await c.req('GET', '/api/v1/auth/me')).json().mustChangePassword).toBe(true);
    expect((await c.req('GET', '/api/v1/servers')).statusCode).toBe(403);
    await c.req('POST', '/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: 'NewPassword123x' });
    expect((await c.req('GET', '/api/v1/servers')).statusCode).toBe(200);
    await ctx.db.query("UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE username = 'bob') WHERE username = 'alice'");
  });
});

describe('two-factor authentication', () => {
  it('enrols TOTP and then requires the code at login', async () => {
    await createUser(ctx.db, 'dave');
    const c = new Client(ctx.app);
    await c.login('dave');
    const setup = await c.req('POST', '/api/v1/auth/totp/setup', {});
    expect(setup.statusCode).toBe(200);
    const { secret, uri } = setup.json();
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect((await c.req('POST', '/api/v1/auth/totp/enable', { code: '000000' })).statusCode).toBe(401);
    expect((await c.req('POST', '/api/v1/auth/totp/enable', { code: totpCode(secret) })).statusCode).toBe(200);
    // The secret is stored encrypted, never in plain text.
    const row = (await ctx.db.query("SELECT totp_secret_enc FROM users WHERE username = 'dave'")).rows[0];
    expect(row.totp_secret_enc).not.toContain(secret);

    const d = new Client(ctx.app);
    const login = await d.login('dave');
    expect(login.json().mfaRequired).toBe(true);
    expect((await d.req('GET', '/api/v1/servers')).statusCode).toBe(403);
    expect((await d.req('POST', '/api/v1/auth/mfa', { code: '123456' })).statusCode).toBe(401);
    expect((await d.req('POST', '/api/v1/auth/mfa', { code: totpCode(secret) })).statusCode).toBe(200);
    expect((await d.req('GET', '/api/v1/servers')).statusCode).toBe(200);
  });
});

describe('session management', () => {
  it('lists and revokes own sessions only', async () => {
    await createUser(ctx.db, 'erin');
    const a = new Client(ctx.app);
    const b = new Client(ctx.app);
    await a.login('erin');
    await b.login('erin');
    const list = (await a.req('GET', '/api/v1/auth/sessions')).json().items;
    expect(list).toHaveLength(2);
    const other = list.find((s: { current: boolean }) => !s.current);
    expect((await a.req('DELETE', `/api/v1/auth/sessions/${other.id}`)).statusCode).toBe(200);
    expect((await b.req('GET', '/api/v1/auth/me')).statusCode).toBe(401);
    const stranger = new Client(ctx.app);
    await createUser(ctx.db, 'frank');
    await stranger.login('frank');
    const mine = (await a.req('GET', '/api/v1/auth/sessions')).json().items[0];
    expect((await stranger.req('DELETE', `/api/v1/auth/sessions/${mine.id}`)).statusCode).toBe(404);
  });
});
