import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useServer } from '../lib/server';
import { useToast } from '../lib/toast';
import { PageHeader } from '../components/Layout';
import { ErrorState, FieldError, Loading, Modal } from '../components/ui';

const TYPES = ['license', 'license2', 'discord', 'fivem', 'steam', 'xbl', 'live', 'token', 'ip'];
const TYPE_HINT: Record<string, string> = { token: 'hardver token – erős, de közös gépnél (internetkávézó, testvérek) ártatlant is kitilthat', ip: 'IP – NAT/mobilnet miatt sok téves egyezést okoz, nem ajánlott' };
interface ServerRow { name: string; slug: string; description: string; ban_match_types: string[]; retention: { detectionsDays: number; auditDays: number; systemEventsDays: number; sessionsDays: number } }

export function ServerSettingsPage() {
  const server = useServer();
  const toast = useToast();
  const { refresh } = useAuth();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['server', server.id], queryFn: () => api<{ server: ServerRow }>('GET', `/servers/${server.id}`) });
  const [form, setForm] = useState<ServerRow | null>(null);
  const [del, setDel] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState('');
  useEffect(() => { if (q.data) setForm(q.data.server); }, [q.data]);
  const save = useMutation({
    mutationFn: () => api('PATCH', `/servers/${server.id}`, { name: form!.name, description: form!.description, banMatchTypes: form!.ban_match_types, retention: form!.retention }),
    onSuccess: () => { toast('Mentve', 'success'); void refresh(); },
  });
  const remove = useMutation({ mutationFn: () => api('DELETE', `/servers/${server.id}`, { confirmSlug }), onSuccess: async () => { await refresh(); nav('/'); } });
  if (q.isLoading || !form) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const ret = (k: keyof ServerRow['retention'], label: string, min: number) => (
    <label className="field"><span>{label} (nap)</span><input type="number" min={min} max={3650} value={form.retention[k]} onChange={(e) => setForm({ ...form, retention: { ...form.retention, [k]: Number(e.target.value) } })} /></label>
  );
  return (
    <>
      <PageHeader title="Szerver beállításai" actions={<button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Mentés</button>} />
      <FieldError error={save.error} />
      <div className="grid two">
        <section className="card">
          <h2>Általános</h2>
          <label className="field"><span>Név</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>Leírás</span><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <h2>Ban-egyezés azonosítói</h2>
          <p className="muted small">Mely azonosítótípusok egyezése esetén érvényes egy ban csatlakozáskor. A Discord azonosító hiányozhat, a szerver ID pedig újracsatlakozáskor változik – ezért soha nem azonosító.</p>
          <div className="checks">{TYPES.map((t) => (
            <label key={t} className="check" title={TYPE_HINT[t]}>
              <input type="checkbox" checked={form.ban_match_types.includes(t)} onChange={(e) => setForm({ ...form, ban_match_types: e.target.checked ? [...form.ban_match_types, t] : form.ban_match_types.filter((x) => x !== t) })} /> {t}{TYPE_HINT[t] && <span className="muted small"> – {TYPE_HINT[t]}</span>}
            </label>
          ))}</div>
        </section>
        <section className="card">
          <h2>Adatmegőrzés</h2>
          <p className="muted small">A karbantartó job óránként töröl. Banhoz csatolt detektálás és maguk a banok soha nem törlődnek automatikusan.</p>
          {ret('detectionsDays', 'Detektálások', 7)}{ret('auditDays', 'Auditnapló', 30)}{ret('systemEventsDays', 'Rendszeresemények', 7)}{ret('sessionsDays', 'Játékos munkamenetek', 7)}
          <h2 className="danger-text">Veszélyzóna</h2>
          <button className="btn danger" onClick={() => setDel(true)}>Szerver törlése…</button>
        </section>
      </div>
      {del && (
        <Modal title="Szerver törlése" onClose={() => setDel(false)} footer={<><button className="btn ghost" onClick={() => setDel(false)}>Mégse</button><button className="btn danger" disabled={confirmSlug !== form.slug || remove.isPending} onClick={() => remove.mutate()}>Végleges törlés</button></>}>
          <p>A szerver eltűnik a listából, minden API-kulcsa azonnal visszavonásra kerül. Az adatok soft-delete-tel megmaradnak a visszaállításhoz (lásd BACKUP.md).</p>
          <label className="field"><span>Írd be a szerver azonosítóját: <code>{form.slug}</code></span><input value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} /></label>
          <FieldError error={remove.error} />
        </Modal>
      )}
    </>
  );
}
