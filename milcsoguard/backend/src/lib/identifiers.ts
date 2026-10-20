import { z } from 'zod';

/** FiveM identifier types the system understands. `ip` is accepted but never used for matching by default. */
export const IDENTIFIER_TYPES = ['license', 'license2', 'discord', 'fivem', 'steam', 'xbl', 'live', 'ip', 'token'] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

const PATTERNS: Record<IdentifierType, RegExp> = {
  license: /^[a-f0-9]{40}$/,
  license2: /^[a-f0-9]{40}$/,
  discord: /^\d{15,21}$/,
  fivem: /^\d{1,12}$/,
  steam: /^[a-f0-9]{15,17}$/,
  xbl: /^\d{10,20}$/,
  live: /^\d{10,20}$/,
  ip: /^[0-9a-fA-F:.]{3,45}$/,
  // GetPlayerToken values: "<n>:<hex>"
  token: /^\d{1,2}:[a-f0-9]{64}$/,
};

export interface Identifier {
  type: IdentifierType;
  value: string;
}

/** Parses "license:abc..." into {type, value}. Returns null for unknown or malformed identifiers. */
export function parseIdentifier(raw: string): Identifier | null {
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const type = raw.slice(0, idx).toLowerCase() as IdentifierType;
  const value = raw.slice(idx + 1).trim().toLowerCase();
  if (!(IDENTIFIER_TYPES as readonly string[]).includes(type)) return null;
  if (!PATTERNS[type].test(value)) return null;
  return { type, value };
}

export function formatIdentifier(i: Identifier): string {
  return `${i.type}:${i.value}`;
}

/** Normalises and de-duplicates a list of raw identifiers, dropping invalid ones. */
export function normaliseIdentifiers(raw: readonly string[]): Identifier[] {
  const seen = new Set<string>();
  const out: Identifier[] = [];
  for (const r of raw) {
    const p = parseIdentifier(r);
    if (!p) continue;
    const key = formatIdentifier(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export const identifierListSchema = z.array(z.string().max(100)).max(32);

/** Masks an identifier value for users without players.identifiers permission. */
export function maskIdentifier(i: string): string {
  const idx = i.indexOf(':');
  if (idx < 0) return '***';
  const value = i.slice(idx + 1);
  if (value.length <= 6) return `${i.slice(0, idx)}:***`;
  return `${i.slice(0, idx)}:${value.slice(0, 4)}…${value.slice(-2)}`;
}
