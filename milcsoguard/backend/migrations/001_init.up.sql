-- MilcsoGuard initial schema (PostgreSQL 14+)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- tenants
CREATE TABLE servers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 64),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  description      text NOT NULL DEFAULT '',
  -- identifier types used to match bans on connect (configurable per server)
  ban_match_types  text[] NOT NULL DEFAULT ARRAY['license','license2','discord','fivem','steam','xbl','live'],
  retention        jsonb NOT NULL DEFAULT '{"detectionsDays":90,"auditDays":365,"systemEventsDays":30,"sessionsDays":90}',
  status_info      jsonb NOT NULL DEFAULT '{}',
  last_heartbeat_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

-- ---------------------------------------------------------------- users & auth
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL,
  username            text NOT NULL CHECK (char_length(username) BETWEEN 2 AND 32),
  password_hash       text NOT NULL,
  is_platform_admin   boolean NOT NULL DEFAULT false,
  totp_secret_enc     text,
  totp_enabled        boolean NOT NULL DEFAULT false,
  failed_logins       integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  disabled_at         timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));

-- FiveM identifiers linked to a web account (used to resolve in-game admin rights)
CREATE TABLE user_identifiers (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (type, value)
);
CREATE INDEX user_identifiers_user_idx ON user_identifiers (user_id);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  csrf_token   text NOT NULL,
  mfa_passed   boolean NOT NULL DEFAULT false,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------- RBAC
CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   uuid REFERENCES servers(id) ON DELETE CASCADE,  -- NULL = built-in system role
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  name        text NOT NULL,
  level       integer NOT NULL CHECK (level BETWEEN 1 AND 100),
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_system_key_uq ON roles (key) WHERE server_id IS NULL;
CREATE UNIQUE INDEX roles_server_key_uq ON roles (server_id, key) WHERE server_id IS NOT NULL;

CREATE TABLE role_permissions (
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE server_members (
  server_id  uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  added_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX server_members_user_idx ON server_members (user_id);

-- ---------------------------------------------------------------- API keys
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id    uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  prefix       text NOT NULL UNIQUE,
  key_hash     text NOT NULL,
  scopes       text[] NOT NULL DEFAULT ARRAY['game'],
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  last_used_ip text,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  rotated_from uuid REFERENCES api_keys(id) ON DELETE SET NULL
);
CREATE INDEX api_keys_server_idx ON api_keys (server_id);

-- ---------------------------------------------------------------- players
CREATE TABLE players (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  last_name   text NOT NULL DEFAULT '',
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  notes       text NOT NULL DEFAULT '',
  total_playtime_seconds bigint NOT NULL DEFAULT 0
);
CREATE INDEX players_server_seen_idx ON players (server_id, last_seen DESC);
CREATE INDEX players_name_idx ON players (server_id, lower(last_name));

CREATE TABLE player_identifiers (
  server_id   uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  player_id   uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type        text NOT NULL,
  value       text NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, type, value)
);
CREATE INDEX player_identifiers_player_idx ON player_identifiers (player_id);

CREATE TABLE player_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id         uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  player_id         uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  net_id            integer NOT NULL,
  name              text NOT NULL DEFAULT '',
  connected_at      timestamptz NOT NULL DEFAULT now(),
  disconnected_at   timestamptz,
  disconnect_reason text,
  last_ping         integer,
  risk_score        integer NOT NULL DEFAULT 0,
  monitored         boolean NOT NULL DEFAULT false
);
CREATE INDEX player_sessions_online_idx ON player_sessions (server_id) WHERE disconnected_at IS NULL;
CREATE INDEX player_sessions_player_idx ON player_sessions (player_id, connected_at DESC);

-- ---------------------------------------------------------------- detections
CREATE TYPE severity AS ENUM ('INFO','LOW','MEDIUM','HIGH','CRITICAL');

CREATE TABLE detections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id       uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  local_id        text NOT NULL,
  player_id       uuid REFERENCES players(id) ON DELETE SET NULL,
  player_name     text NOT NULL DEFAULT '',
  net_id          integer,
  identifiers     jsonb NOT NULL DEFAULT '[]',
  type            text NOT NULL,
  module          text NOT NULL,
  severity        severity NOT NULL,
  risk_score      integer NOT NULL DEFAULT 0 CHECK (risk_score >= 0),
  source          text NOT NULL CHECK (source IN ('server','client','event','resource','system')),
  evidence        jsonb NOT NULL DEFAULT '{}',
  action          text NOT NULL CHECK (action IN ('log','warn','monitor','kick','ban')),
  action_result   text NOT NULL DEFAULT '',
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  review_status   text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','confirmed','false_positive','dismissed')),
  reviewed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_label text,
  reviewed_at     timestamptz,
  review_note     text,
  UNIQUE (server_id, local_id)
);
CREATE INDEX detections_server_time_idx ON detections (server_id, occurred_at DESC);
CREATE INDEX detections_player_idx ON detections (player_id, occurred_at DESC);
CREATE INDEX detections_server_type_idx ON detections (server_id, type);
CREATE INDEX detections_server_review_idx ON detections (server_id, review_status) WHERE review_status = 'pending';

-- ---------------------------------------------------------------- bans
CREATE TABLE bans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id         uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  local_id          text,
  public_code       text NOT NULL,
  player_id         uuid REFERENCES players(id) ON DELETE SET NULL,
  player_name       text NOT NULL DEFAULT '',
  reason            text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  source            text NOT NULL CHECK (source IN ('web','ingame','system')),
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_label  text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,              -- NULL = permanent
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_by_label  text,
  revoke_reason     text,
  review_status     text NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','under_review','upheld','overturned')),
  review_note       text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);
CREATE UNIQUE INDEX bans_local_uq ON bans (server_id, local_id) WHERE local_id IS NOT NULL;
CREATE UNIQUE INDEX bans_code_uq ON bans (server_id, public_code);
CREATE INDEX bans_server_status_idx ON bans (server_id, status, created_at DESC);
CREATE INDEX bans_updated_idx ON bans (server_id, updated_at);
CREATE INDEX bans_player_idx ON bans (player_id);

CREATE TABLE ban_identifiers (
  ban_id    uuid NOT NULL REFERENCES bans(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  type      text NOT NULL,
  value     text NOT NULL,
  PRIMARY KEY (ban_id, type, value)
);
CREATE INDEX ban_identifiers_lookup_idx ON ban_identifiers (server_id, type, value);

CREATE TABLE ban_detections (
  ban_id       uuid NOT NULL REFERENCES bans(id) ON DELETE CASCADE,
  detection_id uuid NOT NULL REFERENCES detections(id) ON DELETE CASCADE,
  PRIMARY KEY (ban_id, detection_id)
);

-- ---------------------------------------------------------------- whitelist
CREATE TABLE whitelist_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('player','resource','model')),
  value       text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 128),
  modules     text[] NOT NULL DEFAULT '{}',   -- empty = all modules
  note        text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_label text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, kind, value)
);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  server_id     uuid REFERENCES servers(id) ON DELETE CASCADE,
  actor_type    text NOT NULL CHECK (actor_type IN ('user','game_admin','system','api_key')),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_label   text NOT NULL,
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  details       jsonb NOT NULL DEFAULT '{}',
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_server_time_idx ON audit_logs (server_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (server_id, action);

-- ---------------------------------------------------------------- configuration
CREATE TABLE server_configs (
  server_id   uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  version     integer NOT NULL DEFAULT 0,
  overrides   jsonb NOT NULL DEFAULT '{}',
  schema      jsonb,              -- reported by the game resource on handshake
  effective   jsonb,              -- effective config reported by the game resource
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE server_config_history (
  id          bigserial PRIMARY KEY,
  server_id   uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  overrides   jsonb NOT NULL,
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_by_label text NOT NULL,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, version)
);

-- ---------------------------------------------------------------- web -> game commands
CREATE TABLE server_commands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('kick','ban_sync','config_sync','announce_admins')),
  payload     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','done','failed','expired')),
  result      text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  completed_at timestamptz,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX server_commands_pending_idx ON server_commands (server_id, created_at) WHERE status IN ('pending','delivered');

-- ---------------------------------------------------------------- system events
CREATE TABLE system_events (
  id         bigserial PRIMARY KEY,
  server_id  uuid REFERENCES servers(id) ON DELETE CASCADE,
  type       text NOT NULL,
  severity   severity NOT NULL DEFAULT 'INFO',
  message    text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_events_server_time_idx ON system_events (server_id, created_at DESC);

-- ---------------------------------------------------------------- integrations
CREATE TABLE server_integrations (
  server_id             uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  discord_webhook_enc   text,
  discord_enabled       boolean NOT NULL DEFAULT false,
  discord_min_severity  severity NOT NULL DEFAULT 'HIGH',
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
