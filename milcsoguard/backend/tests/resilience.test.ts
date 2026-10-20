import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { addMember, Client, createApiKey, createServer, createUser, game, setupApp, teardown, type TestCtx } from './helpers.js';
import { detection } from './fixtures.js';

describe('database outage', () => {
  it('reports degraded health and returns generic 500s instead of crashing or leaking details', async () => {
    const config = loadConfig({ ...process.env, DATABASE_URL: 'postgres://mg:wrong@127.0.0.1:1/none' });
    const db = createPool(config.DATABASE_URL, 1);
    const app = await buildApp({ config, db, logger: false });
    await app.ready();
    try {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
      expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(503);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'a', password: 'b' } });
      expect(login.statusCode).toBe(500);
      expect(login.json().error.message).toBe('Internal server error');
      const g = await app.inject({ method: 'POST', url: '/api/v1/game/heartbeat', headers: { authorization: 'Bearer mgk_AAAAAAAAAA_' + 'x'.repeat(43) }, payload: {} });
      expect(g.statusCode).toBe(500);
    } finally {
      await app.close();
      await db.end();
    }
  });
});

describe('rate limiting and malformed requests', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await setupApp({ LOGIN_RATE_LIMIT: '5' });
  });
  afterAll(() => teardown(ctx));

  it('limits login attempts per IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await new Client(ctx.app).login('x', 'y')).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[6]).toBe(429);
  });

  it('rejects malformed JSON, wrong content types and oversized bodies', async () => {
    const sid = await createServer(ctx.db, 'rl');
    const key = await createApiKey(ctx.db, sid);
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/game/heartbeat', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, payload: '{"players":' });
    expect(bad.statusCode).toBe(400);
    const wrongShape = await ctx.app.inject({ method: 'POST', url: '/api/v1/game/heartbeat', headers: { authorization: `Bearer ${key}` }, payload: { players: 'all' } });
    expect(wrongShape.statusCode).toBe(400);
    expect(wrongShape.json().error.details[0].path).toBe('players');
    const huge = await ctx.app.inject({
      method: 'POST', url: '/api/v1/game/detections', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ detections: [{ evidence: { x: 'y'.repeat(600 * 1024) } }] }),
    });
    expect(huge.statusCode).toBe(413);
    const unknownRoute = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(unknownRoute.statusCode).toBe(404);
    const badUuid = await ctx.app.inject({ method: 'GET', url: '/api/v1/servers/not-a-uuid/detections' });
    expect(badUuid.statusCode).toBe(401);
  });
});

describe('realtime stream', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await setupApp();
  });
  afterAll(() => teardown(ctx));

  it('pushes new detections to subscribed dashboards of the same server only', async () => {
    const sid = await createServer(ctx.db, 'rt');
    const other = await createServer(ctx.db, 'rt-other');
    const u = await createUser(ctx.db, 'watcher');
    await addMember(ctx.db, sid, u, 'viewer');
    const c = new Client(ctx.app);
    await c.login('watcher');
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const ac = new AbortController();
    const res = await fetch(`${address}/api/v1/servers/${sid}/stream`, { headers: { cookie: c.cookie }, signal: ac.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const chunks: string[] = [];
    const reading = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(dec.decode(value));
        if (chunks.join('').includes('detection.created')) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 200));
    await game(ctx.app, await createApiKey(ctx.db, other))('POST', '/detections', { detections: [detection('rt-other-0001', { playerName: 'OtherServer' })] });
    await game(ctx.app, await createApiKey(ctx.db, sid))('POST', '/detections', { detections: [detection('rt-mine-00001', { playerName: 'MyServer' })] });
    await Promise.race([reading, new Promise((r) => setTimeout(r, 3000))]);
    ac.abort();
    const text = chunks.join('');
    expect(text).toContain('event: detection.created');
    expect(text).toContain('MyServer');
    expect(text).not.toContain('OtherServer');
  });
});
