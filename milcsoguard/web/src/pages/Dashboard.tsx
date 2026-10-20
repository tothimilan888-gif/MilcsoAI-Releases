import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useCan, useServer } from '../lib/server';
import { fmtRelative, ACTION_LABEL } from '../lib/format';
import type { Detection, Page } from '../lib/types';
import { PageHeader } from '../components/Layout';
import { Empty, ErrorState, Loading, SeverityBadge, StatTile } from '../components/ui';
import { LineChart } from '../components/charts';

interface Stats { online_players: number; detections_today: number; open_alerts: number; active_bans: number; bans_today: number; known_players: number; server_online: boolean }
export interface Analytics { perDay: { day: string; detections: number; bans: number; false_positives: number }[]; byType: { type: string; n: number; false_positives: number }[]; bySeverity: { severity: string; n: number }[]; bySource: { source: string; n: number }[]; actions: { action: string; n: number }[]; topPlayers: { player_id: string; player_name: string; n: number; max_risk: number }[] }

export function DashboardPage() {
  const server = useServer();
  const can = useCan();
  const stats = useQuery({ queryKey: ['stats', server.id], queryFn: () => api<Stats>('GET', `/servers/${server.id}/stats`), refetchInterval: 60_000 });
  const recent = useQuery({ queryKey: ['detections', server.id, 'dash'], queryFn: () => api<Page<Detection>>('GET', `/servers/${server.id}/detections?pageSize=8&minSeverity=MEDIUM`) });
  const analytics = useQuery({ queryKey: ['analytics', server.id, 14], queryFn: () => api<Analytics>('GET', `/servers/${server.id}/analytics?days=14`), enabled: can('analytics.view') });
  const s = stats.data;
  return (
    <>
      <PageHeader title="Dashboard" subtitle={<>{server.name} · {s ? (s.server_online ? <span className="ok-text">játékszerver online</span> : <span className="warn-text">játékszerver offline / nincs heartbeat</span>) : '…'}</>} />
      {stats.error ? <ErrorState error={stats.error} retry={() => void stats.refetch()} /> : (
        <div className="grid stats">
          <StatTile label="Online játékosok" value={s?.online_players ?? '–'} hint={s && !s.server_online ? 'nincs friss heartbeat' : undefined} />
          <StatTile label="Mai detektálások" value={s?.detections_today ?? '–'} />
          <StatTile label="Nyitott riasztások" value={s?.open_alerts ?? '–'} hint="HIGH+ felülvizsgálatra vár" tone={s && s.open_alerts > 0 ? 'warn' : undefined} />
          <StatTile label="Aktív banok" value={s?.active_bans ?? '–'} hint={s ? `${s.bans_today} ma` : undefined} />
          <StatTile label="Ismert játékosok" value={s?.known_players ?? '–'} />
        </div>
      )}
      <div className="grid two">
        <section className="card">
          <h2>Detektálások – utolsó 14 nap</h2>
          {!can('analytics.view') ? <p className="muted">Nincs analytics.view jogosultságod.</p> : analytics.isLoading ? <Loading /> : analytics.error ? <ErrorState error={analytics.error} /> : (
            <LineChart title="Detektálások, banok és téves riasztások naponta" labels={analytics.data!.perDay.map((d) => d.day)} series={[
              { key: 'd', label: 'Detektálás', values: analytics.data!.perDay.map((d) => d.detections) },
              { key: 'b', label: 'Ban', values: analytics.data!.perDay.map((d) => d.bans) },
              { key: 'f', label: 'Téves', values: analytics.data!.perDay.map((d) => d.false_positives) },
            ]} />
          )}
        </section>
        <section className="card">
          <div className="card-head"><h2>Friss riasztások</h2><Link to={`/s/${server.id}/detections`} className="btn ghost sm">Mind →</Link></div>
          {recent.isLoading ? <Loading /> : recent.error ? <ErrorState error={recent.error} /> : recent.data!.items.length === 0 ? <Empty title="Nincs riasztás">MEDIUM vagy súlyosabb detektálás még nem érkezett.</Empty> : (
            <ul className="feed">
              {recent.data!.items.map((d) => (
                <li key={d.id}>
                  <SeverityBadge s={d.severity} />
                  <div className="feed-main"><div className="feed-title">{d.type}</div><div className="muted small">{d.player_id ? <Link to={`/s/${server.id}/players/${d.player_id}`}>{d.player_name}</Link> : d.player_name} · {fmtRelative(d.occurred_at)}</div></div>
                  <span className="badge neutral">{ACTION_LABEL[d.action] ?? d.action}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
