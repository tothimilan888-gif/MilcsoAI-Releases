import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrateUp } from '../src/db/migrate.js';
import { generateApiKey, hashPassword } from '../src/lib/crypto.js';

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
  sentWebhooks: { url: string; body: unknown }[];
}

/** Fresh schema per test file: drop everything and migrate from scratch. */
export async function setupApp(envOverrides: Record<string, string> = {}): Promise<TestCtx> {
  const config = loadConfig({ ...process.env, ...envOverrides });
  const db = createPool(config.DATABASE_URL, 5);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrateUp(db, () => undefined);
  const sentWebhooks: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    sentWebhooks.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const app = await buildApp({ config, db, fetchImpl, logger: false });
  await app.ready();
  return { app, db, sentWebhooks };
}

export async function teardown(ctx: TestCtx) {
  await ctx.app.close();
  await ctx.db.end();
}

export const PASSWORD = 'CorrectHorse9Battery';

export async function createUser(db: Db, username: string, opts: { platformAdmin?: boolean; password?: string } = {}) {
  const r = await db.query<{ id: string }>(
    'INSERT INTO users (email, username, password_hash, is_platform_admin) VALUES ($1, $2, $3, $4) RETURNING id',
    [`${username}@test.local`, username, await hashPassword(opts.password ?? PASSWORD), opts.platformAdmin ?? false],
  );
  return r.rows[0]!.id;
}

export async function createServer(db: Db, slug: string) {
  const r = await db.query<{ id: string }>('INSERT INTO servers (name, slug) VALUES ($1, $2) RETURNING id', [slug, slug]);
  const id = r.rows[0]!.id;
  await db.query('INSERT INTO server_configs (server_id) VALUES ($1)', [id]);
  await db.query('INSERT INTO server_integrations (server_id) VALUES ($1)', [id]);
  return id;
}

export async function addMember(db: Db, serverId: string, userId: string, roleKey: string) {
  await db.query("INSERT INTO server_members (server_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3 AND server_id IS NULL", [serverId, userId, roleKey]);
}

export async function createApiKey(db: Db, serverId: string) {
  const k = generateApiKey();
  await db.query('INSERT INTO api_keys (server_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4)', [serverId, 'test', k.prefix, k.hash]);
  return k.full;
}

export class Client {
  cookie = '';
  csrf = '';
  constructor(private app: FastifyInstance) {}

  async login(login: string, password = PASSWORD) {
    const res = await this.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password } });
    const set = res.headers['set-cookie'];
    const cookie = (Array.isArray(set) ? set[0] : set) ?? '';
    this.cookie = cookie.split(';')[0] ?? '';
    this.csrf = res.json().csrfToken ?? '';
    return res;
  }

  req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, opts: { csrf?: boolean } = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (opts.csrf !== false && this.csrf) headers['x-csrf-token'] = this.csrf;
    return this.app.inject({ method, url, payload: payload as never, headers });
  }
}

export function game(app: FastifyInstance, key: string) {
  return (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/v1/game${url}`, payload: payload as never, headers: { authorization: `Bearer ${key}` } });
}

export const LICENSE_A = 'license:' + 'a'.repeat(40);
export const LICENSE_B = 'license:' + 'b'.repeat(40);
export const DISCORD_A = 'discord:123456789012345678';
