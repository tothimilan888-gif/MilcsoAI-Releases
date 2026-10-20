import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import { Encryptor } from './lib/crypto.js';
import { AppError } from './lib/errors.js';
import { Realtime } from './lib/realtime.js';
import type { Actor } from './lib/audit.js';
import authPlugin from './plugins/auth.js';
import gamePlugin from './plugins/game.js';
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/servers.js';
import memberRoutes from './routes/members.js';
import detectionRoutes from './routes/detections.js';
import playerRoutes from './routes/players.js';
import banRoutes from './routes/bans.js';
import whitelistRoutes from './routes/whitelist.js';
import auditRoutes from './routes/audit.js';
import analyticsRoutes from './routes/analytics.js';
import systemRoutes from './routes/system.js';
import configRoutes from './routes/config.js';
import apiKeyRoutes from './routes/apikeys.js';
import integrationRoutes from './routes/integrations.js';
import streamRoutes from './routes/stream.js';
import gameRoutes from './routes/game.js';
import healthRoutes from './routes/health.js';

export interface BuildOptions {
  config: AppConfig;
  db: Db;
  fetchImpl?: typeof fetch;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
          },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 512 * 1024,
    disableRequestLogging: config.NODE_ENV === 'test',
  });

  app.decorate('db', opts.db);
  app.decorate('cfg', config);
  app.decorate('enc', new Encryptor(config.APP_ENCRYPTION_KEY));
  app.decorate('realtime', new Realtime(opts.db, (m) => app.log.warn(m)));
  app.decorate('fetchImpl', opts.fetchImpl ?? fetch);

  app.decorateRequest('actor', function (this: FastifyRequest): Actor {
    if (this.user) return { type: 'user', userId: this.user.userId, label: this.user.username, ip: this.ip };
    if (this.game) return { type: 'api_key', label: `server-key:${this.game.keyName}`, ip: this.ip };
    return { type: 'system', label: 'anonymous', ip: this.ip };
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cors, {
    // Same-origin deployments need no CORS at all; cross-origin is limited to the explicit allow list.
    origin: (origin, cb) => {
      if (!origin) return cb(null, false);
      cb(null, config.corsOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    // Game servers are rate limited per API key prefix rather than per IP.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      if (typeof auth === 'string' && auth.startsWith('Bearer mgk_')) return `key:${auth.slice(11, 21)}`;
      return `ip:${req.ip}`;
    },
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: { code: 'rate_limited', message: `Too many requests, retry in ${Math.ceil(ctx.ttl / 1000)}s` },
    }),
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown; code?: string }, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: err.message } });
    }
    if (err.validation) {
      return reply.status(400).send({ error: { code: 'bad_request', message: err.message } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  await app.register(authPlugin);
  await app.register(gamePlugin);

  await app.register(healthRoutes);
  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(serverRoutes);
      await api.register(memberRoutes);
      await api.register(detectionRoutes);
      await api.register(playerRoutes);
      await api.register(banRoutes);
      await api.register(whitelistRoutes);
      await api.register(auditRoutes);
      await api.register(analyticsRoutes);
      await api.register(systemRoutes);
      await api.register(configRoutes);
      await api.register(apiKeyRoutes);
      await api.register(integrationRoutes);
      await api.register(streamRoutes);
      await api.register(gameRoutes, { prefix: '/game' });
    },
    { prefix: '/api/v1' },
  );

  if (config.WEB_DIST_DIR && existsSync(config.WEB_DIST_DIR)) {
    const root = path.resolve(config.WEB_DIST_DIR);
    await app.register(fastifyStatic, { root, wildcard: false });
    // SPA fallback for client-side routes (never for /api).
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } }));
  }

  app.addHook('onReady', async () => {
    await app.realtime.start();
  });
  app.addHook('onClose', async () => {
    await app.realtime.stop();
  });

  return app;
}
