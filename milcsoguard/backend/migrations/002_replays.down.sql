-- Rolls back 002_replays. Deletes every stored replay.
DELETE FROM server_commands WHERE type = 'replay_request';
ALTER TABLE server_commands DROP CONSTRAINT server_commands_type_check;
ALTER TABLE server_commands ADD CONSTRAINT server_commands_type_check
  CHECK (type IN ('kick','ban_sync','config_sync','announce_admins'));
ALTER TABLE servers ALTER COLUMN retention SET DEFAULT '{"detectionsDays":90,"auditDays":365,"systemEventsDays":30,"sessionsDays":90}';
UPDATE servers SET retention = retention - 'replaysDays';
DROP TABLE IF EXISTS replay_parts, replays;
