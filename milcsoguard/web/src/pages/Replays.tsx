import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useCan, useServer } from '../lib/server';
import { fmtDate, fmtRelative } from '../lib/format';
import type { Page, Replay } from '../lib/types';
import { useToast } from '../lib/toast';
import { PageHeader } from '../components/Layout';
import { Badge, ConfirmReason, Empty, ErrorState, Loading, Modal, Pagination, Tabs } from '../components/ui';

export const REPLAY_STATUS: Record<Replay['status'], string> = { requested: 'Kérve', uploading: 'Feltöltés', ready: 'Kész', failed: 'Sikertelen' };
const statusTone = (s: Replay['status']) => (s === 'ready' ? 'ok' : s === 'failed' ? 'danger' : 'warn') as 'ok' | 'danger' | 'warn';
const fmtSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtSecs = (ms: number) => `${Math.round(ms / 1000)} mp`;

/**
 * MediaRecorder WebM has no duration header (Chromium reports Infinity and the seek bar is useless).
 * Seeking far past the end makes the browser scan the file and learn the real duration.
 */
function fixDuration(v: HTMLVideoElement, then: () => void) {
  if (Number.isFinite(v.duration)) return then();
  v.dataset.fixing = '1';
  const back = () => {
    v.removeEventListener('timeupdate', back);
    v.currentTime = 0;
    delete v.dataset.fixing;
    then();
  };
  v.addEventListener('timeupdate', back);
  v.currentTime = 1e101;
}

/**
 * Plays a replay: each part is a standalone WebM (the recorder restarts every few seconds), fetched
 * with the session cookie and played back to back. The end of the last part is the moment of the
 * ban / request.
 */
export function ReplayPlayer({ replay }: { replay: Replay }) {
  const server = useServer();
  const meta = useQuery({
    queryKey: ['replays', server.id, 'detail', replay.id],
    queryFn: () => api<{ replay: Replay; parts: { idx: number; duration_ms: number; size_bytes: number }[] }>('GET', `/servers/${server.id}/replays/${replay.id}`),
    enabled: replay.status === 'ready',
  });
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const parts = meta.data?.parts ?? [];

  useEffect(() => {
    if (!parts.length) return;
    let cancelled = false;
    const made: string[] = [];
    setUrls(parts.map(() => null));
    (async () => {
      for (const [i, p] of parts.entries()) {
        const res = await fetch(`/api/v1/servers/${server.id}/replays/${replay.id}/parts/${p.idx}`, { credentials: 'same-origin' });
        if (!res.ok) { if (!cancelled) setError(`A(z) ${i + 1}. rész nem tölthető le (HTTP ${res.status}).`); return; }
        const url = URL.createObjectURL(await res.blob());
        made.push(url);
        if (cancelled) return;
        setUrls((u) => u.map((x, j) => (j === i ? url : x)));
      }
    })().catch(() => !cancelled && setError('A felvétel letöltése megszakadt.'));
    return () => { cancelled = true; made.forEach((u) => URL.revokeObjectURL(u)); };
    // parts is derived from the query; its identity changes only when the data does
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.data, server.id, replay.id]);

  useEffect(() => {
    const v = video.current;
    const src = urls[current];
    if (!v || !src || v.src === src) return;
    v.onloadedmetadata = () => fixDuration(v, () => void v.play().catch(() => undefined));
    v.src = src;
  }, [urls, current]);

  if (replay.status !== 'ready') {
    return <p className="muted">{replay.status === 'failed' ? `Nem érkezett felvétel: ${replay.error ?? 'ismeretlen ok'}.` : 'A felvétel még feltöltés alatt van…'}</p>;
  }
  if (meta.isLoading) return <Loading label="Felvétel betöltése…" />;
  if (meta.error) return <ErrorState error={meta.error} />;
  const total = parts.reduce((s, p) => s + p.duration_ms, 0);
  return (
    <div className="replay">
      <div className="video-wrap">
        <video ref={video} controls muted playsInline onEnded={(e) => { if (!e.currentTarget.dataset.fixing) setCurrent((c) => (c + 1 < parts.length ? c + 1 : c)); }} aria-label={`Visszajátszás: ${replay.player_name}`} />
        {!urls[current] && !error && <div className="video-status">Betöltés…</div>}
        {error && <div className="video-status">{error}</div>}
      </div>
      <div className="replay-bar">
        <div className="replay-parts" role="tablist" aria-label="Részek">
          {parts.map((p, i) => (
            <button key={p.idx} role="tab" aria-selected={i === current} className={`replay-part ${i === current ? 'active' : ''}`} style={{ flexGrow: Math.max(1, p.duration_ms) }} disabled={!urls[i]} onClick={() => setCurrent(i)} title={`${i + 1}. rész · ${fmtSecs(p.duration_ms)}`}>
              {i + 1}
            </button>
          ))}
        </div>
        <span className="muted small nowrap">{fmtSecs(total)} · {replay.width}×{replay.height} @ {replay.fps} fps · {fmtSize(replay.size_bytes)}</span>
      </div>
      <p className="muted small">A sáv jobb széle a {replay.kind === 'ban' ? 'ban' : 'kérés'} pillanata. A felvétel a játékos saját kliensén készült: egy csaló manipulálhatja vagy blokkolhatja, ezért a detektálásokkal együtt értékeld.</p>
    </div>
  );
}

export function ReplayModal({ replay, onClose, footer }: { replay: Replay; onClose: () => void; footer?: ReactNode }) {
  const server = useServer();
  return (
    <Modal title={`Visszajátszás – ${replay.player_name || '?'}`} onClose={onClose} wide footer={footer}>
      <dl className="kv">
        <dt>Típus</dt><dd>{replay.kind === 'ban' ? 'Ban előtti felvétel' : 'Kézi kérés'}{replay.ban_code && <> · <span className="mono">{replay.ban_code}</span></>}</dd>
        <dt>Idő</dt><dd>{fmtDate(replay.created_at)} <span className="muted">({fmtRelative(replay.created_at)})</span></dd>
        {replay.reason && <><dt>Ok</dt><dd>{replay.reason}</dd></>}
        <dt>Kérte</dt><dd>{replay.requested_by_label}</dd>
        {replay.player_id && <><dt>Játékos</dt><dd><Link to={`/s/${server.id}/players/${replay.player_id}`} onClick={onClose}>{replay.player_name}</Link></dd></>}
      </dl>
      <ReplayPlayer replay={replay} />
    </Modal>
  );
}

export function ReplayTable({ items, onOpen, showPlayer = true }: { items: Replay[]; onOpen: (r: Replay) => void; showPlayer?: boolean }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Idő</th>{showPlayer && <th>Játékos</th>}<th>Típus</th><th>Ok / ban</th><th>Hossz</th><th>Állapot</th><th>Kérte</th></tr></thead>
      <tbody>{items.map((r) => (
        <tr key={r.id} className="clickable" onClick={() => onOpen(r)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(r)}>
          <td className="small nowrap">{fmtDate(r.created_at)}</td>
          {showPlayer && <td>{r.player_name || '–'}</td>}
          <td>{r.kind === 'ban' ? <Badge tone="danger">ban</Badge> : <Badge>kézi</Badge>}</td>
          <td className="truncate">{r.reason}{r.ban_code && <span className="mono muted small"> {r.ban_code}</span>}</td>
          <td className="small nowrap">{r.duration_ms ? fmtSecs(r.duration_ms) : '–'}</td>
          <td><Badge tone={statusTone(r.status)} title={r.error ?? undefined}>{REPLAY_STATUS[r.status]}</Badge>{r.status === 'failed' && r.error && <div className="muted small">{r.error}</div>}</td>
          <td className="small">{r.requested_by_label}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

/** Button + reason dialog for asking an online player's client for its replay buffer. */
export function RequestReplayButton({ playerId, name }: { playerId: string; name: string }) {
  const server = useServer();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>Visszajátszás kérése</button>
      {open && (
        <ConfirmReason
          title={`Visszajátszás kérése: ${name}`}
          description="A játékszerver bekéri a játékos kliensétől az utolsó ~15 másodperc saját nézetét. A játékos nem kap értesítést; a kérés auditnaplóba kerül. Pár másodperc múlva megjelenik a Visszajátszások között."
          confirmLabel="Kérés"
          onClose={() => setOpen(false)}
          onConfirm={async (reason) => {
            await api('POST', `/servers/${server.id}/players/${playerId}/replay`, { reason });
            toast('Visszajátszás kérve – a játékszerver pár másodpercen belül feltölti.', 'success');
            void qc.invalidateQueries({ queryKey: ['replays', server.id] });
          }}
        />
      )}
    </>
  );
}

export function ReplaysPage() {
  const server = useServer();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ page: 1, kind: '' as '' | 'ban' | 'manual' });
  const [open, setOpen] = useState<Replay | null>(null);
  const [del, setDel] = useState<Replay | null>(null);
  const q = useQuery({
    queryKey: ['replays', server.id, f],
    queryFn: () => api<Page<Replay> & { storage: { usedBytes: number; limitBytes: number } }>('GET', `/servers/${server.id}/replays${qs({ ...f, pageSize: 25 })}`),
    placeholderData: (p) => p,
  });
  const st = q.data?.storage;
  return (
    <>
      <PageHeader
        title="POV visszajátszások"
        subtitle="A bannolt (vagy kért) játékos saját nézete az utolsó ~15 másodpercből. Minden megnyitás auditálva."
        actions={st && <span className="muted small">Tárhely: {fmtSize(st.usedBytes)} / {fmtSize(st.limitBytes)}</span>}
      />
      <div className="filters">
        <Tabs value={f.kind} onChange={(kind) => setF({ page: 1, kind })} options={[['', 'Mind'], ['ban', 'Ban előtti'], ['manual', 'Kézi kérés']]} />
      </div>
      <section className="card flush">
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data!.items.length === 0 ? (
          <Empty title="Még nincs visszajátszás">Ban előtt a szerver automatikusan bekéri a játékos felvételét (Config.Replay.onBan), vagy egy online játékos profilján kérhetsz egyet.</Empty>
        ) : (
          <>
            <ReplayTable items={q.data!.items} onOpen={setOpen} />
            <Pagination page={q.data!.page} pageSize={q.data!.pageSize} total={q.data!.total} onPage={(page) => setF({ ...f, page })} />
          </>
        )}
      </section>
      {open && <ReplayModal replay={open} onClose={() => setOpen(null)} footer={can('servers.manage') ? <button className="btn danger" onClick={() => setDel(open)}>Törlés</button> : undefined} />}
      {del && (
        <ConfirmReason title="Visszajátszás törlése" description="A felvétel véglegesen törlődik." danger confirmLabel="Törlés" onClose={() => setDel(null)}
          onConfirm={async () => { await api('DELETE', `/servers/${server.id}/replays/${del.id}`); toast('Törölve', 'success'); setOpen(null); void qc.invalidateQueries({ queryKey: ['replays', server.id] }); }} />
      )}
    </>
  );
}
