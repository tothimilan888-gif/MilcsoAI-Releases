import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useServer } from '../lib/server';
import { ACTION_LABEL, SOURCE_LABEL } from '../lib/format';
import { SEVERITIES } from '../lib/types';
import { PageHeader } from '../components/Layout';
import { ErrorState, Loading, SeverityBadge, Tabs } from '../components/ui';
import { BarList, LineChart } from '../components/charts';
import type { Analytics } from './Dashboard';

export function AnalyticsPage() {
  const server = useServer();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const q = useQuery({ queryKey: ['analytics', server.id, Number(days)], queryFn: () => api<Analytics>('GET', `/servers/${server.id}/analytics?days=${days}`) });
  const d = q.data;
  const fpRate = (n: number, fp: number) => (n ? `${Math.round((fp / n) * 100)}% téves` : undefined);
  return (
    <>
      <PageHeader title="Statisztika" subtitle="A téves riasztási arány modulonként mutatja, hol érdemes küszöböt állítani." actions={<Tabs value={days} onChange={setDays} options={[['7', '7 nap'], ['30', '30 nap'], ['90', '90 nap']]} />} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : d && (
        <>
          <section className="card">
            <h2>Napi trend</h2>
            <LineChart title={`Napi detektálások, banok és téves riasztások, utolsó ${days} nap`} labels={d.perDay.map((x) => x.day)} series={[
              { key: 'd', label: 'Detektálás', values: d.perDay.map((x) => x.detections) },
              { key: 'b', label: 'Ban', values: d.perDay.map((x) => x.bans) },
              { key: 'f', label: 'Téves', values: d.perDay.map((x) => x.false_positives) },
            ]} height={280} />
          </section>
          <div className="grid two">
            <section className="card"><h2>Detektálás típusonként</h2><BarList items={d.byType.map((t) => ({ key: t.type, label: <code>{t.type}</code>, value: t.n, sub: fpRate(t.n, t.false_positives) }))} /></section>
            <section className="card"><h2>Súlyosság szerint</h2><BarList items={SEVERITIES.map((s) => ({ key: s, label: <SeverityBadge s={s} />, value: d.bySeverity.find((x) => x.severity === s)?.n ?? 0 }))} /></section>
            <section className="card"><h2>Forrás szerint</h2><BarList items={d.bySource.map((s) => ({ key: s.source, label: SOURCE_LABEL[s.source] ?? s.source, value: s.n }))} /><p className="muted small">A kliensoldali jelek kisebb súllyal számítanak a kockázatba, és önmagukban soha nem bannolnak.</p></section>
            <section className="card"><h2>Intézkedések</h2><BarList items={d.actions.map((a) => ({ key: a.action, label: ACTION_LABEL[a.action] ?? a.action, value: a.n }))} /></section>
          </div>
          <section className="card">
            <h2>Legtöbbet detektált játékosok</h2>
            {d.topPlayers.length === 0 ? <p className="muted">Nincs adat.</p> : (
              <table><thead><tr><th>Játékos</th><th className="num">Detektálás</th><th className="num">Max. kockázat</th></tr></thead>
                <tbody>{d.topPlayers.map((p) => <tr key={p.player_id}><td><Link to={`/s/${server.id}/players/${p.player_id}`}>{p.player_name}</Link></td><td className="num">{p.n}</td><td className="num">{p.max_risk}</td></tr>)}</tbody></table>
            )}
          </section>
        </>
      )}
    </>
  );
}
