import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { audit, type Actor } from '../lib/audit.js';
import { sendDiscordAlert, severityRank, SEVERITY_ORDER, type Severity } from '../lib/discord.js';
import { notFound } from '../lib/errors.js';
import { normaliseIdentifiers } from '../lib/identifiers.js';
import { Where, type Page } from '../lib/pagination.js';
import { publish } from '../lib/realtime.js';
import { emptyArrayAsObject } from '../lib/validate.js';
import { resolvePlayer } from './players.js';

export const detectionInput = z.object({
  localId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  type: z.string().min(3).max(64).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/),
  module: z.string().min(2).max(32).regex(/^[a-z][a-z0-9_]*$/),
  severity: z.enum(SEVERITY_ORDER),
  riskScore: z.number().int().min(0).max(100000),
  source: z.enum(['server', 'client', 'event', 'resource', 'system']),
  action: z.enum(['log', 'warn', 'monitor', 'kick', 'ban']),
  actionResult: z.string().max(200).default(''),
  netId: z.number().int().min(0).max(65535).nullable().optional(),
  playerName: z.string().max(64).default(''),
  identifiers: z.array(z.string().max(100)).max(32).default([]),
  // Evidence is free-form but bounded; it is rendered as JSON (never as HTML) in the UIs.
  evidence: z.preprocess(emptyArrayAsObject, z.record(z.string(), z.unknown())).refine((e) => JSON.stringify(e).length <= 16_000, 'evidence too large').default({}),
  occurredAt: z.coerce.date(),
});
export type DetectionInput = z.infer<typeof detectionInput>;

export interface DetectionRow {
  id: string;
  local_id: string;
  player_id: string | null;
  player_name: string;
  net_id: number | null;
  identifiers: string[];
  type: string;
  module: string;
  severity: Severity;
  risk_score: number;
  source: string;
  evidence: Record<string, unknown>;
  action: string;
  action_result: string;
  occurred_at: Date;
  received_at: Date;
  review_status: string;
  reviewed_by_label: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
}

export const DETECTION_COLUMNS = `id, local_id, player_id, player_name, net_id, identifiers, type, module, severity, risk_score, source,
  evidence, action, action_result, occurred_at, received_at, review_status, reviewed_by_label, reviewed_at, review_note`;

/** Idempotent batch ingest (the game server may resend after a timeout). Returns localId -> id. */
export async function ingestDetections(app: FastifyInstance, serverId: string, items: DetectionInput[]) {
  const ids: Record<string, string> = {};
  const created: { id: string; d: DetectionInput }[] = [];
  await withTx(app.db, async (tx) => {
    for (const d of items) {
      const idents = normaliseIdentifiers(d.identifiers);
      const { playerId } = await resolvePlayer(tx, serverId, idents, d.playerName, { create: idents.length > 0, touch: false });
      // Clock skew guard: a detection cannot be from the future or older than 7 days.
      const now = Date.now();
      const occurred = Math.min(Math.max(d.occurredAt.getTime(), now - 7 * 86400_000), now + 60_000);
      const r = await tx.query<{ id: string; inserted: boolean }>(
        `INSERT INTO detections (server_id, local_id, player_id, player_name, net_id, identifiers, type, module, severity, risk_score,
                                 source, evidence, action, action_result, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (server_id, local_id) DO UPDATE SET local_id = EXCLUDED.local_id
         RETURNING id, (xmax = 0) AS inserted`,
        [
          serverId, d.localId, playerId, d.playerName, d.netId ?? null, JSON.stringify(idents.map((i) => `${i.type}:${i.value}`)),
          d.type, d.module, d.severity, d.riskScore, d.source, JSON.stringify(d.evidence), d.action, d.actionResult, new Date(occurred),
        ],
      );
      const row = r.rows[0]!;
      ids[d.localId] = row.id;
      if (row.inserted) created.push({ id: row.id, d });
    }
    for (const c of created.slice(0, 50)) {
      await publish(tx, {
        serverId,
        type: 'detection.created',
        data: { id: c.id, type: c.d.type, severity: c.d.severity, player: c.d.playerName, action: c.d.action },
      });
    }
  });

  // Alerts are sent after commit, never block ingestion and are capped per batch.
  const alertable = created.filter((c) => severityRank(c.d.severity) >= severityRank('MEDIUM')).slice(0, 5);
  for (const c of alertable) {
    void sendDiscordAlert(
      app.db,
      app.enc,
      serverId,
      {
        title: `${c.d.severity}: ${c.d.type}`,
        severity: c.d.severity,
        fields: [
          { name: 'Játékos', value: `${c.d.playerName || '?'} (#${c.d.netId ?? '?'})`, inline: true },
          { name: 'Forrás', value: c.d.source, inline: true },
          { name: 'Intézkedés', value: `${c.d.action} ${c.d.actionResult}`.trim(), inline: true },
          { name: 'Kockázat', value: String(c.d.riskScore), inline: true },
        ],
      },
      (m) => app.log.warn(m),
      app.fetchImpl,
    );
  }
  return { ids, created: created.length };
}

export const detectionListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().max(100).optional(),
  type: z.string().max(64).optional(),
  module: z.string().max(32).optional(),
  severity: z.enum(SEVERITY_ORDER).optional(),
  minSeverity: z.enum(SEVERITY_ORDER).optional(),
  source: z.enum(['server', 'client', 'event', 'resource', 'system']).optional(),
  review: z.enum(['pending', 'confirmed', 'false_positive', 'dismissed']).optional(),
  playerId: z.uuid().optional(),
  identifier: z.string().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export async function listDetections(db: Queryable, serverId: string, q: z.infer<typeof detectionListQuery>): Promise<Page<DetectionRow>> {
  const w = new Where().add('server_id = ?', serverId);
  if (q.type) w.add('type = ?', q.type);
  if (q.module) w.add('module = ?', q.module);
  if (q.severity) w.add('severity = ?', q.severity);
  if (q.minSeverity) w.add('severity >= ?::severity', q.minSeverity);
  if (q.source) w.add('source = ?', q.source);
  if (q.review) w.add('review_status = ?', q.review);
  if (q.playerId) w.add('player_id = ?', q.playerId);
  if (q.identifier) w.add('identifiers @> ?::jsonb', JSON.stringify([q.identifier.toLowerCase()]));
  if (q.from) w.add('occurred_at >= ?', q.from);
  if (q.to) w.add('occurred_at <= ?', q.to);
  if (q.q) w.add("(player_name ILIKE ? OR type ILIKE ?)", `%${escapeLike(q.q)}%`, `%${escapeLike(q.q)}%`);
  const total = (await db.query<{ n: number }>(`SELECT count(*) AS n FROM detections ${w}`, w.params)).rows[0]!.n;
  const limit = w.next(q.pageSize);
  const offset = w.next((q.page - 1) * q.pageSize);
  const items = (
    await db.query<DetectionRow>(`SELECT ${DETECTION_COLUMNS} FROM detections ${w} ORDER BY occurred_at DESC LIMIT ${limit} OFFSET ${offset}`, w.params)
  ).rows;
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function reviewDetection(
  db: Queryable,
  serverId: string,
  id: string,
  status: 'confirmed' | 'false_positive' | 'dismissed' | 'pending',
  note: string,
  actor: Actor,
): Promise<DetectionRow> {
  const r = await db.query<DetectionRow>(
    `UPDATE detections SET review_status = $3, review_note = $4, reviewed_by = $5, reviewed_by_label = $6, reviewed_at = now()
      WHERE id = $1 AND server_id = $2 RETURNING ${DETECTION_COLUMNS}`,
    [id, serverId, status, note, actor.userId ?? null, actor.label],
  );
  const row = r.rows[0];
  if (!row) throw notFound('Detection not found');
  await audit(db, actor, { serverId, action: 'detection.review', targetType: 'detection', targetId: id, details: { status, note, type: row.type } });
  return row;
}
