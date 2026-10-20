import type { Db } from '../db/pool.js';
import type { Encryptor } from './crypto.js';

export const SEVERITY_ORDER = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export function severityRank(s: string): number {
  return SEVERITY_ORDER.indexOf(s as Severity);
}

const COLORS: Record<Severity, number> = {
  INFO: 0x64748b,
  LOW: 0x22c55e,
  MEDIUM: 0xeab308,
  HIGH: 0xf97316,
  CRITICAL: 0xef4444,
};

export function isDiscordWebhookUrl(url: string): boolean {
  return /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url);
}

export interface AlertPayload {
  title: string;
  severity: Severity;
  fields: { name: string; value: string; inline?: boolean }[];
}

/**
 * Sends an alert to the server's Discord webhook if enabled and the severity is high enough.
 * Failures are logged and swallowed: alerting must never break ingestion.
 */
export async function sendDiscordAlert(
  db: Db,
  enc: Encryptor,
  serverId: string,
  alert: AlertPayload,
  log: (m: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const row = (
    await db.query<{ discord_webhook_enc: string | null; discord_enabled: boolean; discord_min_severity: string }>(
      'SELECT discord_webhook_enc, discord_enabled, discord_min_severity FROM server_integrations WHERE server_id = $1',
      [serverId],
    )
  ).rows[0];
  if (!row?.discord_enabled || !row.discord_webhook_enc) return false;
  if (severityRank(alert.severity) < severityRank(row.discord_min_severity)) return false;
  let url: string;
  try {
    url = enc.decrypt(row.discord_webhook_enc);
  } catch {
    log('discord webhook could not be decrypted (APP_ENCRYPTION_KEY changed?)');
    return false;
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        username: 'MilcsoGuard',
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: alert.title.slice(0, 250),
            color: COLORS[alert.severity],
            fields: alert.fields.slice(0, 20).map((f) => ({ ...f, name: f.name.slice(0, 250), value: f.value.slice(0, 1000) || '-' })),
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!res.ok) log(`discord webhook responded ${res.status}`);
    return res.ok;
  } catch (err) {
    log(`discord webhook failed: ${(err as Error).message}`);
    return false;
  }
}
