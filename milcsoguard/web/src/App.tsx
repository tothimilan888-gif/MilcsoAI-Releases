import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ServerLayout } from './components/Layout';
import { Loading } from './components/ui';
import { useAuth } from './lib/auth';
import { ServerProvider, useCan } from './lib/server';
import { LoginPage } from './pages/Login';
import { HomePage, NewServerPage } from './pages/Home';
import { DashboardPage } from './pages/Dashboard';
import { DetectionsPage } from './pages/Detections';
import { PlayersPage, PlayerProfilePage } from './pages/Players';
import { BansPage } from './pages/Bans';
import { WhitelistPage } from './pages/Whitelist';
import { AdminsPage } from './pages/Admins';
import { AuditPage } from './pages/Audit';
import { AnalyticsPage } from './pages/Analytics';
import { SystemPage } from './pages/System';
import { ConfigPage } from './pages/Config';
import { IntegrationsPage } from './pages/Integrations';
import { ServerSettingsPage } from './pages/ServerSettings';
import { ProfilePage } from './pages/Profile';
import { useParams } from 'react-router-dom';

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="center"><Loading /></div>;
  if (!me || me.mfaPending || me.mustChangePassword) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

function ServerGate() {
  const { me } = useAuth();
  const { serverId } = useParams();
  if (!me?.servers.some((s) => s.id === serverId)) return <Navigate to="/" replace />;
  return (
    <ServerProvider>
      <ServerLayout />
    </ServerProvider>
  );
}

/** Hides pages the role cannot use (cosmetic – the API returns 403 regardless). */
function Perm({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const can = useCan();
  const list = Array.isArray(perm) ? perm : [perm];
  if (!list.some(can)) return <div className="card"><strong>Nincs jogosultságod ehhez az oldalhoz.</strong> <span className="muted">Szükséges: {list.join(' vagy ')}</span></div>;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
      <Route path="/servers/new" element={<RequireAuth><NewServerPage /></RequireAuth>} />
      <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
      <Route path="/s/:serverId" element={<RequireAuth><ServerGate /></RequireAuth>}>
        <Route index element={<Perm perm="detections.view"><DashboardPage /></Perm>} />
        <Route path="detections" element={<Perm perm="detections.view"><DetectionsPage /></Perm>} />
        <Route path="players" element={<Perm perm="players.view"><PlayersPage /></Perm>} />
        <Route path="players/:playerId" element={<Perm perm="players.view"><PlayerProfilePage /></Perm>} />
        <Route path="bans" element={<Perm perm="bans.view"><BansPage /></Perm>} />
        <Route path="whitelist" element={<Perm perm="whitelist.view"><WhitelistPage /></Perm>} />
        <Route path="admins" element={<Perm perm="admins.view"><AdminsPage /></Perm>} />
        <Route path="audit" element={<Perm perm="audit.view"><AuditPage /></Perm>} />
        <Route path="analytics" element={<Perm perm="analytics.view"><AnalyticsPage /></Perm>} />
        <Route path="system" element={<Perm perm="system.view"><SystemPage /></Perm>} />
        <Route path="config" element={<Perm perm="settings.view"><ConfigPage /></Perm>} />
        <Route path="integrations" element={<Perm perm={['apikeys.manage', 'integrations.manage']}><IntegrationsPage /></Perm>} />
        <Route path="server" element={<Perm perm="servers.manage"><ServerSettingsPage /></Perm>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
