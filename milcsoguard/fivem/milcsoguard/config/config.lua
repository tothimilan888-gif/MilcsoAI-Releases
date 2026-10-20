--[[
  MilcsoGuard – server configuration (server_scripts only; never sent to clients).

  SECRETS DO NOT BELONG HERE. Put them in server.cfg as *server-only* convars:
      set milcsoguard_api_url "https://ac.example.com"
      set milcsoguard_api_key "mgk_xxxxxxxxxx_..."
  Use `set`, never `setr` (setr replicates the value to every client).

  Module thresholds/actions are defined in server/core/schema.lua (defaults) and can be overridden
  below (Config.Modules) or remotely from the web dashboard. Remote overrides cannot change
  anything in this file other than module settings and risk settings.
]]

Config = {}

Config.Brand = 'MilcsoGuard'
Config.Debug = GetConvar('milcsoguard_debug', 'false') == 'true'

-- 'auto' | 'esx' | 'qbcore' | 'standalone'
Config.Framework = 'auto'

Config.Api = {
    enabled = true,
    url = GetConvar('milcsoguard_api_url', ''),
    -- Plain http is only accepted for 127.0.0.1/localhost (local development).
    allowInsecureLocalhost = true,
    timeoutMs = 8000,
    heartbeatSeconds = 30,
    commandPollSeconds = 5,
    banSyncSeconds = 60,
    configSyncSeconds = 120,
    flushSeconds = 5,
    maxQueue = 2000,
    -- Identifier types that are never sent to the backend.
    excludeIdentifierTypes = { 'ip' },
}

Config.Permissions = {
    -- Where in-game admin rights come from, highest role wins. The client never decides.
    sources = { 'ace', 'framework', 'backend' },
    -- ACE: `add_ace group.admin milcsoguard.role.administrator allow`
    --      or single permissions: `add_ace identifier.license:xxx milcsoguard.perm.bans.create allow`
    acePrefix = 'milcsoguard',
    framework = {
        esx = { superadmin = 'owner', admin = 'administrator', mod = 'moderator' },
        -- QBCore permissions are ACE based (QBCore.Functions.HasPermission)
        qbcore = { god = 'developer', admin = 'administrator', mod = 'moderator' },
    },
    -- Admins at or above this level skip the listed modules (noclip/godmode admin tools).
    bypass = {
        minLevel = 60,
        modules = { 'movement.teleport', 'movement.speed', 'movement.noclip', 'movement.vehicle_speed', 'movement.superjump', 'player.godmode', 'player.invisible', 'client.spectate', 'player.health' },
    },
    command = 'anticheat',
    keybind = '', -- e.g. 'F10' (empty = no keybind)
}

-- Role hierarchy mirrored from the backend defaults. Used for ACE/framework sourced admins.
Config.Roles = {
    owner = { level = 100, label = 'Owner', permissions = { '*' } },
    developer = { level = 90, label = 'Developer', permissions = { '*', '-servers.manage' } },
    server_manager = { level = 80, label = 'Server Manager', permissions = { '*', '-servers.manage', '-apikeys.manage', '-roles.manage' } },
    admin_controller = { level = 70, label = 'AdminController', permissions = { 'players.view', 'players.identifiers', 'players.kick', 'detections.view', 'detections.review', 'bans.view', 'bans.create', 'bans.permanent', 'bans.remove', 'whitelist.view', 'whitelist.manage', 'admins.view', 'admins.manage', 'settings.view', 'audit.view', 'analytics.view', 'system.view' } },
    administrator = { level = 60, label = 'Administrator', permissions = { 'players.view', 'players.identifiers', 'players.kick', 'detections.view', 'detections.review', 'bans.view', 'bans.create', 'bans.permanent', 'bans.remove', 'whitelist.view', 'whitelist.manage', 'settings.view', 'analytics.view', 'system.view' } },
    moderator = { level = 40, label = 'Moderator', permissions = { 'players.view', 'players.kick', 'detections.view', 'detections.review', 'bans.view', 'bans.create', 'whitelist.view', 'analytics.view' } },
    viewer = { level = 10, label = 'Viewer', permissions = { 'players.view', 'detections.view', 'bans.view', 'whitelist.view', 'analytics.view', 'system.view' } },
}

Config.Bans = {
    -- Connections without these identifiers are refused (otherwise a ban could not stick).
    requireIdentifiers = { 'license' },
    -- If the backend cannot be reached during connect, the local ban cache is still enforced.
    -- failOpen = true lets unknown players in; false refuses everyone not in the cache (not recommended).
    failOpen = true,
    connectTimeoutMs = 5000,
    message = 'Ki vagy tiltva erről a szerverről.\nOk: %s\nLejár: %s\nAzonosító: %s',
    appealText = 'Fellebbezés: discord.gg/yourserver',
    -- Collect hardware tokens (GetPlayerToken) as ban identifiers.
    useTokens = true,
}

Config.Risk = {
    severityPoints = { INFO = 0, LOW = 5, MEDIUM = 15, HIGH = 35, CRITICAL = 60 },
    -- client-side signals weigh less: they can be forged.
    sourceMultiplier = { server = 1.0, event = 1.0, resource = 0.8, client = 0.5, system = 1.0 },
    corroborationWindowMinutes = 30,
}

Config.Detections = {
    -- the same detection type from the same player is merged within this window
    dedupSeconds = 10,
    ringSize = 500,
    notifyAdminsMinSeverity = 'MEDIUM',
    warnPlayerMessage = 'Szokatlan aktivitást észleltünk a kliensedről. Az esetet naplóztuk.',
    kickMessage = 'MilcsoGuard: szabálysértő aktivitás miatt kickelve (%s).',
}

Config.Grace = {
    joinSeconds = 25,
    respawnSeconds = 8,
    modelChangeSeconds = 6,
    bucketChangeSeconds = 6,
}

-- Areas where scripted teleports are expected (interior doors, elevators). Teleports starting or
-- ending within `radius` of a point are ignored by movement.teleport.
Config.TeleportZones = {
    -- { x = -1388.0, y = -586.0, z = 30.0, radius = 15.0, label = 'Bahama Mamas' },
}

Config.Performance = {
    movementIntervalMs = 1000,
    stateIntervalMs = 2500,
    weaponIntervalMs = 3000,
    -- players processed per tick; ticks are spread so a 128-slot server never checks all at once
    batchSize = 24,
}

Config.TrustedResources = {
    -- server resources allowed to spawn entities on behalf of clients (GetEntityScript)
    -- 'esx_vehicleshop', 'qb-garages',
}

-- Local overrides of module defaults (validated at start; invalid entries are rejected loudly).
Config.Modules = {
    -- ['movement.teleport'] = { action = 'warn', params = { maxDistanceOnFoot = 150 } },
    -- ['events.honeypot'] = { params = { events = { 'esx_illegal:sellDrugs' } } },
}

Config.RiskOverrides = {
    -- banThreshold = 160,
}
