import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { isDiscordWebhookUrl, sendDiscordAlert, SEVERITY_ORDER } from '../lib/discord.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

export default async function integrationRoutes(app: FastifyInstance) {
  app.get('/servers/:serverId/integrations', { preHandler: app.requireServer('integrations.manage') }, async (req) => {
    const row = (
      await app.db.query<{ discord_webhook_enc: string | null; discord_enabled: boolean; discord_min_severity: string; updated_at: Date }>(
        'SELECT discord_webhook_enc, discord_enabled, discord_min_severity, updated_at FROM server_integrations WHERE server_id = $1',
        [req.access!.serverId],
      )
    ).rows[0];
    let hint: string | null = null;
    if (row?.discord_webhook_enc) {
      try {
        const url = app.enc.decrypt(row.discord_webhook_enc);
        hint = `…${url.slice(-4)}`;
      } catch {
        hint = '(nem visszafejthető – add meg újra)';
      }
    }
    // The webhook URL itself is a secret and never leaves the backend.
    return {
      discord: { enabled: row?.discord_enabled ?? false, minSeverity: row?.discord_min_severity ?? 'HIGH', configured: !!row?.discord_webhook_enc, hint },
      updatedAt: row?.updated_at ?? null,
    };
  });

  app.put('/servers/:serverId/integrations/discord', { preHandler: app.requireServer('integrations.manage') }, async (req) => {
    const body = parse(
      z.object({ enabled: z.boolean(), minSeverity: z.enum(SEVERITY_ORDER), webhookUrl: z.string().max(300).nullable().optional() }),
      req.body,
    );
    if (body.webhookUrl && !isDiscordWebhookUrl(body.webhookUrl)) throw badRequest('Not a Discord webhook URL');
    const sid = req.access!.serverId;
    const sets = ['discord_enabled = $2', 'discord_min_severity = $3', 'updated_by = $4', 'updated_at = now()'];
    const params: unknown[] = [sid, body.enabled, body.minSeverity, req.user!.userId];
    if (body.webhookUrl !== undefined) {
      params.push(body.webhookUrl ? app.enc.encrypt(body.webhookUrl) : null);
      sets.push(`discord_webhook_enc = $${params.length}`);
    }
    await app.db.query(
      `INSERT INTO server_integrations (server_id) VALUES ($1) ON CONFLICT (server_id) DO NOTHING`, [sid],
    );
    await app.db.query(`UPDATE server_integrations SET ${sets.join(', ')} WHERE server_id = $1`, params);
    await audit(app.db, req.actor(), {
      serverId: sid, action: 'integration.discord_update',
      details: { enabled: body.enabled, minSeverity: body.minSeverity, webhookChanged: body.webhookUrl !== undefined },
    });
    return { ok: true };
  });

  app.post('/servers/:serverId/integrations/discord/test', { preHandler: app.requireServer('integrations.manage'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const sent = await sendDiscordAlert(
      app.db, app.enc, req.access!.serverId,
      { title: 'MilcsoGuard teszt riasztás', severity: 'CRITICAL', fields: [{ name: 'Kérte', value: req.user!.username }] },
      (m) => req.log.warn(m), app.fetchImpl,
    );
    return { sent };
  });
}
