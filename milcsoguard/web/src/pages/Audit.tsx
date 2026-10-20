import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { useServer } from '../lib/server';
import { fmtDate } from '../lib/format';
import type { AuditEntry, Page } from '../lib/types';
import { PageHeader } from '../components/Layout';
import { Empty, ErrorState, JsonView, Loading, Pagination } from '../components/ui';

const ACTOR: Record<string, string> = { user: 'Web', game_admin: 'Játékon belül', system: 'Rendszer', api_key: 'API-kulcs' };

export function AuditPage() {
  const server = useServer();
  const [f, setF] = useState({ page: 1, action: '', actor: '', actorType: '', from: '', to: '' });
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['audit', server.id, f],
    queryFn: () => api<Page<AuditEntry>>('GET', `/servers/${server.id}/audit${qs({ ...f, from: f.from ? new Date(f.from).toISOString() : '', to: f.to ? new Date(f.to).toISOString() : '', pageSize: 50 })}`),
    placeholderData: (p) => p,
  });
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, page: 1, ...patch }));
  return (
    <>
      <PageHeader title="Auditnapló" subtitle="Változtathatatlan napló minden adminműveletről (web, játékon belüli, automatikus). Nincs törlő vagy módosító végpont." />
      <div className="filters">
        <input placeholder="Művelet előtag (pl. ban.)" value={f.action} onChange={(e) => set({ action: e.target.value })} aria-label="Művelet" />
        <input placeholder="Végrehajtó" value={f.actor} onChange={(e) => set({ actor: e.target.value })} aria-label="Végrehajtó" />
        <select value={f.actorType} onChange={(e) => set({ actorType: e.target.value })} aria-label="Végrehajtó típusa"><option value="">Minden forrás</option>{Object.entries(ACTOR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <label className="inline">Tól <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="inline">Ig <input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></label>
      </div>
      <section className="card flush">
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : q.data!.items.length === 0 ? <Empty title="Nincs bejegyzés" /> : (
          <>
            <div className="table-wrap"><table>
              <thead><tr><th>Idő</th><th>Végrehajtó</th><th>Forrás</th><th>Művelet</th><th>Cél</th><th>IP</th></tr></thead>
              <tbody>{q.data!.items.map((a) => (
                <Fragment key={a.id}>
                  <tr className="clickable" onClick={() => setOpen(open === a.id ? null : a.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>
                    <td className="small nowrap">{fmtDate(a.created_at)}</td><td>{a.actor_label}</td><td className="small">{ACTOR[a.actor_type]}</td>
                    <td className="mono small">{a.action}</td><td className="small mono">{a.target_type ? `${a.target_type}:${String(a.target_id ?? '').slice(0, 8)}` : '–'}</td><td className="small mono">{a.ip ?? '–'}</td>
                  </tr>
                  {open === a.id && <tr className="detail-row"><td colSpan={6}><JsonView value={a.details} /></td></tr>}
                </Fragment>
              ))}</tbody>
            </table></div>
            <Pagination page={q.data!.page} pageSize={q.data!.pageSize} total={q.data!.total} onPage={(page) => setF({ ...f, page })} />
          </>
        )}
      </section>
    </>
  );
}
