import { describe, expect, it } from 'vitest';
import { base32Encode, Encryptor, generateApiKey, hashPassword, parseApiKey, totpCode, verifyPassword, verifyTotp } from '../src/lib/crypto.js';
import { configSchemaDescriptor, validateOverrides } from '../src/lib/configSchema.js';
import { maskIdentifier, normaliseIdentifiers, parseIdentifier } from '../src/lib/identifiers.js';
import { SCHEMA } from './fixtures.js';

describe('crypto', () => {
  it('hashes and verifies passwords, rejecting wrong ones', async () => {
    const h = await hashPassword('Secret-Password-1');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('Secret-Password-1', h)).toBe(true);
    expect(await verifyPassword('secret-password-1', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('matches the RFC 6238 SHA1 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // RFC 6238 T=59s -> 94287082 (8 digits); 6-digit truncation -> 287082
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(totpCode(secret, 1111111109_000)).toBe('081804');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '287082', 59_000 + 120_000)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', 59_000)).toBe(false);
  });

  it('encrypts with AES-GCM and detects tampering', () => {
    const e = new Encryptor(Buffer.alloc(32, 1).toString('base64'));
    const c = e.encrypt('https://discord.com/api/webhooks/1/abc');
    expect(e.decrypt(c)).toBe('https://discord.com/api/webhooks/1/abc');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => e.decrypt(parts.join('.'))).toThrow();
    expect(() => new Encryptor(Buffer.alloc(31).toString('base64'))).toThrow();
  });

  it('generates parseable API keys', () => {
    const k = generateApiKey();
    expect(parseApiKey(k.full)?.prefix).toBe(k.prefix);
    expect(parseApiKey('mgk_short_x')).toBeNull();
  });
});

describe('identifiers', () => {
  it('normalises, validates and de-duplicates', () => {
    const ids = normaliseIdentifiers(['license:' + 'A'.repeat(40), 'license:' + 'a'.repeat(40), 'discord:123', 'steam:110000112345678', 'bogus:1', 'nocolon']);
    expect(ids).toEqual([{ type: 'license', value: 'a'.repeat(40) }, { type: 'steam', value: '110000112345678' }]);
    expect(parseIdentifier('discord:123456789012345678')).toEqual({ type: 'discord', value: '123456789012345678' });
    expect(maskIdentifier('license:' + 'abcdef1234'.repeat(4))).toBe('license:abcd…34');
  });
});

describe('config schema validation', () => {
  const schema = configSchemaDescriptor.parse(SCHEMA);
  it('accepts valid overrides', () => {
    const r = validateOverrides(schema, { modules: { 'movement.teleport': { enabled: false, action: 'log', params: { maxDistance: 300 } } }, risk: { banThreshold: 200 } });
    expect(r.ok).toBe(true);
  });
  it('rejects unknown modules, bad ranges and types with detailed paths', () => {
    const r = validateOverrides(schema, {
      modules: { 'movement.teleport': { params: { maxDistance: 1, nope: 1 }, action: 'explode' }, 'unknown.module': {} },
      risk: { banThreshold: 5.5 },
      extra: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.issues.map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining([
        'extra', 'modules.unknown.module', 'modules.movement.teleport.params.maxDistance',
        'modules.movement.teleport.params.nope', 'modules.movement.teleport.action', 'risk.banThreshold',
      ]));
    }
  });
  it('never allows automatic bans for client-side modules', () => {
    const r = validateOverrides(schema, { modules: { 'client.heartbeat': { action: 'ban' } } });
    expect(r.ok).toBe(false);
  });
  it('validates list items with a fixed safe pattern', () => {
    expect(validateOverrides(schema, { modules: { 'weapons.blacklist': { params: { weapons: ['WEAPON_RPG', 'bad item!'] } } } }).ok).toBe(false);
    expect(validateOverrides(schema, { modules: { 'weapons.blacklist': { params: { weapons: ['A', 'B', 'C', 'D'] } } } }).ok).toBe(false);
  });
});

describe('APP_ENCRYPTION_KEY formats', () => {
  const env = (key: string) => ({ DATABASE_URL: 'postgres://x', APP_ENCRYPTION_KEY: key });
  it('accepts base64 and hex 32-byte keys and normalises them', async () => {
    const { loadConfig } = await import('../src/config.js');
    const raw = Buffer.alloc(32, 9);
    expect(loadConfig(env(raw.toString('base64'))).APP_ENCRYPTION_KEY).toBe(raw.toString('base64'));
    expect(loadConfig(env(raw.toString('hex'))).APP_ENCRYPTION_KEY).toBe(raw.toString('base64'));
    expect(loadConfig(env(`  ${raw.toString('base64')}\n`)).APP_ENCRYPTION_KEY).toBe(raw.toString('base64'));
  });
  it('rejects anything else with a helpful message', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig(env('my-secret-key'))).toThrow(/32 bytes.*Got 13 characters/);
    expect(() => loadConfig(env(Buffer.alloc(16).toString('base64')))).toThrow(/32 bytes/);
    expect(() => loadConfig(env('<generated>'))).toThrow(/32 bytes/);
  });
});
