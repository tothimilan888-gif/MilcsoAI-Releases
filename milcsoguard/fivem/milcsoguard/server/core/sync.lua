-- Configuration application, backend handshake/heartbeat, remote commands and whitelist sync.
MG = MG or {}
local U = MG.Util
local Log = MG.Log
local Sync = { configVersion = 0, handshakeDone = false, startedAt = os.time(), localOverrides = nil, remoteOverrides = nil, whitelist = {}, configHooks = {} }
MG.Sync = Sync

MG.Trusted = { resources = {}, models = {} }

--- Modules call this to rebuild caches whenever the effective config changes.
function Sync.onConfig(fn)
    Sync.configHooks[#Sync.configHooks + 1] = fn
end

local function report(issues, prefix)
    for _, i in ipairs(issues) do Log.error('%s %s: %s', prefix, i.path, i.message) end
end

--- Validates local file overrides once. Invalid entries are dropped (safe defaults stay in effect).
function Sync.loadLocal()
    local clean, issues = MG.Schema.validate({ modules = Config.Modules or {}, risk = Config.RiskOverrides or {} })
    if #issues > 0 then report(issues, '[config/config.lua]') end
    Sync.localOverrides = clean
end

--- Applies remote overrides. The whole remote set is rejected if any part is invalid, so a broken
--- dashboard edit can never half-apply. Returns ok, issues.
function Sync.applyConfig(remote, version)
    local clean, issues = MG.Schema.validate(remote or {})
    local modules, risk = MG.Schema.build(Sync.localOverrides, clean)
    for _, i in ipairs(MG.Schema.checkRisk(risk)) do issues[#issues + 1] = i end
    if #issues > 0 then
        report(issues, ('[remote config v%s rejected]'):format(tostring(version)))
        Sync.rejectedVersion = version
        MG.Api.enqueue('event', { events = { { type = 'config_rejected', severity = 'HIGH', message = ('Remote config v%s rejected by the game server'):format(tostring(version)), data = U.obj({ issues = issues }) } } })
        -- keep the previous remote config
        if Sync.remoteOverrides == nil then
            modules, risk = MG.Schema.build(Sync.localOverrides, nil)
        else
            return false, issues
        end
    else
        Sync.remoteOverrides = clean
        Sync.configVersion = version or Sync.configVersion
    end
    MG.Detections.configure(modules, risk)
    for _, fn in ipairs(Sync.configHooks) do
        local ok, err = pcall(fn, modules, risk)
        if not ok then Log.error('config hook failed: %s', tostring(err)) end
    end
    return #issues == 0, issues
end

--- Applies backend whitelist entries: trusted resources/models and per-player exemptions.
function Sync.applyWhitelist(entries)
    Sync.whitelist = entries or {}
    local res, models = U.toSet(Config.TrustedResources or {}), {}
    for _, e in ipairs(Sync.whitelist) do
        if e.kind == 'resource' then res[e.value] = true
        elseif e.kind == 'model' then models[U.toHash(e.value)] = true end
    end
    MG.Trusted.resources, MG.Trusted.models = res, models
    for _, p in ipairs(MG.State.list()) do
        p.whitelist = Sync.playerWhitelist(p.identifiers)
    end
end

function Sync.playerWhitelist(identifiers)
    local set = U.toSet(identifiers)
    local out = {}
    for _, e in ipairs(Sync.whitelist) do
        if e.kind == 'player' and set[e.value] then out[#out + 1] = { modules = e.modules or {} } end
    end
    return out
end

function Sync.effectiveSnapshot()
    return U.obj({ modules = U.obj(MG.Detections.modules), risk = U.obj(U.deepCopy(MG.Detections.risk or {})) })
end

-- ------------------------------------------------------------------ backend handshake
function Sync.handshake()
    local body = {
        resourceVersion = MG.VERSION,
        artifact = GetConvar('version', ''),
        framework = MG.Bridge.name,
        onesync = GetConvar('onesync', 'off'),
        dependencies = U.obj(U.deepCopy(MG.Bridge.deps)),
        schema = MG.Schema.descriptor(),
        effective = Sync.effectiveSnapshot(),
    }
    local r = MG.Api.await('POST', '/handshake', body)
    if not r.ok then
        Log.warn('backend handshake failed: %s', tostring(r.err))
        return false
    end
    MG.Api.serverId = r.data.serverId
    MG.Api.serverName = r.data.serverName
    if type(r.data.banMatchTypes) == 'table' then MG.Bans.matchTypes = r.data.banMatchTypes end
    Sync.applyWhitelist(r.data.whitelist)
    if r.data.config then Sync.applyConfig(r.data.config.overrides, r.data.config.version) end
    Sync.handshakeDone = true
    Log.info('connected to backend as "%s" (config v%d)', tostring(r.data.serverName), Sync.configVersion)
    MG.Bans.sync(MG.Bans.lastSync == nil)
    return true
end

function Sync.pullConfig()
    local r = MG.Api.await('GET', '/config')
    if not r.ok then return false end
    Sync.applyWhitelist(r.data.whitelist)
    if type(r.data.banMatchTypes) == 'table' then MG.Bans.matchTypes = r.data.banMatchTypes end
    if r.data.version ~= Sync.configVersion and r.data.version ~= Sync.rejectedVersion then
        local ok = Sync.applyConfig(r.data.overrides, r.data.version)
        if ok then Log.info('remote config v%d applied', r.data.version) end
    end
    return true
end

function Sync.heartbeat()
    local players = {}
    for _, p in ipairs(MG.State.list()) do
        players[#players + 1] = {
            netId = p.src, name = p.name,
            identifiers = U.filterIdentifiers(p.identifiers, U.toSet(Config.Api.excludeIdentifierTypes)),
            ping = GetPlayerPing(p.src) or 0,
            risk = MG.Detections.score(p),
            monitored = (p.monitoredUntil or 0) > MG.State.now(),
        }
    end
    local resources = { { name = GetCurrentResourceName(), state = 'started' } }
    for _, name in ipairs((MG.Detections.modules['resources.monitor'] or { params = {} }).params.critical or {}) do
        resources[#resources + 1] = { name = name, state = GetResourceState(name) }
    end
    local r = MG.Api.await('POST', '/heartbeat', {
        players = players,
        resources = resources,
        stats = U.obj({
            detections = MG.Detections.counters.total,
            cachedBans = MG.Bans.count(),
            queue = #MG.Api.queue,
            onesync = GetConvar('onesync', 'off'),
            framework = MG.Bridge.name,
        }),
        configVersion = Sync.configVersion,
        queueSize = #MG.Api.queue,
        uptimeSeconds = os.time() - Sync.startedAt,
    })
    if r.ok and r.data.configVersion ~= Sync.configVersion and r.data.configVersion ~= Sync.rejectedVersion then Sync.pullConfig() end
    return r.ok
end

-- ------------------------------------------------------------------ remote commands
local handledCommands = {}

local function handleCommand(cmd)
    local t, pl = cmd.type, cmd.payload or {}
    if t == 'kick' then
        local p = MG.State.get(pl.netId)
        if not p then return 'failed', 'player not online' end
        -- the net id must still belong to the same person
        local mine = U.toSet(p.identifiers)
        local match = false
        for _, i in ipairs(pl.identifiers or {}) do if mine[i] then match = true break end end
        if not match then return 'failed', 'net id now belongs to another player' end
        DropPlayer(tostring(p.src), ('Kickelve: %s (%s)'):format(U.sanitize(pl.reason or '-', 200), U.sanitize(pl.by or 'admin', 32)))
        return 'done', 'dropped'
    elseif t == 'ban_sync' then
        MG.Bans.sync(false)
        return 'done', 'sync started'
    elseif t == 'config_sync' then
        Citizen.CreateThread(Sync.pullConfig)
        return 'done', 'config pull started'
    elseif t == 'announce_admins' then
        if MG.Admin then MG.Admin.broadcastSystem(U.sanitize(pl.message or '', 300), 'INFO') end
        return 'done', 'announced'
    end
    return 'failed', 'unknown command'
end

function Sync.pollCommands()
    local r = MG.Api.await('GET', '/commands')
    if not r.ok or type(r.data.commands) ~= 'table' then return end
    for _, cmd in ipairs(r.data.commands) do
        local status, result
        if handledCommands[cmd.id] then
            status, result = handledCommands[cmd.id][1], handledCommands[cmd.id][2]
        else
            local ok, s, res = pcall(handleCommand, cmd)
            if ok then status, result = s, res else status, result = 'failed', tostring(s) end
            handledCommands[cmd.id] = { status, result }
            Log.info('remote command %s -> %s (%s)', cmd.type, status, result)
        end
        MG.Api.request('POST', '/commands/' .. cmd.id .. '/ack', { status = status, result = result }, function() end)
    end
end

--- Background loops. Each is cheap: one HTTP request per interval for the whole server.
function Sync.start()
    if not MG.Api.enabled() then
        Log.warn('backend API disabled: local-only mode (bans cached locally, no dashboard)')
        return
    end
    Citizen.CreateThread(function()
        local delay = 5000
        while not Sync.handshakeDone do
            if MG.Api.canAttempt() and Sync.handshake() then break end
            Wait(delay)
            delay = math.min(delay * 2, 120000)
        end
    end)
    local function loop(seconds, fn, needsHandshake)
        Citizen.CreateThread(function()
            while true do
                Wait(seconds * 1000)
                if (not needsHandshake or Sync.handshakeDone) and MG.Api.canAttempt() then
                    local ok, err = pcall(fn)
                    if not ok then Log.error('sync loop error: %s', tostring(err)) end
                end
            end
        end)
    end
    loop(Config.Api.heartbeatSeconds, Sync.heartbeat, true)
    loop(Config.Api.commandPollSeconds, Sync.pollCommands, true)
    loop(Config.Api.banSyncSeconds, function() MG.Bans.sync(false) end, true)
    loop(Config.Api.configSyncSeconds, Sync.pullConfig, true)
    loop(Config.Api.flushSeconds, function()
        MG.Api.flush()
        MG.Api.saveQueue()
    end, false)
    -- forget old command ids
    Citizen.CreateThread(function()
        while true do
            Wait(600000)
            handledCommands = {}
            MG.Bans.prune()
        end
    end)
end

return Sync
