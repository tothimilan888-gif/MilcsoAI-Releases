-- Weapon and damage checks: blacklisted weapons, weapons missing from the inventory, network
-- weapon events targeting other players and weapon damage anomalies.
MG = MG or {}
local U = MG.Util
local W = { blacklist = {}, ignore = {}, hitLimiter = nil, mismatch = {} }
MG.WeaponChecks = W

MG.Sync.onConfig(function(modules)
    local bl = modules['weapons.blacklist']
    W.blacklist = U.toSet(bl and bl.params.weapons or {}, U.joaat)
    local inv = modules['weapons.inventory_mismatch']
    W.ignore = U.toSet(inv and inv.params.ignore or {}, U.joaat)
    local dmg = modules['weapons.damage']
    W.hitLimiter = MG.RateLimiter.new(dmg and dmg.params.maxHitsPerSecond or 20, 1000)
end)

-- ------------------------------------------------------------------ periodic weapon scan
local function tick(p, now)
    if now < (p.graceUntil or 0) then return end
    local ped = GetPlayerPed(p.src)
    if not ped or ped == 0 then return end
    local weapon = U.u32(GetSelectedPedWeapon(ped))
    if weapon == MG.Weapons.UNARMED or weapon == 0 then
        MG.State.clearStreak(p, 'inv')
        return
    end
    local bl = MG.Detections.module('weapons.blacklist')
    if bl and W.blacklist[weapon] then
        local rec = MG.Detections.report(p.src, 'weapons.blacklist', { evidence = { weapon = MG.Weapons.name(weapon) or weapon } })
        if rec and bl.params.removeWeapon then RemoveWeaponFromPed(ped, weapon) end
        return
    end
    local inv = MG.Detections.module('weapons.inventory_mismatch')
    if inv and MG.Bridge.canCheckInventory() and not W.ignore[weapon] then
        local owns = MG.Bridge.ownsWeapon(p.src, weapon)
        if owns == false then
            local n = MG.State.streak(p, 'inv')
            if n >= inv.params.consecutive then
                MG.State.clearStreak(p, 'inv')
                local rec = MG.Detections.report(p.src, 'weapons.inventory_mismatch', { evidence = { weapon = MG.Weapons.name(weapon), inventory = MG.Bridge.inventory or MG.Bridge.name, samples = n } })
                if rec and inv.params.removeWeapon then RemoveWeaponFromPed(ped, weapon) end
            end
        else
            MG.State.clearStreak(p, 'inv')
        end
    end
end

-- ------------------------------------------------------------------ network weapon events
--- Ped (by network id) that is not controlled by the sender.
local function foreignPed(sender, netId)
    local ped = NetworkGetEntityFromNetworkId(netId)
    if not ped or ped == 0 or not DoesEntityExist(ped) then return nil end
    if NetworkGetEntityOwner(ped) == sender then return nil end
    return ped
end

local function victimInfo(ped)
    if IsPedAPlayer(ped) then
        local owner = NetworkGetEntityOwner(ped)
        return { player = true, netId = owner, name = owner and U.sanitize(GetPlayerName(owner) or '?') or '?' }
    end
    return { player = false, model = GetEntityModel(ped) }
end

AddEventHandler('giveWeaponEvent', function(sender, data)
    if not MG.Detections.module('weapons.give_event') then return end
    local ped = foreignPed(sender, data.pedId)
    if not ped then return end
    CancelEvent()
    local victim = victimInfo(ped)
    MG.Detections.report(sender, 'weapons.give_event', {
        blocked = true,
        severity = (not victim.player) and 'LOW' or nil,
        evidence = { weapon = MG.Weapons.name(data.weaponType) or U.u32(data.weaponType), ammo = data.ammo, pickup = data.givenAsPickup, target = victim },
    })
end)

local function onRemove(name)
    return function(sender, data)
        if not MG.Detections.module('weapons.remove_event') then return end
        local ped = foreignPed(sender, data.pedId)
        if not ped or not IsPedAPlayer(ped) then return end
        CancelEvent()
        MG.Detections.report(sender, 'weapons.remove_event', { blocked = true, evidence = { event = name, weapon = data.weaponType and (MG.Weapons.name(data.weaponType) or U.u32(data.weaponType)) or 'all', target = victimInfo(ped) } })
    end
end
AddEventHandler('removeWeaponEvent', onRemove('removeWeaponEvent'))
AddEventHandler('removeAllWeaponsEvent', onRemove('removeAllWeaponsEvent'))

--[[
  Pure evaluation of a weaponDamageEvent (unit tested).
  ctx = { now, selected (attacker weapon hash), inVehicle, distance (attacker->victim or nil), mismatches (list of ms) }
  Returns findings list { reason, cancel, evidence }.
]]
function W.evaluateDamage(data, ctx, params)
    local out = {}
    local weapon = U.u32(data.weaponType)
    if data.overrideDefaultDamage and (tonumber(data.weaponDamage) or 0) > params.maxDamage then
        out[#out + 1] = { reason = 'damage_cap', cancel = params.cancelViolations, evidence = { damage = data.weaponDamage, limit = params.maxDamage } }
    end
    if MG.Weapons.MELEE[weapon] and ctx.distance and ctx.distance > params.meleeMaxDistance then
        out[#out + 1] = { reason = 'melee_distance', cancel = params.cancelViolations, evidence = { distance = U.round(ctx.distance, 1), limit = params.meleeMaxDistance } }
    end
    -- weapon mismatch: only for known hand-held weapons, never while in a vehicle
    if not ctx.inVehicle and MG.Weapons.byHash[weapon] and not MG.Weapons.MELEE[weapon] and ctx.selected ~= weapon then
        local list = ctx.mismatches
        local kept = {}
        for _, t in ipairs(list) do if ctx.now - t < 60000 then kept[#kept + 1] = t end end
        kept[#kept + 1] = ctx.now
        for i = #list, 1, -1 do list[i] = nil end
        for i, t in ipairs(kept) do list[i] = t end
        if #kept >= params.weaponMismatchCount then
            for i = #list, 1, -1 do list[i] = nil end
            out[#out + 1] = { reason = 'weapon_mismatch', cancel = false, evidence = { damageWeapon = MG.Weapons.name(weapon), heldWeapon = MG.Weapons.name(ctx.selected) or ctx.selected, occurrences = #kept } }
        end
    end
    return out
end

AddEventHandler('weaponDamageEvent', function(sender, data)
    local m = MG.Detections.module('weapons.damage')
    if not m then return end
    local p = MG.State.get(sender)
    if not p then return end
    local now = GetGameTimer()
    local allowed, hits = W.hitLimiter:hit(sender, now)
    if not allowed then
        if m.params.cancelViolations then CancelEvent() end
        MG.Detections.report(sender, 'weapons.damage', { blocked = m.params.cancelViolations, evidence = { reason = 'hit_rate', hitsPerSecond = math.floor(hits), limit = m.params.maxHitsPerSecond } })
        return
    end
    local attacker = GetPlayerPed(sender)
    local victim = data.hitGlobalId and NetworkGetEntityFromNetworkId(data.hitGlobalId) or 0
    local distance = nil
    if attacker ~= 0 and victim ~= 0 and DoesEntityExist(victim) then
        distance = U.dist3(GetEntityCoords(attacker), GetEntityCoords(victim))
    end
    p.dmgMismatch = p.dmgMismatch or {}
    local findings = W.evaluateDamage(data, {
        now = now, selected = U.u32(GetSelectedPedWeapon(attacker)), inVehicle = GetVehiclePedIsIn(attacker, false) ~= 0,
        distance = distance, mismatches = p.dmgMismatch,
    }, m.params)
    local cancelled = false
    for _, f in ipairs(findings) do
        if f.cancel and not cancelled then
            CancelEvent()
            cancelled = true
        end
        f.evidence.reason = f.reason
        if victim ~= 0 and DoesEntityExist(victim) and GetEntityType(victim) == 1 then f.evidence.victim = victimInfo(victim) end
        MG.Detections.report(sender, 'weapons.damage', { blocked = f.cancel, evidence = f.evidence })
    end
end)

function W.start()
    MG.Scheduler.every(Config.Performance.weaponIntervalMs, tick)
    Citizen.CreateThread(function()
        while true do
            Wait(30000)
            if W.hitLimiter then W.hitLimiter:gc(GetGameTimer()) end
        end
    end)
end

return W
