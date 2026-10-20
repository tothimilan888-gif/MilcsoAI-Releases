const dtf = new Intl.DateTimeFormat('hu-HU', { dateStyle: 'short', timeStyle: 'medium' });
export const fmtDate = (iso: string | null | undefined) => (iso ? dtf.format(new Date(iso)) : '–');

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '–';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return `${fmtDuration(-s)} múlva`;
  if (s < 60) return 'épp most';
  return `${fmtDuration(s)} ezelőtt`;
}

export function fmtDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} nap${h ? ` ${h} óra` : ''}`;
  if (h > 0) return `${h} óra${m ? ` ${m} perc` : ''}`;
  return `${Math.max(1, m)} perc`;
}

export const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.0', '')}K` : String(n));

export const ACTION_LABEL: Record<string, string> = { log: 'Napló', warn: 'Figyelmeztetés', monitor: 'Megfigyelés', kick: 'Kick', ban: 'Ban' };
export const REVIEW_LABEL: Record<string, string> = { pending: 'Függő', confirmed: 'Megerősítve', false_positive: 'Téves riasztás', dismissed: 'Elvetve' };
export const SOURCE_LABEL: Record<string, string> = { server: 'Szerver', client: 'Kliens', event: 'Event', resource: 'Resource', system: 'Rendszer' };
export const BAN_STATUS: Record<string, string> = { active: 'Aktív', expired: 'Lejárt', revoked: 'Feloldva' };

export const BAN_DURATIONS: { label: string; seconds: number | null }[] = [
  { label: '1 óra', seconds: 3600 },
  { label: '1 nap', seconds: 86400 },
  { label: '3 nap', seconds: 3 * 86400 },
  { label: '7 nap', seconds: 7 * 86400 },
  { label: '30 nap', seconds: 30 * 86400 },
  { label: '90 nap', seconds: 90 * 86400 },
  { label: 'Végleges', seconds: null },
];
