DELETE FROM server_commands WHERE type = 'admin_refresh';
ALTER TABLE server_commands DROP CONSTRAINT server_commands_type_check;
ALTER TABLE server_commands ADD CONSTRAINT server_commands_type_check
  CHECK (type IN ('kick','ban_sync','config_sync','announce_admins','replay_request'));
DROP TABLE IF EXISTS game_admins;
