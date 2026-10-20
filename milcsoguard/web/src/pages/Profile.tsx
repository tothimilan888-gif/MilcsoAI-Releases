import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtRelative } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, ErrorState, FieldError, Loading } from '../components/ui';
import { Logo } from '../components/Layout';

function PasswordCard() {
  const toast = useToast();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', again: '' });
  const m = useMutation({
    mutationFn: () => {
      if (f.newPassword !== f.again) throw new Error('A két jelszó nem egyezik');
      return api('POST', '/auth/password', { currentPassword: f.currentPassword, newPassword: f.newPassword });
    },
    onSuccess: () => { toast('Jelszó módosítva – a többi munkamenet kijelentkeztetve', 'success'); setF({ currentPassword: '', newPassword: '', again: '' }); },
  });
  return (
    <section className="card">
      <h2>Jelszó</h2>
      <label className="field"><span>Jelenlegi jelszó</span><input type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></label>
      <label className="field"><span>Új jelszó (min. 12, kis/nagybetű, szám)</span><input type="password" autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></label>
      <label className="field"><span>Új jelszó újra</span><input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></label>
      <FieldError error={m.error} />
      <div className="row"><button className="btn primary" disabled={m.isPending || !f.currentPassword || !f.newPassword} onClick={() => m.mutate()}>Jelszó módosítása</button></div>
    </section>
  );
}

function TotpCard() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const start = useMutation({ mutationFn: () => api<{ secret: string; uri: string }>('POST', '/auth/totp/setup', {}), onSuccess: setSetup });
  const enable = useMutation({ mutationFn: () => api('POST', '/auth/totp/enable', { code }), onSuccess: async () => { toast('Kétlépcsős azonosítás bekapcsolva', 'success'); setSetup(null); setCode(''); await refresh(); } });
  const disable = useMutation({ mutationFn: () => api('POST', '/auth/totp/disable', { password: pw, code }), onSuccess: async () => { toast('Kétlépcsős azonosítás kikapcsolva', 'success'); setCode(''); setPw(''); await refresh(); } });
  return (
    <section className="card">
      <h2>Kétlépcsős azonosítás (TOTP)</h2>
      {me?.user.totpEnabled ? (
        <>
          <p><Badge tone="ok">bekapcsolva</Badge></p>
          <p className="muted small">Kikapcsoláshoz add meg a jelszavad és egy aktuális kódot.</p>
          <label className="field"><span>Jelszó</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <label className="field"><span>Kód</span><input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
          <FieldError error={disable.error} />
          <div className="row"><button className="btn danger" disabled={disable.isPending || code.length !== 6 || !pw} onClick={() => disable.mutate()}>Kikapcsolás</button></div>
        </>
      ) : setup ? (
        <>
          <p className="muted small">Add hozzá a hitelesítő alkalmazásodhoz (Google Authenticator, Aegis, 1Password…) a kulccsal vagy az otpauth URI-val, majd írd be az első kódot.</p>
          <label className="field"><span>Titkos kulcs</span><pre className="json secret">{setup.secret.match(/.{1,4}/g)?.join(' ')}</pre></label>
          <label className="field"><span>otpauth URI</span><pre className="json small">{setup.uri}</pre></label>
          <label className="field"><span>Kód</span><input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus /></label>
          <FieldError error={enable.error} />
          <div className="row"><button className="btn ghost" onClick={() => setSetup(null)}>Mégse</button><button className="btn primary" disabled={code.length !== 6 || enable.isPending} onClick={() => enable.mutate()}>Bekapcsolás</button></div>
        </>
      ) : (
        <>
          <p><Badge tone="warn">kikapcsolva</Badge> <span className="muted small">Adminfiókoknál erősen ajánlott.</span></p>
          <FieldError error={start.error} />
          <div className="row"><button className="btn primary" onClick={() => start.mutate()}>Beállítás</button></div>
        </>
      )}
    </section>
  );
}

function SessionsCard() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ items: { id: string; ip: string; user_agent: string; created_at: string; last_seen_at: string; current: boolean }[] }>('GET', '/auth/sessions') });
  const revoke = useMutation({ mutationFn: (id: string) => api('DELETE', `/auth/sessions/${id}`), onSuccess: () => { toast('Munkamenet megszüntetve', 'success'); void q.refetch(); } });
  return (
    <section className="card">
      <h2>Aktív munkamenetek</h2>
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (
        <table><tbody>{q.data!.items.map((s) => (
          <tr key={s.id}><td><div className="small">{s.user_agent.slice(0, 70) || 'ismeretlen kliens'}</div><div className="muted small">{s.ip} · létrehozva {fmtDate(s.created_at)} · aktív {fmtRelative(s.last_seen_at)}</div></td>
            <td className="actions">{s.current ? <Badge tone="accent">ez</Badge> : <button className="btn sm" onClick={() => revoke.mutate(s.id)}>Kijelentkeztetés</button>}</td></tr>
        ))}</tbody></table>
      )}
    </section>
  );
}

function IdentifiersCard() {
  const toast = useToast();
  const [value, setValue] = useState('');
  const q = useQuery({ queryKey: ['my-identifiers'], queryFn: () => api<{ items: { identifier: string; created_at: string }[] }>('GET', '/auth/identifiers') });
  const add = useMutation({ mutationFn: () => api('POST', '/auth/identifiers', { identifier: value.trim() }), onSuccess: () => { setValue(''); toast('Azonosító hozzákötve', 'success'); void q.refetch(); } });
  const del = useMutation({ mutationFn: (i: string) => api('DELETE', `/auth/identifiers/${encodeURIComponent(i)}`), onSuccess: () => void q.refetch() });
  return (
    <section className="card">
      <h2>Kötött FiveM azonosítók</h2>
      <p className="muted small">Ha a játékban ezzel az azonosítóval csatlakozol, a szerver a webes szerepköröd szerint ad jogot a játékon belüli panelhez – és a backend minden játékon belüli műveletedet ennek alapján is ellenőrzi.</p>
      {q.data?.items.length ? <ul className="plain">{q.data.items.map((i) => <li key={i.identifier}><code>{i.identifier}</code> <button className="btn sm ghost" onClick={() => del.mutate(i.identifier)}>Eltávolítás</button></li>)}</ul> : <p className="muted">Nincs kötött azonosító.</p>}
      <div className="filters"><input placeholder="license:… vagy discord:…" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Azonosító" /><button className="btn" disabled={!value.trim()} onClick={() => add.mutate()}>Hozzáadás</button></div>
      <FieldError error={add.error} />
    </section>
  );
}

export function ProfilePage() {
  const { me } = useAuth();
  return (
    <div className="standalone">
      <header className="standalone-head"><Link to="/" className="brand-link"><Logo /> Vissza a dashboardra</Link></header>
      <h1>Profil és biztonság</h1>
      <p className="muted">{me?.user.username} · {me?.user.email}{me?.user.isPlatformAdmin && <> · <Badge tone="accent">platform admin</Badge></>}</p>
      <div className="grid two">
        <PasswordCard />
        <TotpCard />
        <SessionsCard />
        <IdentifiersCard />
      </div>
    </div>
  );
}
