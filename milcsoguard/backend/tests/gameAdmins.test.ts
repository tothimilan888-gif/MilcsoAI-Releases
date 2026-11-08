import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, Client, createApiKey, createServer, createUser, game, LICENSE_A, LICENSE_B, setupApp, teardown, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let sid: string;
let g: ReturnType<typeof game>;
let owner: Client;
let controller: Client;
let moderator: Client;
const roleId = async (key: string) => (await ctx.db.query('SELECT id FROM roles WHERE key = $1 AND server_id IS NULL', [key])).rows[0].id as string;
const LICENSE_C = 'license:' + 'c'.repeat(40);
const ace = (name: string) => ({ name, identifiers: ['license:' + 'f'.repeat(40)], source: 'ace' });

beforeAll(async () => {
  ctx = await setupApp();
  sid = await createServer(ctx.db, 'ga-srv');
  g = game(ctx.app, await createApiKey(ctx.db, sid));
  for (const [n, r] of [['gaowner', 'owner'], ['gactl', 'admin_controller'], ['gamod', 'moderator']] as const) await addMember(ctx.db, sid, await createUser(ctx.db, n), r);
  owner = new Client(ctx.app); await owner.login('gaowner');
  controller = new Client(ctx.app); await controller.login('gactl');
  moderator = new Client(ctx.app); await moderator.login('gamod');
});
afterAll(() => teardown(ctx));

describe('identifier-based admins from the dashboard', () => {
  it('owner adds a license as administrator; the game sees it on connect and gets a refresh command', async () => {
    const res = await owner.req('POST', `/api/v1/servers/${sid}/game-admins`, { identifier: LICENSE_A, name: 'Pista', roleId: await roleId('administrator') });
    expect(res.statusCode).toBe(200);
    expect(res.json().admin.created).toBe(true);
    const list = (await owner.req('GET', `/api/v1/servers/${sid}/game-admins`)).json().items;
    expect(list[0]).toMatchObject({ identifier: LICENSE_A, name: 'Pista', role_key: 'administrator', level: 60 });
    const conn = (await g('POST', '/players/connect', { name: 'Pista', identifiers: [LICENSE_A, 'ip:1.2.3.4'] })).json();
    expect(conn.admin).toMatchObject({ role: 'administrator', level: 60 });
    expect(conn.admin.permissions).toContain('bans.create');
    const cmds = (await g('GET', '/commands')).json().commands;
    expect(cmds.find((c: { type: string }) => c.type === 'admin_refresh').payload.identifiers).toEqual([LICENSE_A]);
  });

  it('enforces the escalation rules', async () => {
    expect((await moderator.req('POST', `/api/v1/servers/${sid}/game-admins`, { identifier: LICENSE_B, roleId: await roleId('viewer') })).statusCode).toBe(403);
    // AdminController (70) may give Administrator (60) but not Server Manager (80) or its own level
    expect((await controller.req('POST', `/api/v1/servers/${sid}/game-admins`, { identifier: LICENSE_B, roleId: await roleId('server_manager') })).statusCode).toBe(403);
    expect((await controller.req('POST', `/api/v1/servers/${sid}/game-admins`, { identifier: LICENSE_B, roleId: await roleId('admin_controller') })).statusCode).toBe(403);
    expect((await controller.req('POST', `/api/v1/servers/${sid}/game-admins`, { identifier: LICENSE_B, roleId: await roleId('moderator') })).statusCode).toBe(200);
    // ip / token identifiers can never carry admin rights
    expect((await owner.req('POST', `/api/v1/servers/${sid}/game-admins`, { identifier: 'ip:1.2.3.4', roleId: await roleId('viewer') })).statusCode).toBe(400);
  });

  it('a controller cannot remove or downgrade an admin at or above their level', async () => {
    await owner.req('POST', `/api/v1/servers/${sid}/game-admins`, { identifier: LICENSE_C, roleId: await roleId('server_manager') });
    const id = (await owner.req('GET', `/api/v1/servers/${sid}/game-admins`)).json().items.find((x: { identifier: string }) => x.identifier === LICENSE_C).id;
    expect((await controller.req('DELETE', `/api/v1/servers/${sid}/game-admins/${id}`)).statusCode).toBe(403);
    expect((await controller.req('POST', `/api/v1/servers/${sid}/game-admins`, { identifier: LICENSE_C, roleId: await roleId('viewer') })).statusCode).toBe(403);
    expect((await owner.req('DELETE', `/api/v1/servers/${sid}/game-admins/${id}`)).statusCode).toBe(200);
    const audit = (await ctx.db.query("SELECT action FROM audit_logs WHERE action LIKE 'game_admin.%'")).rows.map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['game_admin.add', 'game_admin.remove']));
  });
});

describe('identifier-based admins from the game server', () => {
  it('an ACE admin adds a moderator by license; the game server\'s level check is applied again', async () => {
    const tooHigh = await g('POST', '/admin/game-admins', { identifier: LICENSE_C, roleKey: 'administrator', actor: ace('AceAdmin'), actorLevel: 60 });
    expect(tooHigh.statusCode).toBe(403);
    const ok = await g('POST', '/admin/game-admins', { identifier: LICENSE_C, name: 'Józsi', roleKey: 'moderator', actor: ace('AceAdmin'), actorLevel: 60 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().grant).toMatchObject({ role: 'moderator', level: 40, username: 'Józsi' });
    expect((await g('POST', '/admins/resolve', { identifiers: [LICENSE_C] })).json().admin.level).toBe(40);
    const a = (await ctx.db.query("SELECT actor_label FROM audit_logs WHERE action = 'game_admin.add' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(a.actor_label).toContain('ingame:AceAdmin');
  });

  it('an identifier admin without admins.manage cannot add admins in game', async () => {
    const asMod = { name: 'Józsi', identifiers: [LICENSE_C], source: 'backend' };
    expect((await g('POST', '/admin/game-admins', { identifier: 'license:' + 'd'.repeat(40), roleKey: 'viewer', actor: asMod, actorLevel: 100 })).statusCode).toBe(403);
  });

  it('removes by identifier and the grant disappears', async () => {
    expect((await g('POST', '/admin/game-admins/remove', { identifier: LICENSE_C, actor: ace('AceAdmin'), actorLevel: 60 })).statusCode).toBe(200);
    expect((await g('POST', '/admins/resolve', { identifiers: [LICENSE_C] })).json().admin).toBeNull();
  });
});
