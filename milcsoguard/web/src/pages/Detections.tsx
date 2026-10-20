import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useCan, useServer } from '../lib/server';
import { ACTION_LABEL, fmtDate, REVIEW_LABEL, SOURCE_LABEL } from '../lib/format';
import { SEVERITIES, type Detection, type Page } from '../lib/types';
import { useToast } from '../lib/toast';
import { PageHeader } from '../components/Layout';
import { Badge, ConfirmReason, Empty, ErrorState, JsonView, Loading, Modal, Pagination, SeverityBadge } from '../components/ui';

export function DetectionDetail({ d, onClose }: { d: Detection; onClose: () => void }) {
  const server = useServer();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'confirmed' | 'false_positive' | 'dismissed' | 'pending' | null>(null);
  const review = useMutation({
    mutationFn: (v: { status: string; note: string }) => api('POST', `/servers/${server.id}/detections/${d.id}/review`, v),
    onSuccess: () => {
      toast('Felülvizsgálat mentve', 'success');
      void qc.invalidateQueries({ queryKey: ['detections', server.id] });
      void qc.invalidateQueries({ queryKey: ['player', server.id] });
      onClose();
    },
  });
  return (
    <Modal title={d.type} onClose={onClose} wide footer={can('detections.review') ? (
      <>
        <button className="btn" onClick={() => setStatus('dismissed')}>Elvetés</button>
        <button className="btn" onClick={() => setStatus('false_positive')}>Téves riasztás</button>
        <button className="btn primary" onClick={() => setStatus('confirmed')}>Megerősítés</button>
      </>
    ) : undefined}>
      <dl className="kv">
        <dt>Játékos</dt><dd>{d.player_id ? <Link to={`/s/${server.id}/players/${d.player_id}`} onClick={onClose}>{d.player_name}</Link> : d.player_name} {d.net_id !== null && <span className="muted">#{d.net_id}</span>}</dd>
        <dt>Idő</dt><dd>{fmtDate(d.occurred_at)}</dd>
        <dt>Súlyosság</dt><dd><SeverityBadge s={d.severity} /> <span className="muted">kockázat {d.risk_score}</span></dd>
        <dt>Forrás</dt><dd>{SOURCE_LABEL[d.source] ?? d.source}{d.source === 'client' && <span className="muted small"> – kliensoldali jel, önmagában nem megbízható</span>}</dd>
        <dt>Intézkedés</dt><dd>{ACTION_LABEL[d.action] ?? d.action} {d.action_result && <span className="muted">({d.action_result})</span>}</dd>
        <dt>Azonosítók</dt><dd className="mono small">{d.identifiers.join(', ') || '–'}</dd>
        <dt>Felülvizsgálat</dt><dd>{REVIEW_LABEL[d.review_status]}{d.reviewed_by_label && <span className="muted"> – {d.reviewed_by_label}, {fmtDate(d.reviewed_at)}: {d.review_note}</span>}</dd>
      </dl>
      <h3>Bizonyíték</h3>
      <JsonView value={d.evidence} />
      {status && (
        <ConfirmReason
          title={`Felülvizsgálat: ${REVIEW_LABEL[status]}`}
          description="A döntés és az indoklás az auditnaplóba kerül. A téves riasztások a statisztikában külön jelennek meg, így a küszöbök finomhangolhatók."
          onClose={() => setStatus(null)}
          onConfirm={(note) => review.mutateAsync({ status, note })}
        />
      )}
    </Modal>
  );
}

export function DetectionTable({ items, onOpen, showPlayer = true }: { items: Detection[]; onOpen: (d: Detection) => void; showPlayer?: boolean }) {
  const server = useServer();
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Idő</th><th>Súlyosság</th><th>Típus</th>{showPlayer && <th>Játékos</th>}<th>Forrás</th><th>Intézkedés</th><th className="num">Kockázat</th><th>Státusz</th></tr></thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id} className="clickable" onClick={() => onOpen(d)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(d)}>
              <td className="nowrap small">{fmtDate(d.occurred_at)}</td>
              <td><SeverityBadge s={d.severity} /></td>
              <td className="mono small">{d.type}</td>
              {showPlayer && <td>{d.player_id ? <Link to={`/s/${server.id}/players/${d.player_id}`} onClick={(e) => e.stopPropagation()}>{d.player_name || '?'}</Link> : d.player_name}</td>}
              <td>{SOURCE_LABEL[d.source] ?? d.source}</td>
              <td>{ACTION_LABEL[d.action] ?? d.action}</td>
              <td className="num">{d.risk_score}</td>
              <td><Badge tone={d.review_status === 'confirmed' ? 'danger' : d.review_status === 'false_positive' ? 'ok' : 'neutral'}>{REVIEW_LABEL[d.review_status]}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DetectionsPage() {
  const server = useServer();
  const [f, setF] = useState({ page: 1, q: '', severity: '', minSeverity: '', source: '', review: '', type: '' });
  const [open, setOpen] = useState<Detection | null>(null);
  const q = useQuery({
    queryKey: ['detections', server.id, f],
    queryFn: () => api<Page<Detection>>('GET', `/servers/${server.id}/detections${qs({ ...f, pageSize: 25 })}`),
    placeholderData: (prev) => prev,
  });
  const meta = useQuery({ queryKey: ['detections', server.id, 'meta'], queryFn: () => api<{ types: { type: string; n: number }[] }>('GET', `/servers/${server.id}/detections-meta`) });
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, page: 1, ...patch }));
  return (
    <>
      <PageHeader title="Élő detektálások" subtitle="Új detektálások valós időben érkeznek. Kattints egy sorra a bizonyítékért és a felülvizsgálatért." />
      <div className="filters">
        <input type="search" placeholder="Játékos vagy típus…" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Keresés" />
        <select value={f.type} onChange={(e) => set({ type: e.target.value })} aria-label="Típus"><option value="">Minden típus</option>{meta.data?.types.map((t) => <option key={t.type} value={t.type}>{t.type} ({t.n})</option>)}</select>
        <select value={f.minSeverity} onChange={(e) => set({ minSeverity: e.target.value })} aria-label="Minimum súlyosság"><option value="">Minden súlyosság</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s}+</option>)}</select>
        <select value={f.source} onChange={(e) => set({ source: e.target.value })} aria-label="Forrás"><option value="">Minden forrás</option>{Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select value={f.review} onChange={(e) => set({ review: e.target.value })} aria-label="Felülvizsgálat"><option value="">Minden státusz</option>{Object.entries(REVIEW_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>
      <section className="card flush">
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data!.items.length === 0 ? <Empty title="Nincs detektálás">A szűrésnek megfelelő detektálás nem található.</Empty> : (
          <>
            <DetectionTable items={q.data!.items} onOpen={setOpen} />
            <Pagination page={q.data!.page} pageSize={q.data!.pageSize} total={q.data!.total} onPage={(p) => setF((x) => ({ ...x, page: p }))} />
          </>
        )}
      </section>
      {open && <DetectionDetail d={open} onClose={() => setOpen(null)} />}
    </>
  );
}
