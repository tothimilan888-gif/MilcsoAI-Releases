import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../src/jobs/maintenance.js';
import { addMember, Client, createApiKey, createServer, createUser, DISCORD_A, game, LICENSE_A, LICENSE_B, setupApp, teardown, type TestCtx } from './helpers.js';
import { detection, SCHEMA } from './fixtures.js';

let ctx: TestCtx;
let sid: string;
let key: string;
let g: ReturnType<typeof game>;
let admin: Client;

beforeAll(async () => {
  ctx = await setupApp();
  sid = await createServer(ctx.db, 'game-srv');
  key = await createApiKey(ctx.db, sid);
  g = game(ctx.app, key);
  const u = await createUser(ctx.db, 'boss');
  await addMember(ctx.db, sid, u, 'owner');
  admin = new Client(ctx.app);
  await admin.login('boss');
});
afterAll(() => teardown(ctx));

describe('API key authentication', () => {
  it('rejects missing, malformed and unknown keys', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/game/heartbeat', payload: { players: [] } })).statusCode).toBe(401);
    expect((await game(ctx.app, 'nope')('POST', '/heartbeat', { players: [] })).statusCode).toBe(401);
    const fake = 'mgk_AAAAAAAAAA_' + 'x'.repeat(43);
    expect((await game(ctx.app, fake)('POST', '/heartbeat', { players: [] })).statusCode).toBe(401);
  });

  it('a session cookie is not accepted on game endpoints', async () => {
    const res = await admin.req('POST', '/api/v1/game/heartbeat', { players: [] });
    expect(res.statusCode).toBe(401);
  });

  it('created keys work; revoked keys stop working immediately', async () => {
    const created = await admin.req('POST', `/api/v1/servers/${sid}/api-keys`, { name: 'temp key' });
    const secret = created.json().secret as string;
    const row = (await ctx.db.query('SELECT key_hash FROM api_keys WHERE id = $1', [created.json().key.id])).rows[0];
    expect(row.key_hash).not.toBe(secret);
    expect((await game(ctx.app, secret)('POST', '/heartbeat', { players: [] })).statusCode).toBe(200);
    await admin.req('POST', `/api/v1/servers/${sid}/api-keys/${created.json().key.id}/revoke`, {});
    expect((await game(ctx.app, secret)('POST', '/heartbeat', { players: [] })).statusCode).toBe(401);
  });

  it('rotation issues a new key and keeps the old one only during the grace period', async () => {
    const created = await admin.req('POST', `/api/v1/servers/${sid}/api-keys`, { name: 'rot' });
    const rotated = await admin.req('POST', `/api/v1/servers/${sid}/api-keys/${created.json().key.id}/rotate`, { graceMinutes: 0 });
    expect(rotated.statusCode).toBe(200);
    expect((await game(ctx.app, created.json().secret)('POST', '/heartbeat', { players: [] })).statusCode).toBe(401);
    expect((await game(ctx.app, rotated.json().secret)('POST', '/heartbeat', { players: [] })).statusCode).toBe(200);
  });
});

describe('handshake and config', () => {
  it('rejects malformed schemas', async () => {
    const res = await g('POST', '/handshake', { resourceVersion: '1.0.0', schema: { version: 'x' } });
    expect(res.statusCode).toBe(422);
  });

  it('stores the schema and validates config overrides against it', async () => {
    const hs = await g('POST', '/handshake', { resourceVersion: '1.0.0', framework: 'esx', schema: SCHEMA, effective: {} });
    expect(hs.statusCode).toBe(200);
    expect(hs.json().config.version).toBe(0);

    const bad = await admin.req('PUT', `/api/v1/servers/${sid}/config`, { overrides: { modules: { 'movement.teleport': { params: { maxDistance: 1 } } } }, expectedVersion: 0, note: 'teszt' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.details[0].path).toBe('modules.movement.teleport.params.maxDistance');

    const clientBan = await admin.req('PUT', `/api/v1/servers/${sid}/config`, { overrides: { modules: { 'client.heartbeat': { action: 'ban' } } }, expectedVersion: 0, note: 'teszt' });
    expect(clientBan.statusCode).toBe(422);

    const ok = await admin.req('PUT', `/api/v1/servers/${sid}/config`, { overrides: { modules: { 'movement.teleport': { params: { maxDistance: 300 } } } }, expectedVersion: 0, note: 'nagyobb tolerancia' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe(1);

    const stale = await admin.req('PUT', `/api/v1/servers/${sid}/config`, { overrides: {}, expectedVersion: 0, note: 'régi verzió' });
    expect(stale.statusCode).toBe(409);

    const pulled = await g('GET', '/config');
    expect(pulled.json().version).toBe(1);
    expect(pulled.json().overrides.modules['movement.teleport'].params.maxDistance).toBe(300);

    const rollback = await admin.req('POST', `/api/v1/servers/${sid}/config/rollback`, { version: 1, expectedVersion: 1 });
    expect(rollback.json().version).toBe(2);
  });
});

describe('players and bans', () => {
  it('connect without ban returns null; web ban blocks the next connect and reaches sync', async () => {
    const first = await g('POST', '/players/connect', { name: 'Joe', identifiers: [LICENSE_A, DISCORD_A, 'ip:1.2.3.4'] });
    expect(first.json().ban).toBeNull();
    const playerId = first.json().playerId;

    const ban = await admin.req('POST', `/api/v1/servers/${sid}/bans`, { playerId, reason: 'Aimbot bizonyíték', durationSeconds: null });
    expect(ban.statusCode).toBe(200);
    // all known identifiers are banned, but never the IP
    expect(ban.json().ban.identifiers).toEqual(expect.arrayContaining([LICENSE_A, DISCORD_A]));
    expect(ban.json().ban.identifiers.some((i: string) => i.startsWith('ip:'))).toBe(false);

    const again = await g('POST', '/players/connect', { name: 'Joe', identifiers: [DISCORD_A] });
    expect(again.json().ban.code).toMatch(/^MG-/);

    const sync = await g('GET', '/bans/sync');
    expect(sync.json().bans).toHaveLength(1);

    // the game server is told to enforce it immediately
    const cmds = (await g('GET', '/commands')).json().commands;
    expect(cmds.some((c: { type: string }) => c.type === 'ban_sync')).toBe(true);
  });

  it('ban evasion: new identifiers seen with a banned one are added to the ban', async () => {
    const res = await g('POST', '/players/connect', { name: 'Joe2', identifiers: [LICENSE_A, LICENSE_B] });
    expect(res.json().ban).not.toBeNull();
    const fresh = await g('POST', '/players/connect', { name: 'Alt', identifiers: [LICENSE_B] });
    expect(fresh.json().ban).not.toBeNull();
  });

  it('unban removes the ban from sync deltas and allows connecting again', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const list = (await admin.req('GET', `/api/v1/servers/${sid}/bans`)).json().items;
    const revoke = await admin.req('POST', `/api/v1/servers/${sid}/bans/${list[0].id}/revoke`, { reason: 'Téves ban' });
    expect(revoke.statusCode).toBe(200);
    expect((await admin.req('POST', `/api/v1/servers/${sid}/bans/${list[0].id}/revoke`, { reason: 'Megint' })).statusCode).toBe(409);
    const delta = (await g('GET', `/bans/sync?since=${encodeURIComponent(since)}`)).json();
    expect(delta.inactive).toContain(list[0].id);
    expect((await g('POST', '/players/connect', { name: 'Joe', identifiers: [LICENSE_A] })).json().ban).toBeNull();
    const audit = await ctx.db.query("SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY id", [list[0].id]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['ban.create', 'ban.revoke']));
  });

  it('temporary bans expire and are reported inactive', async () => {
    const res = await g('POST', '/bans', { localId: 'local-ban-0001', identifiers: [LICENSE_B], playerName: 'Alt', reason: 'Speedhack', durationSeconds: 3600 });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(true);
    // idempotent resend (e.g. after a timeout)
    const again = await g('POST', '/bans', { localId: 'local-ban-0001', identifiers: [LICENSE_B], playerName: 'Alt', reason: 'Speedhack', durationSeconds: 3600 });
    expect(again.json().created).toBe(false);
    expect(again.json().ban.id).toBe(res.json().ban.id);
    await ctx.db.query("UPDATE bans SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1", [res.json().ban.id]);
    const since = new Date(Date.now() - 1000).toISOString();
    const m = await runMaintenance(ctx.app);
    expect(m.expiredBans).toBeGreaterThanOrEqual(1);
    expect((await g('GET', `/bans/sync?since=${encodeURIComponent(since)}`)).json().inactive).toContain(res.json().ban.id);
    expect((await g('POST', '/players/connect', { name: 'Alt', identifiers: [LICENSE_B] })).json().ban).toBeNull();
  });

  it('offline-created bans keep their original start time', async () => {
    const res = await g('POST', '/bans', { localId: 'local-ban-0002', identifiers: [LICENSE_B], reason: 'Offline ban', durationSeconds: 3600, ageSeconds: 7200 });
    expect(res.json().expiredBeforeSync).toBe(true);
  });

  it('in-game admins linked to a web account are checked against their backend role', async () => {
    const mod = await createUser(ctx.db, 'gamemod');
    await addMember(ctx.db, sid, mod, 'moderator');
    await ctx.db.query("INSERT INTO user_identifiers (user_id, type, value) VALUES ($1, 'license', $2)", [mod, 'c'.repeat(40)]);
    const actor = { name: 'GameMod', identifiers: ['license:' + 'c'.repeat(40)], source: 'ace' };
    const perm = await g('POST', '/bans', { localId: 'local-ban-0003', identifiers: [LICENSE_B], reason: 'Perm', durationSeconds: null, actor });
    expect(perm.statusCode).toBe(403);
    const temp = await g('POST', '/bans', { localId: 'local-ban-0004', identifiers: [LICENSE_B], reason: 'Temp', durationSeconds: 600, actor });
    expect(temp.statusCode).toBe(200);
    const row = (await ctx.db.query('SELECT created_by, source, created_by_label FROM bans WHERE local_id = $1', ['local-ban-0004'])).rows[0];
    expect(row.created_by).toBe(mod);
    expect(row.source).toBe('ingame');
    expect(row.created_by_label).toMatch(/^ingame:GameMod/);
    const connect = await g('POST', '/players/connect', { name: 'GameMod', identifiers: actor.identifiers });
    expect(connect.json().admin.role).toBe('moderator');
  });
});

describe('detections', () => {
  it('ingests idempotently and validates input', async () => {
    const d = detection('det-local-0001');
    const r1 = await g('POST', '/detections', { detections: [d] });
    const r2 = await g('POST', '/detections', { detections: [d] });
    expect(r1.json().created).toBe(1);
    expect(r2.json().created).toBe(0);
    expect(r1.json().ids['det-local-0001']).toBe(r2.json().ids['det-local-0001']);

    const bad = await g('POST', '/detections', { detections: [{ ...d, localId: 'x', severity: 'NUCLEAR' }] });
    expect(bad.statusCode).toBe(400);
    const tooBig = await g('POST', '/detections', { detections: [{ ...detection('det-local-big1'), evidence: { blob: 'x'.repeat(20000) } }] });
    expect(tooBig.statusCode).toBe(400);
    const tooMany = await g('POST', '/detections', { detections: Array.from({ length: 101 }, (_, i) => detection(`det-many-${String(i).padStart(4, '0')}`)) });
    expect(tooMany.statusCode).toBe(400);
  });

  it('clamps timestamps from the future', async () => {
    const future = new Date(Date.now() + 86400_000 * 30).toISOString();
    await g('POST', '/detections', { detections: [detection('det-future-01', { occurredAt: future })] });
    const row = (await ctx.db.query("SELECT occurred_at FROM detections WHERE local_id = 'det-future-01'")).rows[0];
    expect(row.occurred_at.getTime()).toBeLessThan(Date.now() + 120_000);
  });

  it('supports review / false positive marking with mandatory reason', async () => {
    const list = (await admin.req('GET', `/api/v1/servers/${sid}/detections?review=pending`)).json();
    const id = list.items[0].id;
    expect((await admin.req('POST', `/api/v1/servers/${sid}/detections/${id}/review`, { status: 'false_positive', note: '' })).statusCode).toBe(400);
    const ok = await admin.req('POST', `/api/v1/servers/${sid}/detections/${id}/review`, { status: 'false_positive', note: 'Admin teleport volt' });
    expect(ok.json().detection.review_status).toBe('false_positive');
    expect(ok.json().detection.reviewed_by_label).toBe('boss');
  });

  it('filters and paginates', async () => {
    await g('POST', '/detections', { detections: Array.from({ length: 30 }, (_, i) => detection(`det-page-${String(i).padStart(4, '0')}`, { severity: i % 2 ? 'LOW' : 'CRITICAL' })) });
    const p1 = (await admin.req('GET', `/api/v1/servers/${sid}/detections?pageSize=10&page=2`)).json();
    expect(p1.items).toHaveLength(10);
    expect(p1.page).toBe(2);
    const crit = (await admin.req('GET', `/api/v1/servers/${sid}/detections?severity=CRITICAL&pageSize=100`)).json();
    expect(crit.items.every((d: { severity: string }) => d.severity === 'CRITICAL')).toBe(true);
    const bad = await admin.req('GET', `/api/v1/servers/${sid}/detections?pageSize=1000`);
    expect(bad.statusCode).toBe(400);
  });

  it('sends Discord alerts only when configured and above threshold', async () => {
    ctx.sentWebhooks.length = 0;
    const put = await admin.req('PUT', `/api/v1/servers/${sid}/integrations/discord`, { enabled: true, minSeverity: 'HIGH', webhookUrl: 'https://discord.com/api/webhooks/123/abcDEFghij' });
    expect(put.statusCode).toBe(200);
    const notWebhook = await admin.req('PUT', `/api/v1/servers/${sid}/integrations/discord`, { enabled: true, minSeverity: 'HIGH', webhookUrl: 'https://evil.example/hook' });
    expect(notWebhook.statusCode).toBe(400);
    const info = (await admin.req('GET', `/api/v1/servers/${sid}/integrations`)).json();
    expect(JSON.stringify(info)).not.toContain('abcDEF');
    await g('POST', '/detections', { detections: [detection('det-alert-01', { severity: 'MEDIUM' }), detection('det-alert-02', { severity: 'CRITICAL' })] });
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.sentWebhooks).toHaveLength(1);
    expect(JSON.stringify(ctx.sentWebhooks[0]!.body)).toContain('CRITICAL');
  });
});

describe('heartbeat, sessions and commands', () => {
  it('reconciles online sessions from heartbeats', async () => {
    await g('POST', '/players/joined', { netId: 5, name: 'P5', identifiers: [LICENSE_A] });
    await g('POST', '/players/joined', { netId: 6, name: 'P6', identifiers: [LICENSE_B] });
    await g('POST', '/heartbeat', { players: [{ netId: 5, name: 'P5', identifiers: [LICENSE_A], ping: 40, risk: 12 }] });
    const online = (await admin.req('GET', `/api/v1/servers/${sid}/players/online`)).json();
    expect(online.serverOnline).toBe(true);
    expect(online.items.map((p: { net_id: number }) => p.net_id)).toEqual([5]);
    expect(online.items[0].risk_score).toBe(12);
  });

  it('queues a kick from the web, delivers it to the game server and records the ack', async () => {
    const online = (await admin.req('GET', `/api/v1/servers/${sid}/players/online`)).json();
    const kick = await admin.req('POST', `/api/v1/servers/${sid}/players/${online.items[0].player_id}/kick`, { reason: 'AFK farm' });
    expect(kick.statusCode).toBe(200);
    const cmds = (await g('GET', '/commands')).json().commands;
    const k = cmds.find((c: { type: string }) => c.type === 'kick');
    expect(k.payload).toMatchObject({ netId: 5, reason: 'AFK farm' });
    expect((await g('POST', `/commands/${k.id}/ack`, { status: 'done', result: 'dropped' })).json().ok).toBe(true);
    expect((await g('GET', '/commands')).json().commands.find((c: { id: string }) => c.id === k.id)).toBeUndefined();
  });

  it('kicking an offline player is refused', async () => {
    await g('POST', '/players/dropped', { netId: 5, reason: 'quit' });
    const p5 = (await ctx.db.query('SELECT player_id AS id FROM player_sessions WHERE net_id = 5 ORDER BY connected_at DESC LIMIT 1')).rows[0];
    expect((await admin.req('POST', `/api/v1/servers/${sid}/players/${p5.id}/kick`, { reason: 'x x x' })).statusCode).toBe(409);
  });

  it('marks the server offline once heartbeats stop', async () => {
    await ctx.db.query("UPDATE servers SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [sid]);
    const online = (await admin.req('GET', `/api/v1/servers/${sid}/players/online`)).json();
    expect(online.serverOnline).toBe(false);
    await runMaintenance(ctx.app);
    const ev = await ctx.db.query("SELECT 1 FROM system_events WHERE server_id = $1 AND type = 'heartbeat_lost'", [sid]);
    expect(ev.rowCount).toBeGreaterThanOrEqual(1);
  });
});

describe('retention', () => {
  it('deletes old detections but keeps those linked to bans', async () => {
    const det = (await g('POST', '/detections', { detections: [detection('det-old-0001'), detection('det-old-0002')] })).json().ids;
    await g('POST', '/bans', { localId: 'local-ban-ret1', identifiers: [LICENSE_A], reason: 'Bizonyíték', durationSeconds: 3600, detectionLocalIds: ['det-old-0001'] });
    await ctx.db.query("UPDATE detections SET occurred_at = now() - interval '400 days' WHERE id = ANY($1::uuid[])", [[det['det-old-0001'], det['det-old-0002']]]);
    await runMaintenance(ctx.app);
    const left = (await ctx.db.query('SELECT local_id FROM detections WHERE id = ANY($1::uuid[])', [[det['det-old-0001'], det['det-old-0002']]])).rows;
    expect(left.map((r) => r.local_id)).toEqual(['det-old-0001']);
  });
});
