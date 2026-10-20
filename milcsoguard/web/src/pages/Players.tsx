import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useCan, useServer } from '../lib/server';
import { fmtDate, fmtDuration, fmtRelative } from '../lib/format';
import type { Ban, Detection, OnlinePlayer, Page, Player, Replay } from '../lib/types';
import { useToast } from '../lib/toast';
import { PageHeader } from '../components/Layout';
import { Badge, ConfirmReason, Empty, ErrorState, Loading, Pagination, RiskBar, StatTile, Tabs } from '../components/ui';
import { BanCreateModal, BanDetail, BanTable } from './Bans';
import { DetectionDetail, DetectionTable } from './Detections';
import { ReplayModal, ReplayTable, RequestReplayButton } from './Replays';

function KickModal({ playerId, name, onClose }: { playerId: string; name: string; onClose: () => void }) {
  const server = useServer();
  const toast = useToast();
  return (
    <ConfirmReason title={`Kick: ${name}`} description="A kérés a játékszerver parancssorába kerül; a szerver ellenőrzi, hogy a net ID még ugyanahhoz a játékoshoz tartozik." confirmLabel="Kick" danger onClose={onClose}
      onConfirm={async (reason) => { await api('POST', `/servers/${server.id}/players/${playerId}/kick`, { reason }); toast(`Kick elküldve: ${name}`, 'success'); }} />
  );
}

export function PlayersPage() {
  const server = useServer();
  const can = useCan();
  const [tab, setTab] = useState<'online' | 'all'>('online');
  const [f, setF] = useState({ page: 1, q: '', flagged: '' });
  const [kick, setKick] = useState<OnlinePlayer | null>(null);
  const [ban, setBan] = useState<OnlinePlayer | null>(null);
  const [filter, setFilter] = useState('');
  const online = useQuery({ queryKey: ['online', server.id], queryFn: () => api<{ serverOnline: boolean; items: OnlinePlayer[] }>('GET', `/servers/${server.id}/players/online`), enabled: tab === 'online', refetchInterval: 30_000 });
  const all = useQuery({ queryKey: ['players', server.id, f], queryFn: () => api<Page<Player>>('GET', `/servers/${server.id}/players${qs({ ...f, pageSize: 25 })}`), enabled: tab === 'all', placeholderData: (p) => p });
  const onlineItems = (online.data?.items ?? []).filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()) || String(p.net_id) === filter);
  return (
    <>
      <PageHeader title="Játékosok" subtitle="Az online lista a játékszerver heartbeatjéből frissül (30 mp), a csatlakozás/lecsatlakozás azonnal." />
      <div className="filters">
        <Tabs value={tab} onChange={setTab} options={[['online', 'Online'], ['all', 'Összes ismert']]} />
        {tab === 'online' ? (
          <input type="search" placeholder="Név vagy szerver ID…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Szűrés" />
        ) : (
          <>
            <input type="search" placeholder="Név vagy azonosító (license:, discord:…)" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} aria-label="Keresés" />
            <label className="check"><input type="checkbox" checked={f.flagged === 'true'} onChange={(e) => setF({ ...f, flagged: e.target.checked ? 'true' : '', page: 1 })} /> csak detektáltak</label>
          </>
        )}
      </div>
      <section className="card flush">
        {tab === 'online' ? (
          online.isLoading ? <Loading /> : online.error ? <ErrorState error={online.error} retry={() => void online.refetch()} /> : !online.data!.serverOnline ? <Empty title="A játékszerver offline">Nem érkezik heartbeat – ellenőrizd a resource-ot és az API-kulcsot (Rendszerállapot oldal).</Empty> : onlineItems.length === 0 ? <Empty title="Nincs online játékos" /> : (
            <div className="table-wrap"><table>
              <thead><tr><th>ID</th><th>Név</th><th>Ping</th><th>Kockázat</th><th className="num">Detektálás</th><th>Online</th><th /></tr></thead>
              <tbody>{onlineItems.map((p) => (
                <tr key={p.session_id}>
                  <td className="mono">{p.net_id}</td>
                  <td><Link to={`/s/${server.id}/players/${p.player_id}`}>{p.name}</Link> {p.monitored && <Badge tone="warn">megfigyelt</Badge>}</td>
                  <td>{p.last_ping ?? '–'} ms</td>
                  <td><RiskBar value={p.risk_score} /></td>
                  <td className="num">{p.session_detections}</td>
                  <td className="small">{fmtDuration((Date.now() - new Date(p.connected_at).getTime()) / 1000)}</td>
                  <td className="actions">
                    {can('players.kick') && <button className="btn sm" onClick={() => setKick(p)}>Kick</button>}
                    {can('bans.create') && <button className="btn sm danger" onClick={() => setBan(p)}>Ban</button>}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )
        ) : all.isLoading ? <Loading /> : all.error ? <ErrorState error={all.error} /> : all.data!.items.length === 0 ? <Empty title="Nincs találat" /> : (
          <>
            <div className="table-wrap"><table>
              <thead><tr><th>Név</th><th>Első látogatás</th><th>Utoljára</th><th className="num">Detektálás</th><th>Ban</th><th>Állapot</th></tr></thead>
              <tbody>{all.data!.items.map((p) => (
                <tr key={p.id}>
                  <td><Link to={`/s/${server.id}/players/${p.id}`}>{p.last_name || '(névtelen)'}</Link></td>
                  <td className="small">{fmtDate(p.first_seen)}</td><td className="small">{fmtRelative(p.last_seen)}</td>
                  <td className="num">{p.detections}</td>
                  <td>{p.active_bans > 0 ? <Badge tone="danger">bannolva</Badge> : '–'}</td>
                  <td>{p.online ? <Badge tone="ok">online</Badge> : <span className="muted">offline</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <Pagination page={all.data!.page} pageSize={all.data!.pageSize} total={all.data!.total} onPage={(page) => setF({ ...f, page })} />
          </>
        )}
      </section>
      {kick && <KickModal playerId={kick.player_id} name={kick.name} onClose={() => setKick(null)} />}
      {ban && <BanCreateModal playerId={ban.player_id} playerName={ban.name} onClose={() => setBan(null)} />}
    </>
  );
}

interface Profile {
  player: { id: string; last_name: string; first_seen: string; last_seen: string; notes: string };
  identifiers: { identifier: string; first_seen: string; last_seen: string }[];
  sessions: { id: string; net_id: number; name: string; connected_at: string; disconnected_at: string | null; disconnect_reason: string | null; risk_score: number }[];
  detections: Detection[];
  bans: Ban[];
  stats: { total: number; high: number; false_positives: number };
  online: { net_id: number } | null;
  replays: Replay[];
}

export function PlayerProfilePage() {
  const { playerId } = useParams();
  const server = useServer();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['player', server.id, playerId], queryFn: () => api<Profile>('GET', `/servers/${server.id}/players/${playerId}`) });
  const [notes, setNotes] = useState('');
  const [modal, setModal] = useState<'kick' | 'ban' | null>(null);
  const [det, setDet] = useState<Detection | null>(null);
  const [banOpen, setBanOpen] = useState<string | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  useEffect(() => { if (q.data) setNotes(q.data.player.notes); }, [q.data]);
  const saveNotes = useMutation({
    mutationFn: () => api('PATCH', `/servers/${server.id}/players/${playerId}`, { notes }),
    onSuccess: () => { toast('Jegyzet mentve', 'success'); void qc.invalidateQueries({ queryKey: ['player', server.id, playerId] }); },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data!;
  return (
    <>
      <PageHeader
        title={d.player.last_name || '(névtelen játékos)'}
        subtitle={<>{d.online ? <Badge tone="ok">online · #{d.online.net_id}</Badge> : <span className="muted">offline · utoljára {fmtRelative(d.player.last_seen)}</span>} <span className="muted">· első látogatás {fmtDate(d.player.first_seen)}</span></>}
        actions={<>
          {d.online && can('replays.request') && <RequestReplayButton playerId={d.player.id} name={d.player.last_name} />}
          {d.online && can('players.kick') && <button className="btn" onClick={() => setModal('kick')}>Kick</button>}
          {can('bans.create') && <button className="btn danger" onClick={() => setModal('ban')}>Ban</button>}
        </>}
      />
      <div className="grid stats">
        <StatTile label="Összes detektálás" value={d.stats.total} />
        <StatTile label="HIGH / CRITICAL" value={d.stats.high} tone={d.stats.high ? 'warn' : undefined} />
        <StatTile label="Téves riasztás" value={d.stats.false_positives} />
        <StatTile label="Banok" value={d.bans.length} hint={d.bans.some((b) => b.status === 'active') ? 'aktív ban van' : undefined} tone={d.bans.some((b) => b.status === 'active') ? 'danger' : undefined} />
      </div>
      <div className="grid two">
        <section className="card">
          <h2>Azonosítók</h2>
          {!can('players.identifiers') && <p className="muted small">Az azonosítók maszkolva (players.identifiers jog szükséges).</p>}
          <table><tbody>{d.identifiers.map((i) => <tr key={i.identifier}><td className="mono small">{i.identifier}</td><td className="muted small">{fmtRelative(i.last_seen)}</td></tr>)}</tbody></table>
        </section>
        <section className="card">
          <h2>Admin jegyzet</h2>
          <textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} disabled={!can('detections.review')} aria-label="Jegyzet" />
          {can('detections.review') && <div className="row"><button className="btn primary sm" disabled={saveNotes.isPending || notes === d.player.notes} onClick={() => saveNotes.mutate()}>Mentés</button></div>}
        </section>
      </div>
      {can('detections.view') && (
        <section className="card flush">
          <h2 className="pad">Detektálási előzmények</h2>
          {d.detections.length ? <DetectionTable items={d.detections} onOpen={setDet} showPlayer={false} /> : <Empty title="Nincs detektálás" />}
        </section>
      )}
      {can('bans.view') && (
        <section className="card flush">
          <h2 className="pad">Banok</h2>
          {d.bans.length ? <BanTable items={d.bans.map((b) => ({ ...b, identifiers: b.identifiers ?? [] }))} onOpen={(b) => setBanOpen(b.id)} /> : <Empty title="Nincs ban" />}
        </section>
      )}
      {can('replays.view') && d.replays.length > 0 && (
        <section className="card flush">
          <h2 className="pad">POV visszajátszások</h2>
          <ReplayTable items={d.replays} onOpen={setReplay} showPlayer={false} />
        </section>
      )}
      <section className="card flush">
        <h2 className="pad">Munkamenetek</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Net ID</th><th>Név</th><th>Csatlakozott</th><th>Kilépett</th><th>Ok</th><th className="num">Kockázat</th></tr></thead>
          <tbody>{d.sessions.map((s) => <tr key={s.id}><td>{s.net_id}</td><td>{s.name}</td><td className="small">{fmtDate(s.connected_at)}</td><td className="small">{s.disconnected_at ? fmtDate(s.disconnected_at) : <Badge tone="ok">online</Badge>}</td><td className="small">{s.disconnect_reason ?? ''}</td><td className="num">{s.risk_score}</td></tr>)}</tbody>
        </table></div>
      </section>
      {modal === 'kick' && <KickModal playerId={d.player.id} name={d.player.last_name} onClose={() => setModal(null)} />}
      {modal === 'ban' && <BanCreateModal playerId={d.player.id} playerName={d.player.last_name} detectionIds={d.detections.filter((x) => x.review_status === 'confirmed').map((x) => x.id).slice(0, 50)} onClose={() => setModal(null)} />}
      {det && <DetectionDetail d={det} onClose={() => setDet(null)} />}
      {banOpen && <BanDetail banId={banOpen} onClose={() => setBanOpen(null)} />}
      {replay && <ReplayModal replay={replay} onClose={() => setReplay(null)} />}
    </>
  );
}
