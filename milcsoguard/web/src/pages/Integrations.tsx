import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCan, useServer } from '../lib/server';
import { fmtDate, fmtRelative } from '../lib/format';
import { SEVERITIES } from '../lib/types';
import { useToast } from '../lib/toast';
import { PageHeader } from '../components/Layout';
import { Badge, Empty, ErrorState, FieldError, Loading, Modal } from '../components/ui';

interface ApiKey { id: string; name: string; prefix: string; created_at: string; expires_at: string | null; last_used_at: string | null; last_used_ip: string | null; revoked_at: string | null; rotated_from: string | null }

function SecretModal({ secret, onClose }: { secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const origin = window.location.origin;
  return (
    <Modal title="Új API-kulcs" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Elmentettem</button>} wide>
      <p><b>Ez az egyetlen alkalom, amikor a kulcs látható.</b> A backend csak a hash-ét tárolja.</p>
      <pre className="json secret">{secret}</pre>
      <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(secret).then(() => setCopied(true))}>{copied ? 'Másolva ✓' : 'Másolás'}</button>
      <h3>server.cfg</h3>
      <pre className="json">{`# csak szerveroldali convar (set, NEM setr!)
set milcsoguard_api_url "${origin}"
set milcsoguard_api_key "${secret}"
ensure milcsoguard`}</pre>
    </Modal>
  );
}

function ApiKeys() {
  const server = useServer();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['apikeys', server.id], queryFn: () => api<{ items: ApiKey[] }>('GET', `/servers/${server.id}/api-keys`) });
  const inv = () => void qc.invalidateQueries({ queryKey: ['apikeys', server.id] });
  const create = useMutation({ mutationFn: () => api<{ secret: string }>('POST', `/servers/${server.id}/api-keys`, { name: name.trim() }), onSuccess: (r) => { setSecret(r.secret); setName(''); inv(); } });
  const revoke = useMutation({ mutationFn: (id: string) => api('POST', `/servers/${server.id}/api-keys/${id}/revoke`, {}), onSuccess: () => { toast('Kulcs visszavonva – azonnal érvénytelen', 'success'); inv(); }, onError: (e) => toast((e as Error).message, 'error') });
  const rotate = useMutation({ mutationFn: (id: string) => api<{ secret: string }>('POST', `/servers/${server.id}/api-keys/${id}/rotate`, { graceMinutes: 60 }), onSuccess: (r) => { setSecret(r.secret); inv(); }, onError: (e) => toast((e as Error).message, 'error') });
  return (
    <section className="card">
      <h2>Játékszerver API-kulcsok</h2>
      <p className="muted small">A FiveM resource ezzel a kulccsal kommunikál a backenddel (HTTPS). Rotáláskor a régi kulcs még 60 percig érvényes, hogy legyen idő a server.cfg frissítésére.</p>
      <div className="filters"><input placeholder="Kulcs neve (pl. éles szerver)" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} aria-label="Kulcs neve" /><button className="btn primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Kulcs generálása</button></div>
      <FieldError error={create.error} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : q.data!.items.length === 0 ? <Empty title="Még nincs API-kulcs">Generálj egyet, és add meg a server.cfg-ben.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Név</th><th>Prefix</th><th>Létrehozva</th><th>Utoljára használva</th><th>Állapot</th><th /></tr></thead>
          <tbody>{q.data!.items.map((k) => {
            const expired = k.expires_at && new Date(k.expires_at).getTime() < Date.now();
            return (
              <tr key={k.id}>
                <td>{k.name} {k.rotated_from && <Badge>rotált</Badge>}</td><td className="mono">mgk_{k.prefix}_…</td><td className="small">{fmtDate(k.created_at)}</td>
                <td className="small">{fmtRelative(k.last_used_at)} {k.last_used_ip && <span className="muted">({k.last_used_ip})</span>}</td>
                <td>{k.revoked_at ? <Badge>visszavonva</Badge> : expired ? <Badge>lejárt</Badge> : k.expires_at ? <Badge tone="warn">lejár: {fmtDate(k.expires_at)}</Badge> : <Badge tone="ok">aktív</Badge>}</td>
                <td className="actions">{!k.revoked_at && !expired && <>
                  <button className="btn sm" onClick={() => { if (window.confirm('Új kulcsot generálsz; a régi 60 percig még működik. Folytatod?')) rotate.mutate(k.id); }}>Rotálás</button>
                  <button className="btn sm danger" onClick={() => { if (window.confirm(`Visszavonod: ${k.name}? A szerver azonnal elveszti a kapcsolatot.`)) revoke.mutate(k.id); }}>Visszavonás</button>
                </>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {secret && <SecretModal secret={secret} onClose={() => setSecret(null)} />}
    </section>
  );
}

function Discord() {
  const server = useServer();
  const toast = useToast();
  const q = useQuery({ queryKey: ['integrations', server.id], queryFn: () => api<{ discord: { enabled: boolean; minSeverity: string; configured: boolean; hint: string | null } }>('GET', `/servers/${server.id}/integrations`) });
  const [form, setForm] = useState({ enabled: false, minSeverity: 'HIGH', webhookUrl: '' });
  useEffect(() => { if (q.data) setForm({ enabled: q.data.discord.enabled, minSeverity: q.data.discord.minSeverity, webhookUrl: '' }); }, [q.data]);
  const save = useMutation({
    mutationFn: () => api('PUT', `/servers/${server.id}/integrations/discord`, { enabled: form.enabled, minSeverity: form.minSeverity, ...(form.webhookUrl ? { webhookUrl: form.webhookUrl } : {}) }),
    onSuccess: () => { toast('Discord beállítás mentve', 'success'); void q.refetch(); },
  });
  const test = useMutation({ mutationFn: () => api<{ sent: boolean }>('POST', `/servers/${server.id}/integrations/discord/test`, {}), onSuccess: (r) => toast(r.sent ? 'Teszt riasztás elküldve' : 'Nem ment ki (kikapcsolva vagy hibás webhook)', r.sent ? 'success' : 'error') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <section className="card">
      <h2>Discord riasztások</h2>
      <p className="muted small">A webhook URL titokként, titkosítva (AES-256-GCM) tárolódik és soha nem kerül vissza a böngészőbe. {q.data!.discord.configured ? <>Jelenlegi: <code>{q.data!.discord.hint}</code></> : 'Nincs beállítva.'}</p>
      <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Riasztások engedélyezése</label>
      <label className="field"><span>Minimális súlyosság</span><select value={form.minSeverity} onChange={(e) => setForm({ ...form, minSeverity: e.target.value })}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select></label>
      <label className="field"><span>Webhook URL {q.data!.discord.configured && '(üresen hagyva marad a jelenlegi)'}</span><input type="url" value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} placeholder="https://discord.com/api/webhooks/…" /></label>
      <FieldError error={save.error} />
      <div className="row"><button className="btn" disabled={test.isPending} onClick={() => test.mutate()}>Teszt küldése</button><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Mentés</button></div>
    </section>
  );
}

export function IntegrationsPage() {
  const can = useCan();
  return (
    <>
      <PageHeader title="API-kulcsok és integrációk" />
      {can('apikeys.manage') && <ApiKeys />}
      {can('integrations.manage') && <Discord />}
    </>
  );
}
