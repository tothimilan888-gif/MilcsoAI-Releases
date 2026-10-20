import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCan, useServer } from '../lib/server';
import { fmtDate } from '../lib/format';
import type { WhitelistEntry } from '../lib/types';
import { useToast } from '../lib/toast';
import { PageHeader } from '../components/Layout';
import { Badge, Empty, ErrorState, FieldError, Loading, Modal, Tabs } from '../components/ui';

const KIND: Record<string, string> = { player: 'Játékos', resource: 'Megbízható resource', model: 'Engedélyezett modell' };
const HINT: Record<string, string> = {
  player: 'FiveM azonosító (license:…, discord:…). A megadott modulok nem futnak erre a játékosra – pl. movement.* egy noclippel dolgozó eseményszervezőnél.',
  resource: 'Resource név. Az általa spawnolt entitásokat az entity-védelem nem blokkolja (GetEntityScript alapján).',
  model: 'Modellnév vagy hash. Kivétel az entity spawn tiltólista alól.',
};

export function WhitelistPage() {
  const server = useServer();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState<'all' | 'player' | 'resource' | 'model'>('all');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: 'player', value: '', modules: '', note: '', expiresAt: '' });
  const q = useQuery({ queryKey: ['whitelist', server.id], queryFn: () => api<{ items: WhitelistEntry[] }>('GET', `/servers/${server.id}/whitelist`) });
  const add = useMutation({
    mutationFn: () => api('POST', `/servers/${server.id}/whitelist`, {
      kind: form.kind, value: form.value.trim(), note: form.note,
      modules: form.modules.split(',').map((s) => s.trim()).filter(Boolean),
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
    }),
    onSuccess: () => { toast('Bejegyzés hozzáadva – a játékszerver pár másodpercen belül alkalmazza.', 'success'); setAdding(false); setForm({ kind: 'player', value: '', modules: '', note: '', expiresAt: '' }); void qc.invalidateQueries({ queryKey: ['whitelist', server.id] }); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api('DELETE', `/servers/${server.id}/whitelist/${id}`),
    onSuccess: () => { toast('Bejegyzés törölve', 'success'); void qc.invalidateQueries({ queryKey: ['whitelist', server.id] }); },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const items = (q.data?.items ?? []).filter((w) => kind === 'all' || w.kind === kind);
  return (
    <>
      <PageHeader title="Whitelist" subtitle="Engedélyezett játékosok, megbízható resource-ok és modellek. Minden változás auditált." actions={can('whitelist.manage') && <button className="btn primary" onClick={() => setAdding(true)}>+ Új bejegyzés</button>} />
      <div className="filters"><Tabs value={kind} onChange={setKind} options={[['all', 'Mind'], ['player', 'Játékosok'], ['resource', 'Resource-ok'], ['model', 'Modellek']]} /></div>
      <section className="card flush">
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : items.length === 0 ? <Empty title="Nincs bejegyzés">A whitelist üres – minden modul mindenkire érvényes.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Típus</th><th>Érték</th><th>Modulok</th><th>Megjegyzés</th><th>Létrehozta</th><th>Lejár</th><th /></tr></thead>
            <tbody>{items.map((w) => (
              <tr key={w.id}>
                <td>{KIND[w.kind]}</td><td className="mono small">{w.value}</td>
                <td>{w.modules.length ? w.modules.map((m) => <Badge key={m}>{m}</Badge>) : <Badge tone="warn">minden modul</Badge>}</td>
                <td>{w.note}</td><td className="small">{w.created_by_label}<div className="muted">{fmtDate(w.created_at)}</div></td>
                <td className="small">{w.expires_at ? (w.expired ? <Badge>lejárt</Badge> : fmtDate(w.expires_at)) : '–'}</td>
                <td className="actions">{can('whitelist.manage') && <button className="btn sm danger" onClick={() => { if (window.confirm(`Törlöd: ${w.value}?`)) del.mutate(w.id); }}>Törlés</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {adding && (
        <Modal title="Új whitelist bejegyzés" onClose={() => setAdding(false)} footer={<><button className="btn ghost" onClick={() => setAdding(false)}>Mégse</button><button className="btn primary" disabled={!form.value.trim() || add.isPending} onClick={() => add.mutate()}>Hozzáadás</button></>}>
          <label className="field"><span>Típus</span><select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <p className="muted small">{HINT[form.kind]}</p>
          <label className="field"><span>Érték</span><input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder={form.kind === 'player' ? 'license:…' : form.kind === 'resource' ? 'qb-garages' : 'adder'} /></label>
          {form.kind === 'player' && <label className="field"><span>Modulok (vesszővel; üres = mind)</span><input value={form.modules} onChange={(e) => setForm({ ...form, modules: e.target.value })} placeholder="movement.*, player.godmode" /></label>}
          <label className="field"><span>Megjegyzés</span><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} /></label>
          <label className="field"><span>Lejárat (opcionális)</span><input type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></label>
          <FieldError error={add.error} />
        </Modal>
      )}
    </>
  );
}
