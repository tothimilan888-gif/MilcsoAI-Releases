import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, setCsrf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BRAND } from '../brand';
import { Logo } from '../components/Layout';
import { FieldError } from '../components/ui';

export function LoginPage() {
  const { me, refresh, loading } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const step = !me ? 'credentials' : me.mfaPending ? 'mfa' : me.mustChangePassword ? 'password' : 'done';
  useEffect(() => {
    if (step === 'done') nav(loc.state?.from && loc.state.from !== '/login' ? loc.state.from : '/', { replace: true });
  }, [step, nav, loc.state]);

  const run = (fn: () => Promise<unknown>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;
  return (
    <div className="login-wrap">
      <div className="login-card card">
        <div className="login-brand"><Logo size={40} /><div><div className="brand-name">{BRAND.name}</div><div className="brand-tag">{BRAND.tagline}</div></div></div>
        {step === 'credentials' && (
          <form onSubmit={run(async () => {
            const r = await api<{ csrfToken: string }>('POST', '/auth/login', { login, password });
            setCsrf(r.csrfToken);
          })}>
            <h1>Bejelentkezés</h1>
            <label className="field"><span>Felhasználónév vagy e-mail</span><input autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required /></label>
            <label className="field"><span>Jelszó</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            <FieldError error={error} />
            <button className="btn primary block" disabled={busy}>{busy ? 'Belépés…' : 'Belépés'}</button>
          </form>
        )}
        {step === 'mfa' && (
          <form onSubmit={run(() => api('POST', '/auth/mfa', { code }))}>
            <h1>Kétlépcsős azonosítás</h1>
            <p className="muted">Írd be a hitelesítő alkalmazásod 6 jegyű kódját.</p>
            <label className="field"><span>Kód</span><input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus /></label>
            <FieldError error={error} />
            <button className="btn primary block" disabled={busy || code.length !== 6}>Ellenőrzés</button>
          </form>
        )}
        {step === 'password' && (
          <form onSubmit={run(async () => {
            if (newPw !== newPw2) throw new Error('A két jelszó nem egyezik');
            await api('POST', '/auth/password', { currentPassword: password, newPassword: newPw });
          })}>
            <h1>Új jelszó beállítása</h1>
            <p className="muted">Az első belépéskor kötelező lecserélni az ideiglenes jelszót. Legalább 12 karakter, kis- és nagybetű, szám.</p>
            <label className="field"><span>Jelenlegi (ideiglenes) jelszó</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            <label className="field"><span>Új jelszó</span><input type="password" autoComplete="new-password" minLength={12} value={newPw} onChange={(e) => setNewPw(e.target.value)} required /></label>
            <label className="field"><span>Új jelszó újra</span><input type="password" autoComplete="new-password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} required /></label>
            <FieldError error={error} />
            <button className="btn primary block" disabled={busy}>Mentés</button>
          </form>
        )}
      </div>
    </div>
  );
}
