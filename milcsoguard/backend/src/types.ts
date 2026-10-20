import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import type { Encryptor } from './lib/crypto.js';
import type { MemberAccess, Permission } from './lib/permissions.js';
import type { Realtime } from './lib/realtime.js';
import type { Actor } from './lib/audit.js';

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  username: string;
  isPlatformAdmin: boolean;
  totpEnabled: boolean;
  mfaPassed: boolean;
  mustChangePassword: boolean;
  csrfToken: string;
}

export interface GameContext {
  serverId: string;
  apiKeyId: string;
  keyName: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    cfg: AppConfig;
    enc: Encryptor;
    realtime: Realtime;
    authenticate: (req: FastifyRequest) => Promise<void>;
    requireServer: (perm?: Permission | Permission[]) => (req: FastifyRequest) => Promise<void>;
    requireGame: (req: FastifyRequest) => Promise<void>;
    fetchImpl: typeof fetch;
  }
  interface FastifyRequest {
    user?: SessionUser;
    access?: MemberAccess;
    game?: GameContext;
    actor: () => Actor;
  }
}
