import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export interface LiveEvent { type: string; data: Record<string, unknown>; at: number }

const INVALIDATE: Record<string, string[]> = {
  'detection.created': ['detections', 'stats', 'analytics', 'player'],
  'detection.reviewed': ['detections', 'stats', 'player'],
  'ban.created': ['bans', 'stats', 'player'],
  'ban.revoked': ['bans', 'stats', 'player'],
  'players.changed': ['online', 'players', 'stats'],
  'server.status': ['system', 'stats', 'online'],
  'config.changed': ['config'],
  'whitelist.changed': ['whitelist'],
};

/**
 * Subscribes to the server's Server-Sent Events stream. EventSource reconnects automatically;
 * received events invalidate the matching queries so lists refresh without polling.
 */
export function useLiveEvents(serverId: string, onEvent?: (e: LiveEvent) => void) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    const es = new EventSource(`/api/v1/servers/${serverId}/stream`, { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const handler = (type: string) => (msg: MessageEvent) => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(msg.data); } catch { /* ignore */ }
      for (const key of INVALIDATE[type] ?? []) void qc.invalidateQueries({ queryKey: [key, serverId] });
      cb.current?.({ type, data, at: Date.now() });
    };
    const types = Object.keys(INVALIDATE);
    const listeners = types.map((t) => [t, handler(t)] as const);
    for (const [t, l] of listeners) es.addEventListener(t, l as EventListener);
    return () => {
      for (const [t, l] of listeners) es.removeEventListener(t, l as EventListener);
      es.close();
    };
  }, [serverId, qc]);
  return connected;
}
