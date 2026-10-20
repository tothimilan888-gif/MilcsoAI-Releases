import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { FieldError } from '../components/ui';
import { Logo } from '../components/Layout';

export function HomePage() {
  const { me } = useAuth();
  if (me?.servers.length) return <Navigate to={`/s/${me.servers[0]!.id}`} replace />;
  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="login-brand"><Logo size={36} /><h1>Még nincs szerver</h1></div>
        {me?.user.isPlatformAdmin ? (
          <p>Hozd létre az első szervert, majd generálj hozzá API-kulcsot a FiveM resource számára. <a href="/servers/new">Szerver létrehozása →</a></p>
        ) : (
          <p className="muted">A fiókod még egy szerverhez sincs hozzárendelve. Kérd meg a szerver tulajdonosát, hogy adjon hozzá.</p>
        )}
        <p><a href="/profile">Profil és biztonság</a></p>
      </div>
    </div>
  );
}

export function NewServerPage() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<unknown>(null);
  if (!me?.user.isPlatformAdmin) return <Navigate to="/" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ server: { id: string } }>('POST', '/servers', { name, slug });
      await refresh();
      nav(`/s/${r.server.id}/integrations`);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>Új szerver</h1>
        <p className="muted">Minden szerver adatai (játékosok, banok, detektálások, napló) szigorúan elkülönülnek.</p>
        <label className="field"><span>Név</span><input value={name} onChange={(e) => { setName(e.target.value); setSlug(e.target.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)); }} required minLength={2} maxLength={64} /></label>
        <label className="field"><span>Azonosító (slug)</span><input value={slug} onChange={(e) => setSlug(e.target.value)} pattern="[a-z0-9][a-z0-9-]{1,47}" required /></label>
        <FieldError error={error} />
        <div className="row"><button type="button" className="btn ghost" onClick={() => nav(-1)}>Mégse</button><button className="btn primary">Létrehozás</button></div>
      </form>
    </div>
  );
}
