-- In-game admins identified by a FiveM identifier (license, discord, ...) instead of a web account.
-- They get the role's permissions in the game panel only; they cannot log in to the dashboard.
CREATE TABLE game_admins (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id        uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  identifier_type  text NOT NULL CHECK (identifier_type IN ('license','license2','fivem','discord','steam')),
  identifier_value text NOT NULL,
  name             text NOT NULL DEFAULT '',
  role_id          uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  note             text NOT NULL DEFAULT '',
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_label text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, identifier_type, identifier_value)
);

ALTER TABLE server_commands DROP CONSTRAINT server_commands_type_check;
ALTER TABLE server_commands ADD CONSTRAINT server_commands_type_check
  CHECK (type IN ('kick','ban_sync','config_sync','announce_admins','replay_request','admin_refresh'));
