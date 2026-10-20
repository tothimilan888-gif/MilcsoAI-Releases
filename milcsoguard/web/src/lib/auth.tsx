import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, onUnauthorized, setCsrf } from './api';
import type { Me } from './types';

interface AuthValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthValue>({ me: null, loading: true, refresh: async () => undefined, logout: async () => undefined });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await api<Me>('GET', '/auth/me');
        setCsrf(me.csrfToken);
        return me;
      } catch (e) {
        if ((e as { status?: number }).status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => onUnauthorized(() => qc.setQueryData(['me'], null)), [qc]);
  const logout = useCallback(async () => {
    await api('POST', '/auth/logout', {}).catch(() => undefined);
    setCsrf('');
    // Keep the 'me' query (its observer drives routing); drop every other cached server response.
    qc.setQueryData(['me'], null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  }, [qc]);
  const value = useMemo(() => ({ me: q.data ?? null, loading: q.isLoading, refresh: () => q.refetch(), logout }), [q, logout]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
