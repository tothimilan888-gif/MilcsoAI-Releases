process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? 'postgres://mg:mg_dev_pw@127.0.0.1:5432/milcsoguard_test';
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.LOG_LEVEL ??= 'silent';
process.env.RATE_LIMIT_PER_MINUTE ??= '100000';
process.env.LOGIN_RATE_LIMIT ??= '10000';
