-- Resource monitoring (server side) and client-side signals (heartbeat, resource reports,
-- spectator mode). Client signals are labelled source = 'client' and can never ban on their own.
MG = MG or {}
local U = MG.Util
local Log = MG.Log
local R = { serverChanges = {}, configHash = nil, limiter = MG.RateLimiter.new(30, 10000) }
MG.ResourceChecks = R

local NAME_PATTERN = '^[%w_%.%-%[%]]+$'

local function systemEvent(type_, severity, message, data)
    Log.warn('%s', message)
    MG.Api.enqueue('event', { events = { { type = type_, severity = severity, message = message, data = U.obj(data or {}) } } })
    if MG.Admin and MG.SEVERITY_RANK[severity] >= MG.SEVERITY_RANK.HIGH then MG.Admin.broadcastSystem(message, severity) end
end
R.systemEvent = systemEvent

-- ------------------------------------------------------------------ server-side resource monitor
AddEventHandler('onResourceStop', function(name)
    R.serverChanges[name] = GetGameTimer()
    if name == GetCurrentResourceName() then return end
    local m = MG.Detections.module('resources.monitor')
    if m and U.contains(m.params.critical, name) then
        systemEvent('resource_stop', 'HIGH', ('Kritikus resource leállt: %s'):format(name), { resource = name })
    end
end)

AddEventHandler('onResourceStart', function(name)
    R.serverChanges[name] = GetGameTimer()
end)

local function fileHash()
    local content = LoadResourceFile(GetCurrentResourceName(), 'config/config.lua')
    if not content then return nil end
    return U.joaat(content) .. ':' .. #content
end

-- ------------------------------------------------------------------ client signals
--- Validates and rate-limits every client -> server MilcsoGuard event.
local function guard(src, name)
    src = tonumber(src)
    local p = src and MG.State.get(src)
    if not p then return nil end
    local ok = R.limiter:hit(src .. name, GetGameTimer())
    if not ok then
        MG.Detections.report(src, 'events.spam', { blocked = true, evidence = { event = name } })
        return nil
    end
    return p
end

RegisterNetEvent('milcsoguard:ready', function()
    local p = guard(source, 'ready')
    if not p or p.hb.ready then return end
    p.hb.ready = true
    p.hb.misses = 0
    local hb = MG.Detections.modules['client.heartbeat']
    TriggerClientEvent('milcsoguard:clientConfig', p.src, {
        spectateCheck = MG.Detections.module('client.spectate') ~= nil,
        resourceReports = MG.Detections.module('client.resource_injection') ~= nil,
        heartbeat = hb and hb.enabled or false,
        command = Config.Permissions.command,
        keybind = Config.Permissions.keybind,
        brand = Config.Brand,
        replay = MG.Replay and MG.Replay.clientConfig() or nil,
    })
end)

RegisterNetEvent('milcsoguard:hb', function(nonce)
    local p = guard(source, 'hb')
    if not p or type(nonce) ~= 'string' then return end
    if p.hb.nonce and nonce == p.hb.nonce then
        p.hb.nonce = nil
        p.hb.misses = 0
        p.hb.lastOk = GetGameTimer()
    end
end)

RegisterNetEvent('milcsoguard:clientResource', function(action, name)
    local p = guard(source, 'res')
    if not p or (action ~= 'start' and action ~= 'stop') or type(name) ~= 'string' or #name > 64 or not name:match(NAME_PATTERN) then return end
    local m = MG.Detections.module('client.resource_injection')
    if not m or U.contains(m.params.allow, name) or name == GetCurrentResourceName() then return end
    local state = GetResourceState(name)
    local recentlyChanged = R.serverChanges[name] and GetGameTimer() - R.serverChanges[name] < 60000
    if action == 'start' and state == 'missing' then
        MG.Detections.report(p.src, 'client.resource_injection', { evidence = { action = 'start', resource = name, serverState = state } })
    elseif action == 'stop' and state == 'started' and not recentlyChanged then
        MG.Detections.report(p.src, 'client.resource_injection', { severity = 'MEDIUM', evidence = { action = 'stop', resource = name, serverState = state } })
    end
end)

RegisterNetEvent('milcsoguard:signal', function(kind)
    local p = guard(source, 'signal')
    if not p then return end
    if kind == 'spectate' then
        MG.Detections.report(p.src, 'client.spectate', { evidence = { spectating = true } })
    end
end)

-- ------------------------------------------------------------------ heartbeat loop
--- Pure step of the heartbeat state machine (unit tested). Returns 'missed'|'not_ready'|nil.
function R.heartbeatStep(hb, now, joinedAt, params)
    if not hb.ready then
        if not hb.notReadyReported and now - joinedAt > params.readyTimeoutSeconds * 1000 then
            hb.notReadyReported = true
            return 'not_ready'
        end
        return nil
    end
    if hb.nonce then
        hb.misses = hb.misses + 1
        if hb.misses >= params.maxMisses then
            hb.misses = 0
            return 'missed'
        end
    end
    return nil
end

function R.start()
    R.configHash = fileHash()
    Citizen.CreateThread(function()
        while true do
            local hb = MG.Detections.modules['client.heartbeat']
            local interval = (hb and hb.params.intervalSeconds or 30) * 1000
            Wait(interval)
            if hb and hb.enabled then
                local now = GetGameTimer()
                for _, p in ipairs(MG.State.list()) do
                    local verdict = R.heartbeatStep(p.hb, now, p.joinedAt, hb.params)
                    if verdict then
                        MG.Detections.report(p.src, 'client.heartbeat', { ignoreGrace = true, evidence = { reason = verdict, lastOkMsAgo = p.hb.lastOk and (now - p.hb.lastOk) or nil } })
                    end
                    if p.hb.ready then
                        p.hb.nonce = U.uuid()
                        TriggerClientEvent('milcsoguard:hb', p.src, p.hb.nonce)
                    end
                end
            end
        end
    end)
    Citizen.CreateThread(function()
        while true do
            Wait(60000)
            local h = fileHash()
            if h and R.configHash and h ~= R.configHash and MG.Detections.module('resources.monitor') then
                systemEvent('config_file_changed', 'MEDIUM', 'A config/config.lua fájl megváltozott futás közben (újraindításkor lép életbe).', {})
                R.configHash = h
            end
            R.limiter:gc(GetGameTimer())
        end
    end)
end

return R
