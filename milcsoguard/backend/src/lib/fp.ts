import type { FastifyPluginAsync } from 'fastify';

/** Minimal equivalent of `fastify-plugin`: lets decorators escape the plugin's encapsulation context. */
export default function fp<T extends FastifyPluginAsync>(fn: T): T {
  (fn as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
  return fn;
}
