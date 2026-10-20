import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** Returns the 32 raw key bytes, or null when the value is not a valid 32-byte key. */
export function decodeKey(value: string): Buffer | null {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) {
    const b = Buffer.from(v, 'base64');
    if (b.length === 32) return b;
  }
  return null;
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // 32-byte key: base64 (openssl rand -base64 32) or 64 hex characters (openssl rand -hex 32).
  // Used for AES-256-GCM encryption of TOTP secrets and webhook URLs.
  APP_ENCRYPTION_KEY: z.string().superRefine((v, ctx) => {
    if (decodeKey(v) !== null) return;
    ctx.addIssue({
      code: 'custom',
      message: `APP_ENCRYPTION_KEY must decode to exactly 32 bytes: base64 (openssl rand -base64 32) or 64 hex chars (openssl rand -hex 32). Got ${v.trim().length} characters${v.trim() !== v ? ' (leading/trailing whitespace – remove it)' : ''}.`,
    });
  }),
  // Comma separated list of allowed browser origins (only needed when the web UI is hosted on another origin).
  CORS_ORIGINS: z.string().default(''),
  COOKIE_SECURE: bool.optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(120),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
  TRUST_PROXY: bool.default(false),
  WEB_DIST_DIR: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(300),
  // Per-IP limit for login / MFA / password endpoints within 5 minutes.
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(8),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),
  RETENTION_JOB_MINUTES: z.coerce.number().int().min(1).default(60),
  GAME_HEARTBEAT_STALE_SECONDS: z.coerce.number().int().min(30).default(120),
  // Allow the game resource to report from plain HTTP (only for local development).
  ALLOW_INSECURE_GAME_HTTP: bool.default(false),
});

export type AppConfig = z.infer<typeof EnvSchema> & { corsOrigins: string[]; cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const c = { ...parsed.data, APP_ENCRYPTION_KEY: decodeKey(parsed.data.APP_ENCRYPTION_KEY)!.toString('base64') };
  if (c.NODE_ENV === 'production' && c.ALLOW_INSECURE_GAME_HTTP) {
    throw new Error('ALLOW_INSECURE_GAME_HTTP must not be enabled in production');
  }
  return {
    ...c,
    corsOrigins: c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production',
  };
}
