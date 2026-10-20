import type { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw badRequest(
      'Validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

/** FiveM's dkjson encodes empty Lua tables as []. Accept that wherever an object is expected. */
export function emptyArrayAsObject(v: unknown): unknown {
  return Array.isArray(v) && v.length === 0 ? {} : v;
}
