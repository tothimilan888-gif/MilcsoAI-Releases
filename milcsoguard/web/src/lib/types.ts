export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export const SEVERITIES: Severity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }

export interface ServerAccess { id: string; name: string; slug: string; role: { key: string; name: string; level: number }; permissions: string[] }
export interface Me {
  user: { id: string; email: string; username: string; isPlatformAdmin: boolean; totpEnabled: boolean };
  mfaPending: boolean;
  mustChangePassword: boolean;
  csrfToken: string;
  servers: ServerAccess[];
}

export interface Detection {
  id: string; local_id: string; player_id: string | null; player_name: string; net_id: number | null; identifiers: string[];
  type: string; module: string; severity: Severity; risk_score: number; source: string; evidence: Record<string, unknown>;
  action: string; action_result: string; occurred_at: string; received_at: string; review_status: string;
  reviewed_by_label: string | null; reviewed_at: string | null; review_note: string | null;
}

export interface Ban {
  id: string; public_code: string; player_id: string | null; player_name: string; reason: string; source: string;
  created_by_label: string; created_at: string; expires_at: string | null; status: 'active' | 'expired' | 'revoked';
  revoked_at: string | null; revoked_by_label: string | null; revoke_reason: string | null; review_status: string; review_note: string | null;
  identifiers: string[];
}

export interface Player { id: string; last_name: string; first_seen: string; last_seen: string; detections: number; active_bans: number; online: boolean }

export interface OnlinePlayer { session_id: string; player_id: string; net_id: number; name: string; connected_at: string; last_ping: number | null; risk_score: number; monitored: boolean; session_detections: number }

export interface WhitelistEntry { id: string; kind: 'player' | 'resource' | 'model'; value: string; modules: string[]; note: string; created_by_label: string; created_at: string; expires_at: string | null; expired?: boolean }

export interface AuditEntry { id: number; actor_type: string; actor_label: string; action: string; target_type: string | null; target_id: string | null; details: Record<string, unknown>; ip: string | null; created_at: string }

export interface Role { id: string; key: string; name: string; level: number; is_system: boolean; server_id: string | null; permissions: string[]; assignable: boolean }
export interface Member { user_id: string; username: string; email?: string; totp_enabled: boolean; last_login_at: string | null; role_id: string; role_key: string; role_name: string; level: number; identifiers: string[]; manageable: boolean }

export interface ParamSpec { type: 'number' | 'integer' | 'boolean' | 'enum' | 'list'; label: string; unit?: string; min?: number; max?: number; values?: string[]; maxItems?: number; default: unknown }
export interface ModuleSpec { label: string; category: string; description: string; limitations: string; source: string; defaults: { enabled: boolean; action: string; severity: string }; params: Record<string, ParamSpec> }
export interface ConfigSchema { version: number; actions: string[]; severities: string[]; modules: Record<string, ModuleSpec>; risk: Record<string, ParamSpec> }
export interface ModuleOverride { enabled?: boolean; action?: string; severity?: string; params?: Record<string, unknown> }
export interface Overrides { modules?: Record<string, ModuleOverride>; risk?: Record<string, unknown> }
