import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useCan, useServer } from '../lib/server';
import { BAN_DURATIONS, BAN_STATUS, fmtDate, fmtRelative } from '../lib/format';
import type { Ban, Page } from '../lib/types';
import { useToast } from '../lib/toast';
import { PageHeader } from '../components/Layout';
import { Badge, ConfirmReason, Empty, ErrorState, FieldError, Loading, Modal, Pagination, Tabs } from '../components/ui';

const statusTone = (s: string) => (s === 'active' ? 'danger' : s === 'revoked' ? 'ok' : 'neutral') as 'danger' | 'ok' | 'neutral';
const REVIEW: Record<string, string> = { none: '–', under_review: 'Felülvizsgálat alatt', upheld: 'Fenntartva', overturned: 'Téves ban' };

/** Ban creation: from a player profile (playerId) or by identifiers. Permanent bans need bans.permanent. */
export function BanCreateModal({ playerId, playerName, detectionIds, onClose }: { playerId?: string; playerName?: string; detectionIds?: string[]; onClose: () => void }) {
  const server = useServer();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const [identifiers, setIdentifiers] = useState('');
  const [name, setName] = useState(playerName ?? '');
  const [duration, setDuration] = useState<string>('86400');
  const [reason, setReason] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ ban: Ban }>('POST', `/servers/${server.id}/bans`, {
      playerId, playerName: name, reason: reason.trim(),
      identifiers: playerId ? [] : identifiers.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      durationSeconds: duration === 'permanent' ? null : Number(duration),
      detectionIds: detectionIds ?? [],
    }),
    onSuccess: (r) => {
      toast(`Ban létrehozva (${r.ban.public_code}). Az online játékost a szerver azonnal lecsatlakoztatja.`, 'success');
      void qc.invalidateQueries({ queryKey: ['bans', server.id] });
      void qc.invalidateQueries({ queryKey: ['player', server.id] });
      onClose();
    },
  });
  const durations = BAN_DURATIONS.filter((d) => d.seconds !== null || can('bans.permanent'));
  return (
    <Modal title={playerName ? `Ban: ${playerName}` : 'Új ban'} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Mégse</button>
      <button className="btn danger" disabled={reason.trim().length < 3 || create.isPending || (!playerId && !identifiers.trim())} onClick={() => create.mutate()}>{create.isPending ? 'Mentés…' : 'Ban kiadása'}</button>
    </>}>
      {playerId ? <p className="muted">A játékos összes ismert azonosítója tiltásra kerül (IP soha).</p> : (
        <>
          <label className="field"><span>Azonosítók (szóközzel vagy vesszővel elválasztva)</span><textarea rows={2} value={identifiers} onChange={(e) => setIdentifiers(e.target.value)} placeholder="license:… discord:…" /></label>
          <label className="field"><span>Játékos neve (opcionális)</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} /></label>
        </>
      )}
      <label className="field"><span>Időtartam</span>
        <select value={duration} onChange={(e) => setDuration(e.target.value)}>
          {durations.map((d) => <option key={d.label} value={d.seconds === null ? 'permanent' : String(d.seconds)}>{d.label}</option>)}
        </select>
      </label>
      {!can('bans.permanent') && <p className="muted small">Végleges banhoz bans.permanent jogosultság kell.</p>}
      <label className="field"><span>Indoklás (kötelező)</span><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></label>
      {detectionIds?.length ? <p className="muted small">{detectionIds.length} detektálás csatolva bizonyítékként.</p> : null}
      <FieldError error={create.error} />
    </Modal>
  );
}

export function BanDetail({ banId, onClose }: { banId: string; onClose: () => void }) {
  const server = useServer();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const [action, setAction] = useState<null | 'revoke' | 'under_review' | 'upheld' | 'overturned'>(null);
  const q = useQuery({ queryKey: ['bans', server.id, 'detail', banId], queryFn: () => api<{ ban: Ban; detections: { id: string; type: string; severity: string; occurred_at: string }[]; history: { action: string; actor_label: string; details: Record<string, unknown>; created_at: string }[] }>('GET', `/servers/${server.id}/bans/${banId}`) });
  const done = (msg: string) => { toast(msg, 'success'); void qc.invalidateQueries({ queryKey: ['bans', server.id] }); };
  const b = q.data?.ban;
  return (
    <Modal title={b ? `Ban ${b.public_code}` : 'Ban'} onClose={onClose} wide footer={b && can('bans.remove') ? <>
      <button className="btn" onClick={() => setAction('under_review')}>Felülvizsgálat alá</button>
      <button className="btn" onClick={() => setAction('upheld')}>Fenntartás</button>
      <button className="btn" onClick={() => setAction('overturned')}>Téves ban (feloldás)</button>
      {b.status === 'active' && <button className="btn danger" onClick={() => setAction('revoke')}>Feloldás</button>}
    </> : undefined}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : b && (
        <>
          <dl className="kv">
            <dt>Játékos</dt><dd>{b.player_id ? <Link to={`/s/${server.id}/players/${b.player_id}`} onClick={onClose}>{b.player_name}</Link> : b.player_name}</dd>
            <dt>Státusz</dt><dd><Badge tone={statusTone(b.status)}>{BAN_STATUS[b.status]}</Badge> {b.review_status !== 'none' && <Badge>{REVIEW[b.review_status]}</Badge>}</dd>
            <dt>Ok</dt><dd>{b.reason}</dd>
            <dt>Létrehozta</dt><dd>{b.created_by_label} <span className="muted">({b.source}) · {fmtDate(b.created_at)}</span></dd>
            <dt>Lejár</dt><dd>{b.expires_at ? `${fmtDate(b.expires_at)} (${fmtRelative(b.expires_at)})` : 'végleges'}</dd>
            {b.revoked_at && <><dt>Feloldva</dt><dd>{b.revoked_by_label} · {fmtDate(b.revoked_at)} – {b.revoke_reason}</dd></>}
            {b.review_note && <><dt>Felülvizsgálat</dt><dd>{b.review_note}</dd></>}
            <dt>Azonosítók</dt><dd className="mono small">{b.identifiers.map((i) => <div key={i}>{i}</div>)}</dd>
          </dl>
          <h3>Kapcsolódó detektálások</h3>
          {q.data!.detections.length ? <ul className="plain">{q.data!.detections.map((d) => <li key={d.id}><span className={`badge sev-${d.severity}`}>{d.severity}</span> {d.type} <span className="muted">{fmtDate(d.occurred_at)}</span></li>)}</ul> : <p className="muted">Nincs csatolt detektálás.</p>}
          <h3>Előzmények</h3>
          <ul className="timeline">{q.data!.history.map((h, i) => <li key={i}><b>{h.action}</b> – {h.actor_label} <span className="muted">{fmtDate(h.created_at)}</span></li>)}</ul>
        </>
      )}
      {action === 'revoke' && b && <ConfirmReason title="Ban feloldása" description="A játékos újra csatlakozhat. A játékszerver a következő szinkronnál (pár mp) frissít." confirmLabel="Feloldás" onClose={() => setAction(null)}
        onConfirm={async (reason) => { await api('POST', `/servers/${server.id}/bans/${b.id}/revoke`, { reason }); done('Ban feloldva'); void q.refetch(); }} />}
      {action && action !== 'revoke' && b && <ConfirmReason title={`Felülvizsgálat: ${REVIEW[action]}`} description={action === 'overturned' ? 'Téves ban: a ban azonnal feloldásra kerül.' : undefined} onClose={() => setAction(null)}
        onConfirm={async (note) => { await api('POST', `/servers/${server.id}/bans/${b.id}/review`, { status: action, note }); done('Felülvizsgálat mentve'); void q.refetch(); }} />}
    </Modal>
  );
}

export function BanTable({ items, onOpen }: { items: Ban[]; onOpen: (b: Ban) => void }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Kód</th><th>Játékos</th><th>Ok</th><th>Létrehozta</th><th>Létrehozva</th><th>Lejár</th><th>Státusz</th></tr></thead>
      <tbody>{items.map((b) => (
        <tr key={b.id} className="clickable" onClick={() => onOpen(b)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(b)}>
          <td className="mono">{b.public_code}</td><td>{b.player_name || '–'}</td><td className="truncate">{b.reason}</td>
          <td className="small">{b.created_by_label}</td><td className="small nowrap">{fmtDate(b.created_at)}</td>
          <td className="small nowrap">{b.expires_at ? fmtDate(b.expires_at) : 'végleges'}</td>
          <td><Badge tone={statusTone(b.status)}>{BAN_STATUS[b.status]}</Badge>{b.review_status !== 'none' && <> <Badge>{REVIEW[b.review_status]}</Badge></>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

export function BansPage() {
  const server = useServer();
  const can = useCan();
  const [f, setF] = useState({ page: 1, status: 'active' as 'active' | 'expired' | 'revoked' | 'all', q: '', source: '' });
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['bans', server.id, f], queryFn: () => api<Page<Ban>>('GET', `/servers/${server.id}/bans${qs({ ...f, pageSize: 25 })}`), placeholderData: (p) => p });
  return (
    <>
      <PageHeader title="Banok" subtitle="Szerveroldali, tranzakcionális banrendszer. Minden változás auditálva." actions={can('bans.create') && <button className="btn danger" onClick={() => setCreating(true)}>+ Új ban</button>} />
      <div className="filters">
        <Tabs value={f.status} onChange={(status) => setF({ ...f, status, page: 1 })} options={[['active', 'Aktív'], ['expired', 'Lejárt'], ['revoked', 'Feloldott'], ['all', 'Mind']]} />
        <input type="search" placeholder="Név, kód, ok vagy azonosító…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} aria-label="Keresés" />
        <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value, page: 1 })} aria-label="Forrás"><option value="">Minden forrás</option><option value="web">Web</option><option value="ingame">Játékon belül</option><option value="system">Automatikus</option></select>
      </div>
      <section className="card flush">
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data!.items.length === 0 ? <Empty title="Nincs ban">A szűrésnek megfelelő ban nem található.</Empty> : (
          <>
            <BanTable items={q.data!.items} onOpen={(b) => setOpen(b.id)} />
            <Pagination page={q.data!.page} pageSize={q.data!.pageSize} total={q.data!.total} onPage={(p) => setF({ ...f, page: p })} />
          </>
        )}
      </section>
      {open && <BanDetail banId={open} onClose={() => setOpen(null)} />}
      {creating && <BanCreateModal onClose={() => setCreating(false)} />}
    </>
  );
}
