-- Rolls back 001_init. DESTROYS ALL DATA – take a backup first (see docs/BACKUP.md).
DROP TABLE IF EXISTS server_integrations, system_events, server_commands, server_config_history,
  server_configs, audit_logs, whitelist_entries, ban_detections, ban_identifiers, bans, detections,
  player_sessions, player_identifiers, players, api_keys, server_members, role_permissions, roles,
  sessions, user_identifiers, users, servers CASCADE;
DROP TYPE IF EXISTS severity;
