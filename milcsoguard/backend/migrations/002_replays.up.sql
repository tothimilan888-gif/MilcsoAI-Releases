-- POV replays: the last seconds of a player's game view, recorded on their client and uploaded
-- through the game server (the client never talks to the backend).
CREATE TABLE replays (
  id                 uuid PRIMARY KEY,
  server_id          uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  player_id          uuid REFERENCES players(id) ON DELETE SET NULL,
  player_name        text NOT NULL DEFAULT '',
  kind               text NOT NULL CHECK (kind IN ('ban','manual')),
  status             text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','uploading','ready','failed')),
  error              text,
  reason             text NOT NULL DEFAULT '',
  ban_id             uuid REFERENCES bans(id) ON DELETE SET NULL,
  ban_local_id       text,
  requested_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_by_label text NOT NULL DEFAULT '',
  mime               text NOT NULL DEFAULT 'video/webm',
  width              integer,
  height             integer,
  fps                integer,
  duration_ms        integer NOT NULL DEFAULT 0,
  size_bytes         integer NOT NULL DEFAULT 0,
  part_count         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
CREATE INDEX replays_server_idx ON replays (server_id, created_at DESC);
CREATE INDEX replays_ban_idx ON replays (ban_id) WHERE ban_id IS NOT NULL;
CREATE INDEX replays_ban_local_idx ON replays (server_id, ban_local_id) WHERE ban_local_id IS NOT NULL;
CREATE INDEX replays_player_idx ON replays (player_id, created_at DESC);

-- Each part is a self-contained WebM file (the recorder restarts every few seconds), played in order.
CREATE TABLE replay_parts (
  replay_id   uuid NOT NULL REFERENCES replays(id) ON DELETE CASCADE,
  idx         smallint NOT NULL CHECK (idx BETWEEN 0 AND 15),
  duration_ms integer NOT NULL DEFAULT 0,
  size_bytes  integer NOT NULL,
  data        bytea NOT NULL,
  PRIMARY KEY (replay_id, idx)
);
-- Video is already compressed: skip TOAST compression attempts.
ALTER TABLE replay_parts ALTER COLUMN data SET STORAGE EXTERNAL;

ALTER TABLE server_commands DROP CONSTRAINT server_commands_type_check;
ALTER TABLE server_commands ADD CONSTRAINT server_commands_type_check
  CHECK (type IN ('kick','ban_sync','config_sync','announce_admins','replay_request'));

UPDATE servers SET retention = retention || '{"replaysDays":30}' WHERE NOT retention ? 'replaysDays';
ALTER TABLE servers ALTER COLUMN retention SET DEFAULT '{"detectionsDays":90,"auditDays":365,"systemEventsDays":30,"sessionsDays":90,"replaysDays":30}';
