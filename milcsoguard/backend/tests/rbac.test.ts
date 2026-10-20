import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, Client, createApiKey, createServer, createUser, game, LICENSE_A, setupApp, teardown, type TestCtx } from './helpers.js';
import { detection } from './fixtures.js';

let ctx: TestCtx;
let A: string;
let B: string;
const users: Record<string, string> = {};
const clients: Record<string, Client> = {};

async function roleId(key: string) {
  return (await ctx.db.query("SELECT id FROM roles WHERE key = $1 AND server_id IS NULL", [key])).rows[0].id as string;
}

beforeAll(async () => {
  ctx = await setupApp();
  A = await createServer(ctx.db, 'server-a');
  B = await createServer(ctx.db, 'server-b');
  for (const [name, role] of [['owner', 'owner'], ['ctrl', 'admin_controller'], ['admin', 'administrator'], ['mod', 'moderator'], ['viewer', 'viewer'], ['dev', 'developer']] as const) {
    users[name] = await createUser(ctx.db, name);
    await addMember(ctx.db, A, users[name]!, role);
    clients[name] = new Client(ctx.app);
    await clients[name]!.login(name);
  }
  users.bonly = await createUser(ctx.db, 'bonly');
  await addMember(ctx.db, B, users.bonly, 'owner');
  clients.bonly = new Client(ctx.app);
  await clients.bonly.login('bonly');
});
afterAll(() => teardown(ctx));

describe('permission enforcement on the backend', () => {
  it('viewer can read but cannot kick, ban, review or change settings', async () => {
    const v = clients.viewer!;
    expect((await v.req('GET', `/api/v1/servers/${A}/detections`)).statusCode).toBe(200);
    expect((await v.req('POST', `/api/v1/servers/${A}/bans`, { identifiers: [LICENSE_A], reason: 'test ban', durationSeconds: 3600 })).statusCode).toBe(403);
    expect((await v.req('GET', `/api/v1/servers/${A}/audit`)).statusCode).toBe(403);
    expect((await v.req('PUT', `/api/v1/servers/${A}/config`, { overrides: {}, expectedVersion: 0, note: 'x x x' })).statusCode).toBe(403);
    expect((await v.req('GET', `/api/v1/servers/${A}/api-keys`)).statusCode).toBe(403);
  });

  it('moderator may issue temporary but not permanent bans, and cannot unban', async () => {
    const m = clients.mod!;
    const temp = await m.req('POST', `/api/v1/servers/${A}/bans`, { identifiers: [LICENSE_A], reason: 'temp ban', durationSeconds: 3600 });
    expect(temp.statusCode).toBe(200);
    const perm = await m.req('POST', `/api/v1/servers/${A}/bans`, { identifiers: [LICENSE_A], reason: 'perm ban', durationSeconds: null });
    expect(perm.statusCode).toBe(403);
    expect((await m.req('POST', `/api/v1/servers/${A}/bans/${temp.json().ban.id}/revoke`, { reason: 'try' })).statusCode).toBe(403);
  });

  it('masks identifiers for roles without players.identifiers', async () => {
    const res = await clients.mod!.req('GET', `/api/v1/servers/${A}/bans`);
    const ban = res.json().items[0];
    expect(ban.identifiers[0]).toMatch(/…/);
    const full = await clients.admin!.req('GET', `/api/v1/servers/${A}/bans`);
    expect(full.json().items[0].identifiers).toContain(LICENSE_A);
  });

  it('requires a reason for destructive actions', async () => {
    const res = await clients.admin!.req('POST', `/api/v1/servers/${A}/bans`, { identifiers: [LICENSE_A], reason: '', durationSeconds: 3600 });
    expect(res.statusCode).toBe(400);
  });
});

describe('multi-server data separation', () => {
  it('a member of server A cannot see server B (404, not 403)', async () => {
    expect((await clients.owner!.req('GET', `/api/v1/servers/${B}`)).statusCode).toBe(404);
    expect((await clients.owner!.req('GET', `/api/v1/servers/${B}/detections`)).statusCode).toBe(404);
    expect((await clients.bonly!.req('GET', `/api/v1/servers/${A}/bans`)).statusCode).toBe(404);
  });

  it('an API key of server A only writes into server A', async () => {
    const keyA = await createApiKey(ctx.db, A);
    const res = await game(ctx.app, keyA)('POST', '/detections', { detections: [detection('sep-test-0001')] });
    expect(res.statusCode).toBe(200);
    const inA = (await clients.owner!.req('GET', `/api/v1/servers/${A}/detections`)).json();
    const inB = (await clients.bonly!.req('GET', `/api/v1/servers/${B}/detections`)).json();
    expect(inA.total).toBe(1);
    expect(inB.total).toBe(0);
  });

  it('a ban on server A does not block the player on server B', async () => {
    const keyB = await createApiKey(ctx.db, B);
    const res = await game(ctx.app, keyB)('POST', '/players/connect', { name: 'X', identifiers: [LICENSE_A] });
    expect(res.json().ban).toBeNull();
  });

  it('cannot access another server\'s ban by id through own server path', async () => {
    const banA = (await clients.admin!.req('GET', `/api/v1/servers/${A}/bans`)).json().items[0];
    expect((await clients.bonly!.req('GET', `/api/v1/servers/${B}/bans/${banA.id}`)).statusCode).toBe(404);
    expect((await clients.bonly!.req('POST', `/api/v1/servers/${B}/bans/${banA.id}/revoke`, { reason: 'cross tenant' })).statusCode).toBe(404);
  });
});

describe('privilege escalation guards', () => {
  it('an AdminController cannot assign Developer or Owner roles', async () => {
    const c = clients.ctrl!;
    const u = await createUser(ctx.db, 'newbie');
    await addMember(ctx.db, A, u, 'viewer');
    expect((await c.req('PATCH', `/api/v1/servers/${A}/members/${u}`, { roleId: await roleId('developer') })).statusCode).toBe(403);
    expect((await c.req('PATCH', `/api/v1/servers/${A}/members/${u}`, { roleId: await roleId('admin_controller') })).statusCode).toBe(403);
    expect((await c.req('PATCH', `/api/v1/servers/${A}/members/${u}`, { roleId: await roleId('moderator') })).statusCode).toBe(200);
  });

  it('nobody can change their own role', async () => {
    const res = await clients.ctrl!.req('PATCH', `/api/v1/servers/${A}/members/${users.ctrl}`, { roleId: await roleId('owner') });
    expect(res.statusCode).toBe(403);
  });

  it('cannot modify members at or above own level', async () => {
    expect((await clients.ctrl!.req('DELETE', `/api/v1/servers/${A}/members/${users.dev}`)).statusCode).toBe(403);
  });

  it('custom roles cannot contain permissions the creator lacks', async () => {
    const res = await clients.dev!.req('POST', `/api/v1/servers/${A}/roles`, { key: 'sneaky', name: 'Sneaky', level: 50, permissions: ['servers.manage'] });
    expect(res.statusCode).toBe(403);
    const ok = await clients.dev!.req('POST', `/api/v1/servers/${A}/roles`, { key: 'helper', name: 'Helper', level: 30, permissions: ['detections.view'] });
    expect(ok.statusCode).toBe(200);
    const tooHigh = await clients.dev!.req('POST', `/api/v1/servers/${A}/roles`, { key: 'boss', name: 'Boss', level: 95, permissions: [] });
    expect(tooHigh.statusCode).toBe(403);
  });

  it('the last owner cannot be demoted or removed, and changes are audited', async () => {
    const extra = await createUser(ctx.db, 'owner2');
    await addMember(ctx.db, A, extra, 'owner');
    const c = new Client(ctx.app);
    await c.login('owner2');
    // owner2 demotes the original owner: allowed (two owners exist)
    expect((await c.req('PATCH', `/api/v1/servers/${A}/members/${users.owner}`, { roleId: await roleId('developer') })).statusCode).toBe(200);
    // now owner2 is the last owner; the demoted user (developer) cannot touch owner2
    expect((await clients.owner!.req('PATCH', `/api/v1/servers/${A}/members/${extra}`, { roleId: await roleId('viewer') })).statusCode).toBe(403);
    const audit = await ctx.db.query("SELECT details FROM audit_logs WHERE action = 'member.role_change' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0].details).toEqual({ from: 'owner', to: 'developer' });
  });

  it('only platform admins can create servers', async () => {
    expect((await clients.dev!.req('POST', '/api/v1/servers', { name: 'Evil', slug: 'evil' })).statusCode).toBe(403);
    await createUser(ctx.db, 'root', { platformAdmin: true });
    const r = new Client(ctx.app);
    await r.login('root');
    const res = await r.req('POST', '/api/v1/servers', { name: 'New server', slug: 'new-server' });
    expect(res.statusCode).toBe(200);
  });

  it('adding a member returns a one-time temporary password and forces a change', async () => {
    const res = await clients.ctrl!.req('POST', `/api/v1/servers/${A}/members`, { email: 'helper@test.local', username: 'helper1', roleId: await roleId('moderator') });
    expect(res.statusCode).toBe(200);
    const pw = res.json().temporaryPassword as string;
    expect(pw.length).toBeGreaterThan(12);
    const c = new Client(ctx.app);
    expect((await c.login('helper1', pw)).statusCode).toBe(200);
    expect((await c.req('GET', `/api/v1/servers/${A}/detections`)).statusCode).toBe(403);
  });
});
