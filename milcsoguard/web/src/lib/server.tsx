import { createContext, useContext, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from './auth';
import type { ServerAccess } from './types';

const ServerCtx = createContext<ServerAccess | null>(null);

export function ServerProvider({ children }: { children: ReactNode }) {
  const { serverId } = useParams();
  const { me } = useAuth();
  const server = me?.servers.find((s) => s.id === serverId) ?? null;
  return <ServerCtx.Provider value={server}>{children}</ServerCtx.Provider>;
}

export function useServer(): ServerAccess {
  const s = useContext(ServerCtx);
  if (!s) throw new Error('useServer outside a server route');
  return s;
}

/** UI-only permission check. The backend enforces every permission independently. */
export function useCan() {
  const s = useContext(ServerCtx);
  return (perm: string) => !!s && s.permissions.includes(perm);
}
