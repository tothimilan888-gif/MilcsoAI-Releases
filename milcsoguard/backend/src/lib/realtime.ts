import type pg from 'pg';
import type { Db, Queryable } from '../db/pool.js';

export interface RealtimeEvent {
  serverId: string;
  type: string;
  data: Record<string, unknown>;
}

type Listener = (e: RealtimeEvent) => void;

const CHANNEL = 'mg_events';

/**
 * Fan-out of server-scoped events to SSE subscribers. Uses PostgreSQL LISTEN/NOTIFY so that several
 * backend instances behind a load balancer all see every event.
 */
export class Realtime {
  private listeners = new Set<Listener>();
  private client: pg.PoolClient | null = null;
  private stopped = false;

  constructor(private readonly db: Db, private readonly log: (msg: string) => void = () => undefined) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    try {
      const client = await this.db.connect();
      client.on('notification', (msg) => {
        if (msg.channel !== CHANNEL || !msg.payload) return;
        try {
          const ev = JSON.parse(msg.payload) as RealtimeEvent;
          for (const l of this.listeners) l(ev);
        } catch {
          /* ignore malformed payloads */
        }
      });
      client.on('error', () => this.reconnect(client));
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
    } catch (err) {
      this.log(`realtime listen failed: ${(err as Error).message}; retrying in 5s`);
      if (!this.stopped) setTimeout(() => void this.connect(), 5000).unref();
    }
  }

  private reconnect(client: pg.PoolClient) {
    try {
      client.release(true);
    } catch {
      /* already released */
    }
    this.client = null;
    if (!this.stopped) setTimeout(() => void this.connect(), 1000).unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.client) {
      await this.client.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      this.client.release();
      this.client = null;
    }
    this.listeners.clear();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get subscriberCount() {
    return this.listeners.size;
  }
}

/** Publishes an event. Payloads are kept small (ids + summary); clients refetch details. */
export async function publish(db: Queryable, ev: RealtimeEvent): Promise<void> {
  const payload = JSON.stringify(ev);
  if (payload.length > 7900) return; // NOTIFY limit is 8000 bytes
  await db.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
}
