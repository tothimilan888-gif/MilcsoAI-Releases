-- Entry point: start-up checks, connection flow (ban check with deferrals), exports, console.
MG = MG or {}
local U = MG.Util
local Log = MG.Log
MG.VERSION = GetResourceMetadata(GetCurrentResourceName(), 'version', 0) or '0.0.0'

local started = false

local function startup()
    Log.info('%s v%s starting (artifact %s)', Config.Brand, MG.VERSION, GetConvar('version', '?'))
    local errors, warnings = MG.ConfigCheck.run(Config)
    for _, e in ipairs(errors) do Log.error('config: %s', e) end
    for _, w in ipairs(warnings) do Log.warn('config: %s', w) end

    MG.Bridge.init()
    MG.Sync.loadLocal()
    MG.Sync.applyConfig(nil, 0)
    MG.Sync.applyWhitelist({})

    local onesync = GetConvar('onesync', 'off')
    if onesync == 'off' or onesync == 'false' then
        Log.error('OneSync is OFF. Server-side movement, state, entity and damage checks need OneSync (set onesync on). Only connection bans, client signals and the admin panel will work.')
        MG.OneSync = false
    else
        MG.OneSync = true
    end
    if GetConvar('sv_entityLockdown', 'inactive') == 'inactive' then
        Log.warn('sv_entityLockdown is not set. Consider "set sv_entityLockdown relaxed" (or strict) to stop clients creating networked entities; see docs/DETECTIONS.md.')
    end

    MG.Bans.load()
    MG.Api.loadQueue()

    -- register players that are already online (resource restart)
    for _, sid in ipairs(GetPlayers()) do
        local src = tonumber(sid)
        local ids, map = MG.State.readIdentifiers(src, Config.Bans.useTokens)
        local p = MG.State.create(src, { identifiers = ids, idmap = map })
        p.whitelist = MG.Sync.playerWhitelist(ids)
        p.graceUntil = MG.State.now() + Config.Grace.joinSeconds * 1000
        MG.Permissions.refresh(src)
    end
    TriggerClientEvent('milcsoguard:resync', -1)

    if MG.OneSync then
        MG.Movement.start()
        MG.PlayerChecks.start()
        MG.WeaponChecks.start()
        MG.EntityChecks.start()
    end
    MG.EventChecks.start()
    MG.ResourceChecks.start()
    MG.Sync.start()

    -- periodic permission refresh (ACE can change at runtime) and enforcement of cached bans
    Citizen.CreateThread(function()
        while true do
            Wait(60000)
            for _, p in ipairs(MG.State.list()) do MG.Permissions.refresh(p.src) end
            MG.Bans.prune()
        end
    end)
    started = true
    Log.info('ready: %d module(s) enabled, %d cached ban(s), framework %s, API %s', (function()
        local n = 0
        for _, m in pairs(MG.Detections.modules) do if m.enabled then n = n + 1 end end
        return n
    end)(), MG.Bans.count(), MG.Bridge.name, MG.Api.enabled() and 'enabled' or 'disabled')
end

-- ------------------------------------------------------------------ connection flow
AddEventHandler('playerConnecting', function(name, _setKickReason, deferrals)
    local src = source
    deferrals.defer()
    Wait(0)
    deferrals.update(('%s: ellenőrzés…'):format(Config.Brand))
    if not started then
        deferrals.done(('%s még indul, próbáld újra pár másodperc múlva.'):format(Config.Brand))
        return
    end
    local ids, map = MG.State.readIdentifiers(src, Config.Bans.useTokens)
    for _, t in ipairs(Config.Bans.requireIdentifiers or {}) do
        if not map[t] then
            deferrals.done(('Hiányzó azonosító (%s). Indítsd újra a FiveM-et / jelentkezz be.'):format(t))
            return
        end
    end
    -- 1) local cache: works even if the backend is down
    local ban = MG.Bans.find(ids)
    if ban then
        Log.info('rejected banned player %s (%s)', U.sanitize(name), ban.code or ban.id)
        deferrals.done(MG.Bans.message(ban))
        return
    end
    -- 2) backend: fresh ban state + linked admin account + whitelist
    local pending = { identifiers = ids, idmap = map, name = U.sanitize(name) }
    if MG.Api.enabled() and MG.Api.canAttempt() then
        local r = MG.Api.await('POST', '/players/connect', {
            name = pending.name,
            identifiers = U.filterIdentifiers(ids, U.toSet(Config.Api.excludeIdentifierTypes)),
        }, { timeoutMs = Config.Bans.connectTimeoutMs })
        if r.ok then
            if r.data.ban then
                local b = r.data.ban
                local cached = { id = b.id, code = b.code, reason = b.reason, playerName = pending.name, identifiers = U.filterIdentifiers(ids, { ip = true }), createdAt = os.time(), expiresAt = b.expiresAt and U.parseIso(b.expiresAt) or nil }
                MG.Bans.put(cached)
                deferrals.done(MG.Bans.message(cached))
                return
            end
            pending.backendAdmin = r.data.admin
            pending.whitelist = r.data.whitelist
        elseif not Config.Bans.failOpen then
            deferrals.done('Az anticheat szolgáltatás nem érhető el, próbáld újra később.')
            return
        else
            Log.debug('backend unreachable during connect (%s); local cache enforced, player allowed', tostring(r.err))
        end
    end
    MG.State.pending[tonumber(src)] = pending
    deferrals.done()
end)

AddEventHandler('playerJoining', function(oldId)
    local src = source
    local pending = MG.State.pending[tonumber(oldId)]
    MG.State.pending[tonumber(oldId)] = nil
    local ids, map = MG.State.readIdentifiers(src, Config.Bans.useTokens)
    local p = MG.State.create(src, {
        identifiers = ids, idmap = map,
        backendAdmin = pending and pending.backendAdmin,
        whitelist = MG.Sync.playerWhitelist(ids),
    })
    MG.Permissions.refresh(src)
    if MG.Api.enabled() then
        MG.Api.request('POST', '/players/joined', { netId = src, name = p.name, identifiers = U.filterIdentifiers(ids, U.toSet(Config.Api.excludeIdentifierTypes)) }, function() end)
    end
end)

AddEventHandler('playerDropped', function(reason)
    local src = source
    if MG.Replay then MG.Replay.onDropped(src) end
    local p = MG.State.get(src)
    if p and not p.banning then MG.State.rememberDropped(p, reason) end
    if MG.Admin then MG.Admin.onDropped(src) end
    MG.State.remove(src)
    if MG.Api.enabled() then
        MG.Api.request('POST', '/players/dropped', { netId = src, reason = U.sanitize(reason or '', 200) }, function() end)
    end
end)

AddEventHandler('onResourceStop', function(name)
    if name ~= GetCurrentResourceName() then return end
    MG.Api.queueDirty = true
    MG.Api.saveQueue()
end)

-- ------------------------------------------------------------------ exports for other server resources
--- Exempts a player from one module ('movement.teleport'), a category ('movement.*') or all ('*').
exports('SetExempt', function(src, key, durationMs)
    local p = MG.State.get(src)
    if not p or type(key) ~= 'string' then return false end
    MG.State.setExempt(p, key, tonumber(durationMs) or 5000)
    Log.debug('%s exempted #%d from %s for %dms', GetInvokingResource() or '?', p.src, key, tonumber(durationMs) or 5000)
    return true
end)

--- Call before a server-initiated teleport (SetEntityCoords on the server, txAdmin-like tools).
exports('AllowMovement', function(src, durationMs)
    local p = MG.State.get(src)
    if not p then return false end
    MG.State.setExempt(p, 'movement.*', tonumber(durationMs) or 5000)
    p.sample = nil -- new baseline after the teleport
    return true
end)

--- Announces a legitimate client-side spawn of `model` (count) within durationMs.
exports('ExpectEntity', function(src, model, count, durationMs)
    return MG.EntityChecks.expect(src, model, count, durationMs)
end)

--- Rate limit for other resources' net events: `if not exports.milcsoguard:CheckEvent(source, 'shop:buy', { limit = 5, windowMs = 10000 }) then return end`
exports('CheckEvent', function(src, eventName, opts)
    return MG.EventChecks.check(src, eventName, opts)
end)

--- Reports a validated exploit attempt detected by another resource.
exports('ReportSuspicious', function(src, reason, evidence)
    return MG.EventChecks.reportFromResource(src, reason, evidence)
end)

exports('GetPlayerRisk', function(src)
    return MG.Detections.score(MG.State.get(src))
end)

exports('IsAdmin', function(src, perm)
    if perm then return MG.Permissions.has(src, perm) end
    return MG.Permissions.isAdmin(src)
end)

-- ------------------------------------------------------------------ console
RegisterCommand('milcsoguard', function(src, args)
    if src ~= 0 then return end
    local cmd = args[1] or 'status'
    if cmd == 'status' then
        print(('[MilcsoGuard] v%s | framework %s | onesync %s | players %d | cached bans %d | API %s (%s) | queue %d | config v%d'):format(
            MG.VERSION, MG.Bridge.name, tostring(MG.OneSync), U.count(MG.State.players), MG.Bans.count(),
            MG.Api.enabled() and (MG.Api.online and 'online' or 'offline') or 'disabled', tostring(MG.Api.lastError or 'ok'), #MG.Api.queue, MG.Sync.configVersion))
    elseif cmd == 'sync' then
        MG.Bans.sync(true)
        Citizen.CreateThread(MG.Sync.pullConfig)
        print('[MilcsoGuard] full ban sync + config pull started')
    elseif cmd == 'unban' and args[2] then
        local ok = MG.Bans.revoke(args[2], table.concat(args, ' ', 3) ~= '' and table.concat(args, ' ', 3) or 'console unban', MG.Permissions.actor(0))
        print(ok and '[MilcsoGuard] revoked' or '[MilcsoGuard] ban not in local cache (revoke queued if it exists remotely)')
    else
        print('usage: milcsoguard status | sync | unban <banId> [reason]')
    end
end, true)

Citizen.CreateThread(function()
    local ok, err = pcall(startup)
    if not ok then
        Log.error('START-UP FAILED: %s', tostring(err))
        Log.error('MilcsoGuard is NOT protecting this server. Fix the error above and restart the resource.')
    end
end)
