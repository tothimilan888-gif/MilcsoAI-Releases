import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTx, type Queryable } from '../db/pool.js';
import { audit, type Actor } from '../lib/audit.js';
import { configSchemaDescriptor } from '../lib/configSchema.js';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { formatIdentifier, normaliseIdentifiers, type Identifier } from '../lib/identifiers.js';
import { isPermission, type Permission } from '../lib/permissions.js';
import { publish } from '../lib/realtime.js';
import { emptyArrayAsObject, parse } from '../lib/validate.js';
import { BAN_COLUMNS, banIdentifiers, createBan, findActiveBan, revokeBan, type BanRow } from '../services/bans.js';
import { takePendingCommands } from '../services/commands.js';
import { DETECTION_COLUMNS, detectionInput, detectionListQuery, ingestDetections, listDetections, reviewDetection, type DetectionRow } from '../services/detections.js';
import { resolvePlayer } from '../services/players.js';
import { activeWhitelist, playerWhitelist } from '../services/whitelist.js';
import {
  REPLAY_COLUMNS, REPLAY_MAX_PART_BYTES, REPLAY_MAX_PARTS, REPLAY_MAX_TOTAL_BYTES,
  assertUploadable, ensureStorage, getReplay, linkReplaysToBan, replayParts, type ReplayRow,
} from '../services/replays.js';
import { MAX_TEMP_BAN_SECONDS } from './bans.js';
import { auditQuery, listAudit } from './audit.js';
import { dashboardStats } from './analytics.js';
import { getConfig, saveConfig } from './config.js';
import { addWhitelist, removeWhitelist } from './whitelist.js';

const identifiers = z.array(z.string().max(100)).max(32);

/** An in-game admin as reported by the game server (which already checked the permission locally). */
const actorSchema = z.object({
  name: z.string().max(64),
  identifiers,
  source: z.enum(['ace', 'framework', 'backend', 'console']).default('ace'),
});
type ActorInput = z.infer<typeof actorSchema>;

interface LinkedAdmin {
  userId: string;
  username: string;
  roleKey: string;
  roleName: string;
  level: number;
  permissions: string[];
}

async function findLinkedAdmin(db: Queryable, serverId: string, ids: Identifier[]): Promise<LinkedAdmin | null> {
  const linkable = ids.filter((i) => !['ip', 'token'].includes(i.type));
  if (!linkable.length) return null;
  const r = await db.query<LinkedAdmin & { is_platform_admin: boolean }>(
    `SELECT u.id AS "userId", u.username, u.is_platform_admin, r.key AS "roleKey", r.name AS "roleName", r.level,
            COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
       FROM user_identifiers ui
       JOIN users u ON u.id = ui.user_id AND u.disabled_at IS NULL
       JOIN server_members m ON m.user_id = u.id AND m.server_id = $1
       JOIN roles r ON r.id = m.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE (ui.type, ui.value) IN (SELECT * FROM unnest($2::text[], $3::text[]))
      GROUP BY u.id, r.id ORDER BY r.level DESC LIMIT 1`,
    [serverId, linkable.map((i) => i.type), linkable.map((i) => i.value)],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, permissions: row.permissions.filter(isPermission) };
}

/**
 * Builds the audit actor for an in-game action. If the in-game admin is linked to a web account,
 * the backend role is authoritative and must also contain the permission.
 */
async function gameActor(app: FastifyInstance, req: FastifyRequest, input: ActorInput | undefined, perm: Permission | null): Promise<Actor> {
  if (!input) return { type: 'system', label: 'anticheat:auto', ip: req.ip };
  const ids = normaliseIdentifiers(input.identifiers);
  const primary = ids.find((i) => i.type === 'license') ?? ids[0];
  const label = `ingame:${input.name || '?'}${primary ? ` [${formatIdentifier(primary).slice(0, 20)}]` : ''}`;
  if (input.source === 'console') return { type: 'game_admin', label: 'ingame:console', ip: req.ip };
  const linked = await findLinkedAdmin(app.db, req.game!.serverId, ids);
  if (linked && perm && !linked.permissions.includes(perm)) {
    throw forbidden(`Linked web account ${linked.username} lacks permission ${perm}`);
  }
  return { type: 'game_admin', userId: linked?.userId ?? null, label, ip: req.ip };
}

const handshakeBody = z.object({
  resourceVersion: z.string().max(32),
  artifact: z.string().max(200).default(''),
  framework: z.string().max(32).default('standalone'),
  onesync: z.string().max(32).default(''),
  dependencies: z.preprocess(emptyArrayAsObject, z.record(z.string().max(64), z.string().max(32))).default({}),
  schema: z.unknown(),
  effective: z.preprocess(emptyArrayAsObject, z.record(z.string(), z.unknown())).refine((e) => JSON.stringify(e).length <= 200_000, 'effective config too large').default({}),
});

const playerSchema = z.object({
  netId: z.number().int().min(0).max(65535),
  name: z.string().max(64),
  identifiers,
  ping: z.number().int().min(0).max(100000).default(0),
  risk: z.number().int().min(0).max(100000).default(0),
  monitored: z.boolean().default(false),
});

const heartbeatBody = z.object({
  players: z.array(playerSchema).max(2048),
  resources: z.array(z.object({ name: z.string().max(64), state: z.string().max(16) })).max(200).default([]),
  stats: z.preprocess(emptyArrayAsObject, z.record(z.string().max(40), z.union([z.number(), z.string().max(100), z.boolean()]))).default({}),
  configVersion: z.number().int().min(0).default(0),
  queueSize: z.number().int().min(0).default(0),
  uptimeSeconds: z.number().int().min(0).default(0),
});

function presentBanForGame(b: BanRow, ids: string[]) {
  return {
    id: b.id, code: b.public_code, reason: b.reason, playerName: b.player_name,
    createdAt: b.created_at, expiresAt: b.expires_at, identifiers: ids,
  };
}

async function openSession(db: Queryable, serverId: string, playerId: string, netId: number, name: string) {
  // Net ids are recycled: close any stale session that still holds this id.
  await db.query(
    "UPDATE player_sessions SET disconnected_at = now(), disconnect_reason = 'net id reused' WHERE server_id = $1 AND net_id = $2 AND disconnected_at IS NULL",
    [serverId, netId],
  );
  await db.query('INSERT INTO player_sessions (server_id, player_id, net_id, name) VALUES ($1, $2, $3, $4)', [serverId, playerId, netId, name.slice(0, 64)]);
}

export default async function gameRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGame);

  app.post('/handshake', async (req) => {
    const body = parse(handshakeBody, req.body);
    const sid = req.game!.serverId;
    const schema = configSchemaDescriptor.safeParse(body.schema);
    if (!schema.success) {
      throw unprocessable('Settings schema rejected', schema.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const server = (await app.db.query<{ name: string; ban_match_types: string[] }>('SELECT name, ban_match_types FROM servers WHERE id = $1', [sid])).rows[0]!;
    await withTx(app.db, async (tx) => {
      await tx.query(
        `UPDATE servers SET last_heartbeat_at = now(), updated_at = now(),
                status_info = status_info || $2::jsonb WHERE id = $1`,
        [sid, JSON.stringify({ resourceVersion: body.resourceVersion, artifact: body.artifact, framework: body.framework, onesync: body.onesync, dependencies: body.dependencies, startedAt: new Date().toISOString() })],
      );
      await tx.query('UPDATE server_configs SET schema = $2, effective = $3 WHERE server_id = $1', [sid, JSON.stringify(schema.data), JSON.stringify(body.effective)]);
      // A (re)start means every previously open session is over.
      await tx.query("UPDATE player_sessions SET disconnected_at = now(), disconnect_reason = 'server restart' WHERE server_id = $1 AND disconnected_at IS NULL", [sid]);
      await tx.query(
        "INSERT INTO system_events (server_id, type, severity, message, data) VALUES ($1, 'game_start', 'INFO', $2, $3)",
        [sid, `Resource elindult (v${body.resourceVersion}, ${body.framework})`, JSON.stringify({ artifact: body.artifact, dependencies: body.dependencies })],
      );
      await publish(tx, { serverId: sid, type: 'server.status', data: { online: true } });
    });
    const cfg = await getConfig(app, sid);
    return {
      serverId: sid,
      serverName: server.name,
      banMatchTypes: server.ban_match_types,
      config: { version: cfg.version, overrides: cfg.overrides },
      whitelist: await activeWhitelist(app.db, sid),
      time: new Date().toISOString(),
    };
  });

  app.post('/heartbeat', async (req) => {
    const body = parse(heartbeatBody, req.body);
    const sid = req.game!.serverId;
    const res = await withTx(app.db, async (tx) => {
      const prev = (await tx.query<{ last_heartbeat_at: Date | null }>('SELECT last_heartbeat_at FROM servers WHERE id = $1 FOR UPDATE', [sid])).rows[0]!;
      const wasStale = !prev.last_heartbeat_at || Date.now() - prev.last_heartbeat_at.getTime() > app.cfg.GAME_HEARTBEAT_STALE_SECONDS * 1000;
      await tx.query(
        `UPDATE servers SET last_heartbeat_at = now(), status_info = status_info || $2::jsonb WHERE id = $1`,
        [sid, JSON.stringify({ resources: body.resources, stats: body.stats, playerCount: body.players.length, queueSize: body.queueSize, uptimeSeconds: body.uptimeSeconds, configVersionApplied: body.configVersion })],
      );
      if (wasStale && prev.last_heartbeat_at) {
        await tx.query("INSERT INTO system_events (server_id, type, severity, message) VALUES ($1, 'heartbeat_restored', 'LOW', 'A játékszerver kapcsolata helyreállt')", [sid]);
      }
      const open = (await tx.query<{ id: string; net_id: number }>('SELECT id, net_id FROM player_sessions WHERE server_id = $1 AND disconnected_at IS NULL', [sid])).rows;
      const byNet = new Map(open.map((s) => [s.net_id, s.id]));
      const seen = new Set<number>();
      let changed = false;
      for (const p of body.players) {
        seen.add(p.netId);
        const sessionId = byNet.get(p.netId);
        if (sessionId) {
          await tx.query('UPDATE player_sessions SET last_ping = $2, risk_score = $3, monitored = $4, name = $5 WHERE id = $1', [sessionId, p.ping, p.risk, p.monitored, p.name.slice(0, 64)]);
        } else {
          const ids = normaliseIdentifiers(p.identifiers);
          const { playerId } = await resolvePlayer(tx, sid, ids, p.name, { create: true, touch: true });
          if (playerId) {
            await openSession(tx, sid, playerId, p.netId, p.name);
            changed = true;
          }
        }
      }
      const stale = open.filter((s) => !seen.has(s.net_id)).map((s) => s.id);
      if (stale.length) {
        await tx.query("UPDATE player_sessions SET disconnected_at = now(), disconnect_reason = COALESCE(disconnect_reason, 'not in heartbeat') WHERE id = ANY($1::uuid[])", [stale]);
        changed = true;
      }
      if (changed) await publish(tx, { serverId: sid, type: 'players.changed', data: { count: body.players.length } });
      const cfg = (await tx.query<{ version: number }>('SELECT version FROM server_configs WHERE server_id = $1', [sid])).rows[0]!;
      const pending = (await tx.query<{ n: number }>("SELECT count(*) AS n FROM server_commands WHERE server_id = $1 AND status = 'pending' AND expires_at > now()", [sid])).rows[0]!;
      return { configVersion: cfg.version, pendingCommands: pending.n };
    });
    return { ...res, time: new Date().toISOString() };
  });

  app.post('/players/connect', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({ name: z.string().max(64), identifiers }), req.body);
    const sid = req.game!.serverId;
    const ids = normaliseIdentifiers(body.identifiers);
    return withTx(app.db, async (tx) => {
      const { playerId } = await resolvePlayer(tx, sid, ids, body.name, { create: true, touch: true });
      const ban = await findActiveBan(tx, sid, ids);
      if (ban) {
        // Ban evasion hardening: identifiers seen together with a banned identifier join the ban.
        const before = (await banIdentifiers(tx, [ban.id])).get(ban.id) ?? [];
        const add = ids.filter((i) => i.type !== 'ip' && !before.includes(formatIdentifier(i)));
        if (add.length) {
          await tx.query(
            'INSERT INTO ban_identifiers (ban_id, server_id, type, value) SELECT $1, $2, t, v FROM unnest($3::text[], $4::text[]) AS x(t, v) ON CONFLICT DO NOTHING',
            [ban.id, sid, add.map((i) => i.type), add.map((i) => i.value)],
          );
          // Bumping updated_at makes the next delta sync deliver the extended identifier list.
          await tx.query('UPDATE bans SET updated_at = now() WHERE id = $1', [ban.id]);
          await audit(tx, { type: 'system', label: 'anticheat:ban-evasion' }, {
            serverId: sid, action: 'ban.identifiers_extended', targetType: 'ban', targetId: ban.id, details: { added: add.map(formatIdentifier) },
          });
        }
        await tx.query(
          "INSERT INTO system_events (server_id, type, severity, message, data) VALUES ($1, 'banned_connect', 'LOW', $2, $3)",
          [sid, `Bannolt játékos csatlakozási kísérlete: ${body.name}`, JSON.stringify({ banId: ban.id, code: ban.public_code })],
        );
      }
      const linked = await findLinkedAdmin(tx, sid, ids);
      const wl = await playerWhitelist(tx, sid, ids);
      return {
        playerId,
        ban: ban ? { id: ban.id, code: ban.public_code, reason: ban.reason, expiresAt: ban.expires_at } : null,
        whitelist: wl.map((w) => ({ id: w.id, modules: w.modules, expiresAt: w.expires_at })),
        admin: linked ? { role: linked.roleKey, roleName: linked.roleName, level: linked.level, permissions: linked.permissions, username: linked.username } : null,
      };
    });
  });

  app.post('/players/joined', async (req) => {
    const body = parse(z.object({ netId: z.number().int().min(0).max(65535), name: z.string().max(64), identifiers }), req.body);
    const sid = req.game!.serverId;
    await withTx(app.db, async (tx) => {
      const { playerId } = await resolvePlayer(tx, sid, normaliseIdentifiers(body.identifiers), body.name, { create: true, touch: true });
      if (playerId) await openSession(tx, sid, playerId, body.netId, body.name);
      await publish(tx, { serverId: sid, type: 'players.changed', data: {} });
    });
    return { ok: true };
  });

  app.post('/players/dropped', async (req) => {
    const body = parse(z.object({ netId: z.number().int().min(0).max(65535), reason: z.string().max(200).default('') }), req.body);
    const sid = req.game!.serverId;
    const r = await app.db.query<{ player_id: string; connected_at: Date }>(
      `UPDATE player_sessions SET disconnected_at = now(), disconnect_reason = $3
        WHERE server_id = $1 AND net_id = $2 AND disconnected_at IS NULL RETURNING player_id, connected_at`,
      [sid, body.netId, body.reason],
    );
    for (const s of r.rows) {
      await app.db.query('UPDATE players SET last_seen = now(), total_playtime_seconds = total_playtime_seconds + $2 WHERE id = $1', [
        s.player_id, Math.max(0, Math.round((Date.now() - s.connected_at.getTime()) / 1000)),
      ]);
    }
    await publish(app.db, { serverId: sid, type: 'players.changed', data: {} });
    return { ok: true };
  });

  app.post('/detections', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({ detections: z.array(detectionInput).min(1).max(100) }), req.body);
    return ingestDetections(app, req.game!.serverId, body.detections);
  });

  app.get('/bans/sync', async (req) => {
    const q = parse(z.object({ since: z.coerce.date().optional() }), req.query);
    const sid = req.game!.serverId;
    const now = new Date();
    const types = (await app.db.query<{ ban_match_types: string[] }>('SELECT ban_match_types FROM servers WHERE id = $1', [sid])).rows[0]!.ban_match_types;
    const active = (
      await app.db.query<BanRow>(
        `SELECT ${BAN_COLUMNS} FROM bans b WHERE b.server_id = $1 AND b.status = 'active' AND (b.expires_at IS NULL OR b.expires_at > now())
           AND ($2::timestamptz IS NULL OR b.updated_at > $2)
         ORDER BY b.created_at LIMIT 20000`,
        [sid, q.since ?? null],
      )
    ).rows;
    const ids = await banIdentifiers(app.db, active.map((b) => b.id));
    const inactive = q.since
      ? (
          await app.db.query<{ id: string }>(
            `SELECT id FROM bans WHERE server_id = $1 AND updated_at > $2
               AND (status <> 'active' OR (expires_at IS NOT NULL AND expires_at <= now()))`,
            [sid, q.since],
          )
        ).rows.map((r) => r.id)
      : [];
    return {
      now: now.toISOString(),
      full: !q.since,
      matchTypes: types,
      bans: active.map((b) => presentBanForGame(b, (ids.get(b.id) ?? []).filter((i) => types.includes(i.slice(0, i.indexOf(':')))))),
      inactive,
    };
  });

  app.post('/bans', async (req) => {
    const body = parse(
      z.object({
        localId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
        identifiers,
        playerName: z.string().max(64).default(''),
        reason: z.string().trim().min(3).max(500),
        durationSeconds: z.number().int().min(60).max(MAX_TEMP_BAN_SECONDS).nullable(),
        actor: actorSchema.optional(),
        detectionLocalIds: z.array(z.string().max(64)).max(50).default([]),
        // Seconds the ban waited in the game server's offline queue (relative, so clock skew is irrelevant).
        ageSeconds: z.number().int().min(0).max(30 * 86400).default(0),
      }),
      req.body,
    );
    const sid = req.game!.serverId;
    const actor = await gameActor(app, req, body.actor, body.durationSeconds === null ? 'bans.permanent' : 'bans.create');
    const detectionIds = body.detectionLocalIds.length
      ? (await app.db.query<{ id: string }>('SELECT id FROM detections WHERE server_id = $1 AND local_id = ANY($2::text[])', [sid, body.detectionLocalIds])).rows.map((r) => r.id)
      : [];
    // Bans created while the backend was unreachable keep their original start time for the duration.
    const start = Date.now() - body.ageSeconds * 1000;
    const expiresAt = body.durationSeconds === null ? null : new Date(start + body.durationSeconds * 1000);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return { ban: null, expiredBeforeSync: true };
    }
    const ban = await createBan(app.db, {
      serverId: sid,
      identifiers: normaliseIdentifiers(body.identifiers),
      playerName: body.playerName,
      reason: body.reason,
      expiresAt,
      source: body.actor ? 'ingame' : 'system',
      actor,
      detectionIds,
      localId: body.localId,
    });
    await linkReplaysToBan(app.db, sid, body.localId, ban.id);
    return { ban: presentBanForGame(ban, ban.identifiers ?? []), created: ban.created };
  });

  app.post('/bans/:banId/revoke', async (req) => {
    const { banId } = parse(z.object({ banId: z.uuid() }), req.params);
    const body = parse(z.object({ reason: z.string().trim().min(3).max(500), actor: actorSchema }), req.body);
    const actor = await gameActor(app, req, body.actor, 'bans.remove');
    const ban = await revokeBan(app.db, req.game!.serverId, banId, body.reason, actor, { notifyGame: false });
    return { ban: { id: ban.id, status: ban.status } };
  });

  app.get('/config', async (req) => {
    const sid = req.game!.serverId;
    const cfg = await getConfig(app, sid);
    const server = (await app.db.query<{ ban_match_types: string[] }>('SELECT ban_match_types FROM servers WHERE id = $1', [sid])).rows[0]!;
    return { version: cfg.version, overrides: cfg.overrides, whitelist: await activeWhitelist(app.db, sid), banMatchTypes: server.ban_match_types };
  });

  app.get('/commands', async (req) => {
    const rows = await takePendingCommands(app.db, req.game!.serverId);
    return { commands: rows.map((r) => ({ id: r.id, type: r.type, payload: r.payload })) };
  });

  app.post('/commands/:id/ack', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ status: z.enum(['done', 'failed']), result: z.string().max(500).default('') }), req.body);
    const r = await app.db.query(
      "UPDATE server_commands SET status = $3, result = $4, completed_at = now() WHERE id = $1 AND server_id = $2 AND status IN ('pending','delivered')",
      [id, req.game!.serverId, body.status, body.result],
    );
    return { ok: (r.rowCount ?? 0) > 0 };
  });

  app.post('/system-events', async (req) => {
    const body = parse(
      z.object({
        events: z.array(z.object({
          type: z.string().regex(/^[a-z_]{2,40}$/),
          severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
          message: z.string().max(500),
          data: z.preprocess(emptyArrayAsObject, z.record(z.string(), z.unknown())).refine((d) => JSON.stringify(d).length < 4000).default({}),
        })).min(1).max(50),
      }),
      req.body,
    );
    for (const e of body.events) {
      await app.db.query('INSERT INTO system_events (server_id, type, severity, message, data) VALUES ($1,$2,$3,$4,$5)', [req.game!.serverId, e.type, e.severity, e.message, JSON.stringify(e.data)]);
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------- POV replays
  // The client records its own game view; the game server collects the segments (it knows which
  // player sent them) and forwards them here. Nothing on this path is reachable by the client.
  app.post('/replays', async (req) => {
    const body = parse(
      z.object({
        id: z.uuid(),
        kind: z.enum(['ban', 'manual']),
        playerName: z.string().max(64).default(''),
        identifiers,
        reason: z.string().max(500).default(''),
        banId: z.uuid().optional(),
        banLocalId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
        requestedBy: actorSchema.optional(),
        width: z.number().int().min(16).max(4096).optional(),
        height: z.number().int().min(16).max(4096).optional(),
        fps: z.number().int().min(1).max(60).optional(),
      }),
      req.body,
    );
    const sid = req.game!.serverId;
    const actor = await gameActor(app, req, body.requestedBy, body.kind === 'manual' ? 'replays.request' : null);
    const { playerId } = await resolvePlayer(app.db, sid, normaliseIdentifiers(body.identifiers), body.playerName, { create: false, touch: false });
    let banId = body.banId ?? null;
    if (banId && !(await app.db.query('SELECT 1 FROM bans WHERE id = $1 AND server_id = $2', [banId, sid])).rowCount) banId = null;
    if (!banId && body.banLocalId) {
      banId = (await app.db.query<{ id: string }>('SELECT id FROM bans WHERE server_id = $1 AND local_id = $2', [sid, body.banLocalId])).rows[0]?.id ?? null;
    }
    const existing = (await app.db.query<{ server_id: string; status: string }>('SELECT server_id, status FROM replays WHERE id = $1', [body.id])).rows[0];
    if (existing) {
      // A replay the web dashboard requested (or a retry of this call).
      if (existing.server_id !== sid) throw notFound('Replay not found');
      if (existing.status !== 'requested' && existing.status !== 'uploading') throw conflict(`Replay is already ${existing.status}`);
      await app.db.query(
        `UPDATE replays SET status = 'uploading', player_id = COALESCE(player_id, $2), player_name = CASE WHEN player_name = '' THEN $3 ELSE player_name END,
                ban_id = COALESCE(ban_id, $4), ban_local_id = COALESCE(ban_local_id, $5), width = $6, height = $7, fps = $8 WHERE id = $1`,
        [body.id, playerId, body.playerName, banId, body.banLocalId ?? null, body.width ?? null, body.height ?? null, body.fps ?? null],
      );
    } else {
      await app.db.query(
        `INSERT INTO replays (id, server_id, player_id, player_name, kind, status, reason, ban_id, ban_local_id, requested_by, requested_by_label, width, height, fps)
         VALUES ($1, $2, $3, $4, $5, 'uploading', $6, $7, $8, $9, $10, $11, $12, $13)`,
        [body.id, sid, playerId, body.playerName, body.kind, body.reason, banId, body.banLocalId ?? null, actor.userId ?? null,
          body.kind === 'ban' ? 'anticheat:ban' : actor.label, body.width ?? null, body.height ?? null, body.fps ?? null],
      );
      if (body.kind === 'manual') {
        await audit(app.db, actor, { serverId: sid, action: 'replay.request', targetType: 'replay', targetId: body.id, details: { player: body.playerName, reason: body.reason } });
      }
    }
    return { ok: true, id: body.id };
  });

  app.put('/replays/:id/parts/:idx', { bodyLimit: Math.ceil(REPLAY_MAX_PART_BYTES * 1.4) + 4096 }, async (req) => {
    const { id, idx } = parse(z.object({ id: z.uuid(), idx: z.coerce.number().int().min(0).max(REPLAY_MAX_PARTS - 1) }), req.params);
    const body = parse(
      z.object({
        durationMs: z.number().int().min(0).max(120_000),
        data: z.string().min(8).max(Math.ceil(REPLAY_MAX_PART_BYTES * 1.4)).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'data must be base64'),
      }),
      req.body,
    );
    const sid = req.game!.serverId;
    await assertUploadable(app.db, sid, id);
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length > REPLAY_MAX_PART_BYTES) throw unprocessable('Replay part too large');
    // Every part is a complete WebM file: it must start with the EBML magic.
    if (bytes.readUInt32BE(0) !== 0x1a45dfa3) throw unprocessable('Replay part is not a WebM file');
    const current = Number((await app.db.query<{ n: string }>('SELECT COALESCE(sum(size_bytes), 0) AS n FROM replay_parts WHERE replay_id = $1 AND idx <> $2', [id, idx])).rows[0]!.n);
    if (current + bytes.length > REPLAY_MAX_TOTAL_BYTES) throw unprocessable('Replay too large');
    await ensureStorage(app.db, sid, bytes.length, app.cfg.REPLAY_STORAGE_LIMIT_MB * 1024 * 1024, id);
    await app.db.query(
      `INSERT INTO replay_parts (replay_id, idx, duration_ms, size_bytes, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (replay_id, idx) DO UPDATE SET duration_ms = EXCLUDED.duration_ms, size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data`,
      [id, idx, body.durationMs, bytes.length, bytes],
    );
    return { ok: true, bytes: bytes.length };
  });

  app.post('/replays/:id/complete', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ status: z.enum(['ready', 'failed']), error: z.string().max(300).optional() }), req.body);
    const sid = req.game!.serverId;
    await assertUploadable(app.db, sid, id);
    const parts = await replayParts(app.db, id);
    const ready = body.status === 'ready' && parts.length > 0;
    const error = ready ? null : (body.error ?? (parts.length ? 'upload failed' : 'no video received'));
    await app.db.query(
      `UPDATE replays SET status = $2, error = $3, completed_at = now(), part_count = $4,
              duration_ms = $5, size_bytes = $6 WHERE id = $1`,
      [id, ready ? 'ready' : 'failed', error, parts.length, parts.reduce((s, p) => s + p.duration_ms, 0), parts.reduce((s, p) => s + p.size_bytes, 0)],
    );
    if (!ready) await app.db.query('DELETE FROM replay_parts WHERE replay_id = $1', [id]);
    await publish(app.db, { serverId: sid, type: 'replay.updated', data: { id, status: ready ? 'ready' : 'failed' } });
    return { ok: true, status: ready ? 'ready' : 'failed' };
  });

    // ---------------------------------------------------------------- data for the in-game admin panel
  // The game server checks the admin's permission before calling these; actions are audited with the admin as actor.
  app.get('/admin/stats', async (req) => dashboardStats(app, req.game!.serverId));

  app.get('/admin/detections', async (req) => listDetections(app.db, req.game!.serverId, parse(detectionListQuery, req.query)));

  app.post('/admin/detections/:id/review', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ status: z.enum(['confirmed', 'false_positive', 'dismissed', 'pending']), note: z.string().trim().min(3).max(1000), actor: actorSchema }), req.body);
    const actor = await gameActor(app, req, body.actor, 'detections.review');
    const row = await reviewDetection(app.db, req.game!.serverId, id, body.status, body.note, actor);
    await publish(app.db, { serverId: req.game!.serverId, type: 'detection.reviewed', data: { id, status: body.status } });
    return { detection: row };
  });

  app.get('/admin/bans', async (req) => {
    const q = parse(
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        status: z.enum(['active', 'expired', 'revoked', 'all']).default('active'),
        q: z.string().max(100).optional(),
      }),
      req.query,
    );
    const sid = req.game!.serverId;
    const params: unknown[] = [sid];
    let where = 'b.server_id = $1';
    if (q.status === 'active') where += " AND b.status = 'active' AND (b.expires_at IS NULL OR b.expires_at > now())";
    if (q.status === 'expired') where += " AND (b.status = 'expired' OR (b.status = 'active' AND b.expires_at <= now()))";
    if (q.status === 'revoked') where += " AND b.status = 'revoked'";
    if (q.q) {
      params.push(`%${q.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where += ` AND (lower(b.player_name) LIKE $2 OR lower(b.public_code) LIKE $2 OR lower(b.reason) LIKE $2)`;
    }
    const total = (await app.db.query<{ n: number }>(`SELECT count(*) AS n FROM bans b WHERE ${where}`, params)).rows[0]!.n;
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const items = (await app.db.query<BanRow>(`SELECT ${BAN_COLUMNS} FROM bans b WHERE ${where} ORDER BY b.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
    const ids = await banIdentifiers(app.db, items.map((b) => b.id));
    return { items: items.map((b) => ({ ...b, identifiers: ids.get(b.id) ?? [] })), total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/admin/players/lookup', async (req) => {
    const body = parse(z.object({ identifiers }), req.body);
    const sid = req.game!.serverId;
    const ids = normaliseIdentifiers(body.identifiers);
    const { playerId } = await resolvePlayer(app.db, sid, ids, '', { create: false, touch: false });
    if (!playerId) throw notFound('Player not found');
    const player = (await app.db.query('SELECT id, last_name, first_seen, last_seen, notes, total_playtime_seconds FROM players WHERE id = $1', [playerId])).rows[0];
    const detections = (await app.db.query<DetectionRow>(`SELECT ${DETECTION_COLUMNS} FROM detections WHERE player_id = $1 ORDER BY occurred_at DESC LIMIT 50`, [playerId])).rows;
    const bans = (await app.db.query(`SELECT ${BAN_COLUMNS} FROM bans b WHERE b.player_id = $1 ORDER BY b.created_at DESC LIMIT 25`, [playerId])).rows;
    const sessions = (await app.db.query('SELECT net_id, name, connected_at, disconnected_at, disconnect_reason FROM player_sessions WHERE player_id = $1 ORDER BY connected_at DESC LIMIT 10', [playerId])).rows;
    return { player, detections, bans, sessions };
  });

  app.get('/admin/audit', async (req) => listAudit(app, req.game!.serverId, parse(auditQuery, req.query)));

  // In-game admin actions that have no dedicated endpoint (kick, monitor) are audited here.
  app.post('/admin/audit', async (req) => {
    const body = parse(
      z.object({
        action: z.enum(['player.kick', 'player.monitor', 'panel.open', 'player.freeze', 'player.unfreeze', 'player.goto', 'player.bring', 'player.spectate', 'player.message']),
        details: z.preprocess(emptyArrayAsObject, z.record(z.string(), z.unknown())).refine((d) => JSON.stringify(d).length < 4000).default({}),
        actor: actorSchema,
      }),
      req.body,
    );
    const perm: Record<string, Permission | null> = {
      'player.kick': 'players.kick', 'player.monitor': 'detections.review', 'panel.open': null,
      'player.freeze': 'players.moderate', 'player.unfreeze': 'players.moderate', 'player.goto': 'players.moderate',
      'player.bring': 'players.moderate', 'player.spectate': 'players.moderate', 'player.message': 'players.moderate',
    };
    const actor = await gameActor(app, req, body.actor, perm[body.action] ?? null);
    await audit(app.db, actor, { serverId: req.game!.serverId, action: `ingame.${body.action}`, targetType: 'player', details: body.details });
    return { ok: true };
  });

  app.get('/admin/whitelist', async (req) => ({ items: await activeWhitelist(app.db, req.game!.serverId) }));

  app.post('/admin/whitelist', async (req) => {
    const body = parse(z.object({ entry: z.unknown(), actor: actorSchema }), req.body);
    const actor = await gameActor(app, req, body.actor, 'whitelist.manage');
    return { entry: await addWhitelist(app, req.game!.serverId, body.entry, actor) };
  });

  app.post('/admin/whitelist/:id/delete', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ actor: actorSchema }), req.body);
    const actor = await gameActor(app, req, body.actor, 'whitelist.manage');
    await removeWhitelist(app, req.game!.serverId, id, actor);
    return { ok: true };
  });

  app.get('/admin/members', async (req) => {
    const rows = (
      await app.db.query(
        `SELECT u.username, r.name AS role_name, r.level, u.last_login_at,
                COALESCE((SELECT array_agg(ui.type || ':' || ui.value) FROM user_identifiers ui WHERE ui.user_id = u.id), '{}') AS identifiers
           FROM server_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
          WHERE m.server_id = $1 ORDER BY r.level DESC, u.username`,
        [req.game!.serverId],
      )
    ).rows;
    return { items: rows };
  });

  app.get('/admin/config', async (req) => {
    const cfg = await getConfig(app, req.game!.serverId);
    return { version: cfg.version, overrides: cfg.overrides, schema: cfg.schema };
  });

  app.put('/admin/config', async (req) => {
    const body = parse(z.object({ overrides: z.unknown(), expectedVersion: z.number().int().min(0), note: z.string().trim().min(3).max(500), actor: actorSchema }), req.body);
    const actor = await gameActor(app, req, body.actor, 'settings.manage');
    return saveConfig(app, req.game!.serverId, body.overrides, body.expectedVersion, body.note, actor);
  });

  app.get('/admin/replays', async (req) => {
    const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }), req.query);
    const sid = req.game!.serverId;
    const total = (await app.db.query<{ n: number }>('SELECT count(*)::int AS n FROM replays WHERE server_id = $1', [sid])).rows[0]!.n;
    const items = (
      await app.db.query<ReplayRow>(`SELECT ${REPLAY_COLUMNS} FROM replays r WHERE r.server_id = $1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [sid, q.pageSize, (q.page - 1) * q.pageSize])
    ).rows;
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/admin/replays/:id', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const replay = await getReplay(app.db, req.game!.serverId, id);
    return { replay, parts: await replayParts(app.db, id) };
  });

  // Base64 so the game server can relay it to the in-game panel without binary handling in Lua.
  app.get('/admin/replays/:id/parts/:idx', async (req) => {
    const { id, idx } = parse(z.object({ id: z.uuid(), idx: z.coerce.number().int().min(0).max(REPLAY_MAX_PARTS - 1) }), req.params);
    const replay = await getReplay(app.db, req.game!.serverId, id);
    const part = (await app.db.query<{ data: Buffer; duration_ms: number }>('SELECT data, duration_ms FROM replay_parts WHERE replay_id = $1 AND idx = $2', [id, idx])).rows[0];
    if (!part) throw notFound('Replay part not found');
    return { mime: replay.mime, durationMs: part.duration_ms, data: part.data.toString('base64') };
  });

  app.post('/admin/replays/:id/viewed', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ actor: actorSchema }), req.body);
    const actor = await gameActor(app, req, body.actor, 'replays.view');
    const replay = await getReplay(app.db, req.game!.serverId, id);
    await audit(app.db, actor, { serverId: req.game!.serverId, action: 'replay.view', targetType: 'replay', targetId: id, details: { player: replay.player_name } });
    return { ok: true };
  });

  app.get('/admin/system-events', async (req) => {
    const rows = (await app.db.query('SELECT type, severity, message, created_at FROM system_events WHERE server_id = $1 ORDER BY created_at DESC LIMIT 30', [req.game!.serverId])).rows;
    return { items: rows };
  });
}
