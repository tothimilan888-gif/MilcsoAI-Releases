import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { BRAND } from '../brand';
import { useAuth } from '../lib/auth';
import { useCan, useServer } from '../lib/server';
import { useLiveEvents } from '../lib/live';
import { useToast } from '../lib/toast';

const I = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: d }} />;
const ICON = {
  dash: I('<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>'),
  live: I('<path d="M12 2 2 20h20L12 2zM12 9v5M12 17.5v.5"/>'),
  players: I('<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M16 4a4 4 0 0 1 0 8M22 21c0-3-1.5-5-4-5.6"/>'),
  bans: I('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'),
  wl: I('<path d="M12 2 4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z"/><path d="m8.5 12 2.5 2.5L16 9.5"/>'),
  admins: I('<circle cx="12" cy="7" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>'),
  audit: I('<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h8"/>'),
  analytics: I('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>'),
  system: I('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  config: I('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  keys: I('<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/>'),
  server: I('<rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/><path d="M7 6.5h.01M7 17.5h.01"/>'),
};

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <path d="M16 2 4 7v8c0 7.2 5.1 13.4 12 15 6.9-1.6 12-7.8 12-15V7L16 2z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M10.5 16.5 14.5 20.5 22 12" fill="none" stroke="var(--accent2)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ServerLayout() {
  const server = useServer();
  const can = useCan();
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const { serverId } = useParams();
  const [open, setOpen] = useState(false);
  const live = useLiveEvents(server.id, (e) => {
    if (e.type === 'detection.created') {
      const sev = String(e.data.severity);
      if (sev === 'HIGH' || sev === 'CRITICAL') toast(`${sev}: ${e.data.type} – ${e.data.player}`, 'error');
    }
  });
  const base = `/s/${serverId}`;
  const items: [string, string, ReactNode, boolean][] = [
    ['', 'Dashboard', ICON.dash, can('detections.view')],
    ['/detections', 'Élő detektálások', ICON.live, can('detections.view')],
    ['/players', 'Játékosok', ICON.players, can('players.view')],
    ['/bans', 'Banok', ICON.bans, can('bans.view')],
    ['/whitelist', 'Whitelist', ICON.wl, can('whitelist.view')],
    ['/admins', 'Adminok', ICON.admins, can('admins.view')],
    ['/audit', 'Auditnapló', ICON.audit, can('audit.view')],
    ['/analytics', 'Statisztika', ICON.analytics, can('analytics.view')],
    ['/system', 'Rendszerállapot', ICON.system, can('system.view')],
    ['/config', 'Anticheat beállítások', ICON.config, can('settings.view')],
    ['/integrations', 'API-kulcsok és integrációk', ICON.keys, can('apikeys.manage') || can('integrations.manage')],
    ['/server', 'Szerver', ICON.server, can('servers.manage')],
  ];
  return (
    <div className={`app ${open ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand"><Logo /><div><div className="brand-name">{BRAND.name}</div><div className="brand-tag">{BRAND.tagline}</div></div></div>
        <nav aria-label="Fő navigáció">
          {items.filter((i) => i[3]).map(([path, label, icon]) => (
            <NavLink key={path} to={base + path} end={path === ''} onClick={() => setOpen(false)}>{icon}<span>{label}</span></NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="chip">{server.role.name} · {server.role.level}</span>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Menü">☰</button>
          <select className="server-switch" value={server.id} onChange={(e) => nav(`/s/${e.target.value}`)} aria-label="Szerver választó">
            {me?.servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {me?.user.isPlatformAdmin && <NavLink to="/servers/new" className="btn ghost sm">+ Szerver</NavLink>}
          <div className="spacer" />
          <span className={`live ${live ? 'on' : ''}`} title={live ? 'Valós idejű kapcsolat aktív' : 'Valós idejű kapcsolat nincs'}><i />{live ? 'Élő' : 'Offline'}</span>
          <NavLink to="/profile" className="user">{me?.user.username}</NavLink>
          <button className="btn ghost sm" onClick={() => void logout().then(() => nav('/login'))}>Kilépés</button>
        </header>
        <main className="content" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{subtitle && <p className="muted">{subtitle}</p>}</div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
