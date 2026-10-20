import { z } from 'zod';

/**
 * The FiveM resource is the single source of truth for which settings exist. It reports a schema
 * descriptor on handshake; the web UI renders the settings form from it and the backend validates
 * overrides against it. The resource validates the overrides again before applying them.
 */

const paramSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('number'), label: z.string().max(120), unit: z.string().max(20).optional(), min: z.number(), max: z.number(), default: z.number() }),
  z.object({ type: z.literal('integer'), label: z.string().max(120), unit: z.string().max(20).optional(), min: z.number().int(), max: z.number().int(), default: z.number().int() }),
  z.object({ type: z.literal('boolean'), label: z.string().max(120), default: z.boolean() }),
  z.object({ type: z.literal('enum'), label: z.string().max(120), values: z.array(z.string().max(64)).min(1).max(50), default: z.string() }),
  z.object({
    type: z.literal('list'),
    label: z.string().max(120),
    maxItems: z.number().int().min(0).max(1000),
    default: z.array(z.string().max(128)),
  }),
]);
export type ParamSpec = z.infer<typeof paramSpec>;

const LIST_ITEM = /^[A-Za-z0-9_:.-]{1,128}$/;

const moduleSpec = z.object({
  label: z.string().max(120),
  category: z.string().max(40),
  description: z.string().max(2000).default(''),
  limitations: z.string().max(2000).default(''),
  source: z.enum(['server', 'client', 'event', 'resource', 'system']),
  defaults: z.object({
    enabled: z.boolean(),
    action: z.string().max(16),
    severity: z.string().max(16),
  }),
  params: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), paramSpec).default({}),
});

export const configSchemaDescriptor = z.object({
  version: z.number().int().min(1),
  actions: z.array(z.string().max(16)).min(1).max(10),
  severities: z.array(z.string().max(16)).min(1).max(10),
  modules: z.record(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/), moduleSpec).refine((m) => Object.keys(m).length <= 200, 'too many modules'),
  risk: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), paramSpec).default({}),
});
export type ConfigSchemaDescriptor = z.infer<typeof configSchemaDescriptor>;

export interface ModuleOverride {
  enabled?: boolean;
  action?: string;
  severity?: string;
  params?: Record<string, unknown>;
}
export interface ConfigOverrides {
  modules?: Record<string, ModuleOverride>;
  risk?: Record<string, unknown>;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

function checkParam(spec: ParamSpec, value: unknown, path: string, issues: ValidationIssue[]) {
  switch (spec.type) {
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return issues.push({ path, message: 'must be a number' });
      if (spec.type === 'integer' && !Number.isInteger(value)) return issues.push({ path, message: 'must be an integer' });
      if (value < spec.min || value > spec.max) return issues.push({ path, message: `must be between ${spec.min} and ${spec.max}` });
      return;
    case 'boolean':
      if (typeof value !== 'boolean') issues.push({ path, message: 'must be true or false' });
      return;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) issues.push({ path, message: `must be one of: ${spec.values.join(', ')}` });
      return;
    case 'list': {
      if (!Array.isArray(value)) return issues.push({ path, message: 'must be a list' });
      if (value.length > spec.maxItems) return issues.push({ path, message: `at most ${spec.maxItems} items` });
      // A fixed pattern on purpose: regexes supplied by a remote party would be a ReDoS vector.
      value.forEach((item, i) => {
        if (typeof item !== 'string' || !LIST_ITEM.test(item)) issues.push({ path: `${path}[${i}]`, message: 'must match [A-Za-z0-9_:.-], 1-128 chars' });
      });
      return;
    }
  }
}

/** Validates overrides against the schema. Unknown keys are errors (never silently ignored). */
export function validateOverrides(schema: ConfigSchemaDescriptor, raw: unknown): { ok: true; value: ConfigOverrides } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, issues: [{ path: '', message: 'must be an object' }] };
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (k !== 'modules' && k !== 'risk') issues.push({ path: k, message: 'unknown key' });

  const out: ConfigOverrides = {};
  if (obj.modules !== undefined) {
    if (typeof obj.modules !== 'object' || obj.modules === null || Array.isArray(obj.modules)) {
      issues.push({ path: 'modules', message: 'must be an object' });
    } else {
      out.modules = {};
      for (const [key, ov] of Object.entries(obj.modules as Record<string, unknown>)) {
        const spec = schema.modules[key];
        const base = `modules.${key}`;
        if (!spec) {
          issues.push({ path: base, message: 'unknown module' });
          continue;
        }
        if (typeof ov !== 'object' || ov === null || Array.isArray(ov)) {
          issues.push({ path: base, message: 'must be an object' });
          continue;
        }
        const o = ov as Record<string, unknown>;
        const clean: ModuleOverride = {};
        for (const k of Object.keys(o)) {
          if (!['enabled', 'action', 'severity', 'params'].includes(k)) issues.push({ path: `${base}.${k}`, message: 'unknown key' });
        }
        if (o.enabled !== undefined) {
          if (typeof o.enabled !== 'boolean') issues.push({ path: `${base}.enabled`, message: 'must be true or false' });
          else clean.enabled = o.enabled;
        }
        if (o.action !== undefined) {
          if (typeof o.action !== 'string' || !schema.actions.includes(o.action)) issues.push({ path: `${base}.action`, message: `must be one of: ${schema.actions.join(', ')}` });
          else if (o.action === 'ban' && spec.source === 'client') issues.push({ path: `${base}.action`, message: 'client-side signals cannot trigger automatic bans' });
          else clean.action = o.action;
        }
        if (o.severity !== undefined) {
          if (typeof o.severity !== 'string' || !schema.severities.includes(o.severity)) issues.push({ path: `${base}.severity`, message: `must be one of: ${schema.severities.join(', ')}` });
          else clean.severity = o.severity;
        }
        if (o.params !== undefined) {
          if (typeof o.params !== 'object' || o.params === null || Array.isArray(o.params)) {
            issues.push({ path: `${base}.params`, message: 'must be an object' });
          } else {
            clean.params = {};
            for (const [pk, pv] of Object.entries(o.params as Record<string, unknown>)) {
              const ps = spec.params[pk];
              if (!ps) {
                issues.push({ path: `${base}.params.${pk}`, message: 'unknown parameter' });
                continue;
              }
              const before = issues.length;
              checkParam(ps, pv, `${base}.params.${pk}`, issues);
              if (issues.length === before) clean.params[pk] = pv;
            }
          }
        }
        out.modules[key] = clean;
      }
    }
  }
  if (obj.risk !== undefined) {
    if (typeof obj.risk !== 'object' || obj.risk === null || Array.isArray(obj.risk)) {
      issues.push({ path: 'risk', message: 'must be an object' });
    } else {
      out.risk = {};
      for (const [rk, rv] of Object.entries(obj.risk as Record<string, unknown>)) {
        const ps = schema.risk[rk];
        if (!ps) {
          issues.push({ path: `risk.${rk}`, message: 'unknown parameter' });
          continue;
        }
        const before = issues.length;
        checkParam(ps, rv, `risk.${rk}`, issues);
        if (issues.length === before) out.risk[rk] = rv;
      }
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: out };
}
