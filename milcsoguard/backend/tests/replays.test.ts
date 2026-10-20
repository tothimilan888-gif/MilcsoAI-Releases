import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureStorage, pruneReplays } from '../src/services/replays.js';
import { addMember, Client, createApiKey, createServer, createUser, game, LICENSE_A, LICENSE_B, setupApp, teardown, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let sid: string;
let otherSid: string;
let g: ReturnType<typeof game>;
let gOther: ReturnType<typeof game>;
let owner: Client;
let viewer: Client;
let moderator: Client;

/** Minimal stand-in for a WebM segment: EBML magic followed by random bytes. */
function webm(size: number) {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), crypto.randomBytes(size - 4)]);
}
const actor = { name: 'Admin', identifiers: [LICENSE_B], source: 'ace' };

beforeAll(async () => {
  ctx = await setupApp();
  sid = await createServer(ctx.db, 'replay-srv');
  otherSid = await createServer(ctx.db, 'other-srv');
  g = game(ctx.app, await createApiKey(ctx.db, sid));
  gOther = game(ctx.app, await createApiKey(ctx.db, otherSid));
  for (const [name, role] of [['rowner', 'owner'], ['rviewer', 'viewer'], ['rmod', 'moderator']] as const) {
    await addMember(ctx.db, sid, await createUser(ctx.db, name), role);
  }
  owner = new Client(ctx.app);
  await owner.login('rowner');
  viewer = new Client(ctx.app);
  await viewer.login('rviewer');
  moderator = new Client(ctx.app);
  await moderator.login('rmod');
  await g('POST', '/players/connect', { name: 'Cheater', identifiers: [LICENSE_A] });
});
afterAll(() => teardown(ctx));

describe('ban replay upload', () => {
  const id = crypto.randomUUID();
  const parts = [webm(3000), webm(5000), webm(2000)];

  it('accepts a replay announced before its ban reached the backend', async () => {
    const res = await g('POST', '/replays', { id, kind: 'ban', playerName: 'Cheater', identifiers: [LICENSE_A], reason: 'auto', banLocalId: 'gban-abcdef123456', width: 854, height: 480, fps: 15 });
    expect(res.statusCode).toBe(200);
    for (const [i, p] of parts.entries()) {
      const up = await g('PUT', `/replays/${id}/parts/${i}`, { durationMs: 5000, data: p.toString('base64') });
      expect(up.statusCode).toBe(200);
    }
    const done = await g('POST', `/replays/${id}/complete`, { status: 'ready' });
    expect(done.json().status).toBe('ready');
    const row = (await ctx.db.query('SELECT status, part_count, size_bytes, duration_ms, ban_id, player_id FROM replays WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'ready', part_count: 3, size_bytes: 10000, duration_ms: 15000, ban_id: null });
    expect(row.player_id).not.toBeNull();
  });

  it('links the replay when the queued ban arrives and shows it on the ban', async () => {
    const ban = await g('POST', '/bans', { localId: 'gban-abcdef123456', identifiers: [LICENSE_A], playerName: 'Cheater', reason: 'Automatikus: test', durationSeconds: null });
    expect(ban.statusCode).toBe(200);
    const banId = ban.json().ban.id;
    const detail = await owner.req('GET', `/api/v1/servers/${sid}/bans/${banId}`);
    expect(detail.json().replays.map((r: { id: string }) => r.id)).toEqual([id]);
    expect(detail.json().replays[0].ban_code).toBe(ban.json().ban.code);
  });

  it('serves the exact bytes of each part to permitted users and audits the viewing', async () => {
    const meta = await owner.req('GET', `/api/v1/servers/${sid}/replays/${id}`);
    expect(meta.statusCode).toBe(200);
    expect(meta.json().parts.map((p: { idx: number }) => p.idx)).toEqual([0, 1, 2]);
    const part = await owner.req('GET', `/api/v1/servers/${sid}/replays/${id}/parts/1`);
    expect(part.statusCode).toBe(200);
    expect(part.headers['content-type']).toBe('video/webm');
    expect(Buffer.compare(part.rawPayload, parts[1]!)).toBe(0);
    const audits = (await ctx.db.query("SELECT actor_label FROM audit_logs WHERE action = 'replay.view' AND target_id = $1", [id])).rows;
    expect(audits.map((a) => a.actor_label)).toContain('rowner');
  });

  it('enforces permissions and tenant isolation', async () => {
    expect((await viewer.req('GET', `/api/v1/servers/${sid}/replays`)).statusCode).toBe(403);
    expect((await viewer.req('GET', `/api/v1/servers/${sid}/replays/${id}/parts/0`)).statusCode).toBe(403);
    expect((await moderator.req('GET', `/api/v1/servers/${sid}/replays`)).json().total).toBe(1);
    expect((await moderator.req('DELETE', `/api/v1/servers/${sid}/replays/${id}`)).statusCode).toBe(403);
    // another server's key can neither read nor write this replay
    expect((await gOther('GET', `/admin/replays/${id}`)).statusCode).toBe(404);
    expect((await gOther('PUT', `/replays/${id}/parts/3`, { durationMs: 1, data: webm(100).toString('base64') })).statusCode).toBe(404);
    expect((await gOther('POST', '/replays', { id, kind: 'ban', identifiers: [] })).statusCode).toBe(404);
  });

  it('rejects uploads to a finished replay and non-WebM data', async () => {
    expect((await g('PUT', `/replays/${id}/parts/3`, { durationMs: 1, data: webm(100).toString('base64') })).statusCode).toBe(409);
    const other = crypto.randomUUID();
    await g('POST', '/replays', { id: other, kind: 'ban', identifiers: [LICENSE_A] });
    const bad = await g('PUT', `/replays/${other}/parts/0`, { durationMs: 1, data: Buffer.from('<html>not a video</html>').toString('base64') });
    expect(bad.statusCode).toBe(422);
    expect((await g('PUT', `/replays/${other}/parts/0`, { durationMs: 1, data: 'not base64 !!' })).statusCode).toBe(400);
    const failed = await g('POST', `/replays/${other}/complete`, { status: 'ready' });
    expect(failed.json().status).toBe('failed'); // no parts -> failed, not an empty "ready" replay
  });

  it('relays parts to the in-game panel as base64', async () => {
    const list = await g('GET', '/admin/replays');
    expect(list.json().items.some((r: { id: string }) => r.id === id)).toBe(true);
    const part = await g('GET', `/admin/replays/${id}/parts/0`);
    expect(Buffer.from(part.json().data, 'base64').equals(parts[0]!)).toBe(true);
    const viewed = await g('POST', `/admin/replays/${id}/viewed`, { actor });
    expect(viewed.statusCode).toBe(200);
  });
});

describe('replay requested from the web dashboard', () => {
  it('needs the player online, then queues a command the game turns into an upload', async () => {
    const playerId = (await ctx.db.query('SELECT player_id FROM player_identifiers WHERE type = $1 AND value = $2', ['license', 'a'.repeat(40)])).rows[0].player_id;
    const offline = await moderator.req('POST', `/api/v1/servers/${sid}/players/${playerId}/replay`, { reason: 'report check' });
    expect(offline.statusCode).toBe(409);
    await g('POST', '/players/joined', { netId: 7, name: 'Cheater', identifiers: [LICENSE_A] });
    expect((await viewer.req('POST', `/api/v1/servers/${sid}/players/${playerId}/replay`, { reason: 'report check' })).statusCode).toBe(403);
    const res = await moderator.req('POST', `/api/v1/servers/${sid}/players/${playerId}/replay`, { reason: 'report check' });
    expect(res.statusCode).toBe(200);
    const replayId = res.json().replay.id;
    const cmds = (await g('GET', '/commands')).json().commands;
    const cmd = cmds.find((c: { type: string }) => c.type === 'replay_request');
    expect(cmd.payload).toMatchObject({ replayId, netId: 7, reason: 'report check', by: 'rmod' });
    expect(cmd.payload.identifiers).toContain(LICENSE_A);

    expect((await g('POST', '/replays', { id: replayId, kind: 'manual', playerName: 'Cheater', identifiers: [LICENSE_A] })).statusCode).toBe(200);
    expect((await g('PUT', `/replays/${replayId}/parts/0`, { durationMs: 4000, data: webm(1000).toString('base64') })).statusCode).toBe(200);
    const done = await g('POST', `/replays/${replayId}/complete`, { status: 'failed', error: 'player left' });
    expect(done.json().status).toBe('failed');
    const row = (await ctx.db.query('SELECT status, error, requested_by_label, (SELECT count(*)::int FROM replay_parts WHERE replay_id = $1) AS parts FROM replays WHERE id = $1', [replayId])).rows[0];
    expect(row).toMatchObject({ status: 'failed', error: 'player left', requested_by_label: 'rmod', parts: 0 });
  });

  it('an in-game manual request is audited with the in-game admin', async () => {
    const id = crypto.randomUUID();
    expect((await g('POST', '/replays', { id, kind: 'manual', playerName: 'Cheater', identifiers: [LICENSE_A], reason: 'suspicious', requestedBy: actor })).statusCode).toBe(200);
    const a = (await ctx.db.query("SELECT actor_label FROM audit_logs WHERE action = 'replay.request' AND target_id = $1", [id])).rows[0];
    expect(a.actor_label).toContain('ingame:Admin');
  });
});

describe('storage and retention', () => {
  async function readyReplay(serverId: string, size: number, ageDays = 0, banId: string | null = null) {
    const id = crypto.randomUUID();
    await ctx.db.query(
      "INSERT INTO replays (id, server_id, kind, status, ban_id, created_at, size_bytes) VALUES ($1, $2, 'manual', 'ready', $3, now() - make_interval(days => $4), $5)",
      [id, serverId, banId, ageDays, size],
    );
    await ctx.db.query('INSERT INTO replay_parts (replay_id, idx, size_bytes, data) VALUES ($1, 0, $2, $3)', [id, size, webm(size)]);
    return id;
  }

  it('evicts the oldest replays but never evidence for an active ban', async () => {
    const s = await createServer(ctx.db, 'storage-srv');
    const ban = (await ctx.db.query("INSERT INTO bans (server_id, public_code, reason, source, created_by_label) VALUES ($1, 'MG-STORE01', 'evidence', 'web', 'x') RETURNING id", [s])).rows[0].id;
    const evidence = await readyReplay(s, 400, 3, ban);
    const old = await readyReplay(s, 400, 2);
    const recent = await readyReplay(s, 400, 1);
    expect(await ensureStorage(ctx.db, s, 300, 1200, crypto.randomUUID())).toBe(1);
    const left = (await ctx.db.query('SELECT id FROM replays WHERE server_id = $1', [s])).rows.map((r) => r.id);
    expect(left.sort()).toEqual([evidence, recent].sort());
    expect(left).not.toContain(old);
    await expect(ensureStorage(ctx.db, s, 5000, 1200, crypto.randomUUID())).rejects.toMatchObject({ statusCode: 507 });
    expect((await ctx.db.query('SELECT id FROM replays WHERE server_id = $1', [s])).rows.map((r) => r.id)).toEqual([evidence]);
  });

  it('retention deletes old replays, keeps active-ban evidence and fails stuck uploads', async () => {
    const s = await createServer(ctx.db, 'retention-srv');
    const ban = (await ctx.db.query("INSERT INTO bans (server_id, public_code, reason, source, created_by_label) VALUES ($1, 'MG-KEEP0001', 'evidence', 'web', 'x') RETURNING id", [s])).rows[0].id;
    const keep = await readyReplay(s, 10, 60, ban);
    const expired = await readyReplay(s, 10, 60);
    const fresh = await readyReplay(s, 10, 1);
    const stuck = crypto.randomUUID();
    await ctx.db.query("INSERT INTO replays (id, server_id, kind, status, created_at) VALUES ($1, $2, 'manual', 'uploading', now() - interval '2 hours')", [stuck, s]);
    const r = await pruneReplays(ctx.db);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    const rows = (await ctx.db.query('SELECT id, status FROM replays WHERE server_id = $1', [s])).rows;
    const ids = rows.map((x) => x.id);
    expect(ids).toContain(keep);
    expect(ids).toContain(fresh);
    expect(ids).not.toContain(expired);
    expect(rows.find((x) => x.id === stuck)?.status).toBe('failed');
  });

  it('the dashboard CSP allows playing blob: video', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(String(res.headers['content-security-policy'])).toContain("media-src 'self' blob:");
  });
});
