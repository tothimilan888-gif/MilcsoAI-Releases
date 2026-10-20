import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useServer } from '../lib/server';
import { fmtDate, fmtDuration, fmtRelative } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Badge, Empty, ErrorState, Loading, SeverityBadge } from '../components/ui';

interface SystemInfo {
  game: { online: boolean; lastHeartbeatAt: string | null; resourceVersion?: string; artifact?: string; framework?: string; onesync?: string; dependencies?: Record<string, string>; resources?: { name: string; state: string }[]; stats?: Record<string, unknown>; playerCount?: number; queueSize?: number; uptimeSeconds?: number; configVersionApplied?: number };
  backend: { version: string; uptimeSeconds: number; dbLatencyMs: number; realtimeSubscribers: number };
  commands: { pending: number; delivered: number };
  apiKeys: { n: number; last_used: string | null };
  config: { version: number; updated_at: string; has_schema: boolean };
}

export function SystemPage() {
  const server = useServer();
  const q = useQuery({ queryKey: ['system', server.id], queryFn: () => api<SystemInfo>('GET', `/servers/${server.id}/system`), refetchInterval: 30_000 });
  const ev = useQuery({ queryKey: ['system', server.id, 'events'], queryFn: () => api<{ items: { id: number; type: string; severity: string; message: string; created_at: string }[] }>('GET', `/servers/${server.id}/system/events?limit=50`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const s = q.data!;
  const g = s.game;
  const stale = g.configVersionApplied !== undefined && g.configVersionApplied !== s.config.version;
  return (
    <>
      <PageHeader title="Rendszerállapot" />
      <div className="grid two">
        <section className="card">
          <h2>Játékszerver</h2>
          <dl className="kv">
            <dt>Állapot</dt><dd>{g.online ? <Badge tone="ok">online</Badge> : <Badge tone="danger">offline</Badge>} <span className="muted">utolsó heartbeat: {fmtRelative(g.lastHeartbeatAt)}</span></dd>
            <dt>Resource verzió</dt><dd>{g.resourceVersion ?? '–'}</dd>
            <dt>Artifact</dt><dd className="small">{g.artifact || '–'}</dd>
            <dt>Framework</dt><dd>{g.framework ?? '–'}</dd>
            <dt>OneSync</dt><dd>{g.onesync ?? '–'} {g.onesync === 'off' && <Badge tone="danger">a szerveroldali ellenőrzések inaktívak</Badge>}</dd>
            <dt>Függőségek</dt><dd>{g.dependencies && Object.keys(g.dependencies).length ? Object.entries(g.dependencies).map(([k, v]) => <div key={k} className="small">{k}: {v}</div>) : '–'}</dd>
            <dt>Online játékos</dt><dd>{g.playerCount ?? 0}</dd>
            <dt>Kimenő sor (szerveren)</dt><dd>{g.queueSize ?? 0} {(g.queueSize ?? 0) > 100 && <Badge tone="warn">torlódik</Badge>}</dd>
            <dt>Uptime</dt><dd>{g.uptimeSeconds ? fmtDuration(g.uptimeSeconds) : '–'}</dd>
            <dt>Konfiguráció</dt><dd>backend v{s.config.version}, szerver v{g.configVersionApplied ?? '?'} {stale && <Badge tone="warn">nem alkalmazott / elutasított</Badge>}</dd>
          </dl>
          {g.resources?.length ? (
            <><h3>Felügyelt resource-ok</h3><ul className="plain">{g.resources.map((r) => <li key={r.name}>{r.state === 'started' ? <Badge tone="ok">fut</Badge> : <Badge tone="danger">{r.state}</Badge>} {r.name}</li>)}</ul></>
          ) : null}
        </section>
        <section className="card">
          <h2>Backend</h2>
          <dl className="kv">
            <dt>Verzió</dt><dd>{s.backend.version}</dd>
            <dt>Uptime</dt><dd>{fmtDuration(s.backend.uptimeSeconds)}</dd>
            <dt>Adatbázis késleltetés</dt><dd>{s.backend.dbLatencyMs} ms</dd>
            <dt>Valós idejű kliensek</dt><dd>{s.backend.realtimeSubscribers}</dd>
            <dt>Parancssor</dt><dd>{s.commands.pending} függő, {s.commands.delivered} kézbesített</dd>
            <dt>Aktív API-kulcsok</dt><dd>{s.apiKeys.n} <span className="muted">utoljára használva: {fmtRelative(s.apiKeys.last_used)}</span></dd>
            <dt>Beállítás-séma</dt><dd>{s.config.has_schema ? <Badge tone="ok">megérkezett</Badge> : <Badge tone="warn">még nem jelentkezett be a resource</Badge>}</dd>
          </dl>
        </section>
      </div>
      <section className="card">
        <h2>Rendszeresemények</h2>
        {ev.isLoading ? <Loading /> : ev.error ? <ErrorState error={ev.error} /> : ev.data!.items.length === 0 ? <Empty title="Nincs esemény" /> : (
          <ul className="feed">{ev.data!.items.map((e) => <li key={e.id}><SeverityBadge s={e.severity} /><div className="feed-main"><div className="feed-title">{e.message}</div><div className="muted small">{e.type}</div></div><span className="muted small">{fmtDate(e.created_at)}</span></li>)}</ul>
        )}
      </section>
    </>
  );
}
