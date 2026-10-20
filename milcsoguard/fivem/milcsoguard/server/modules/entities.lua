-- Entity, explosion, particle and projectile protection based on OneSync game events.
-- Every handler cancels the offending event first (CancelEvent prevents routing / deletes the
-- entity) and reports afterwards.
MG = MG or {}
local U = MG.Util
local E = { models = {}, explosionTypes = {}, limiters = {} }
MG.EntityChecks = E

E.EXPLOSION_NAMES = {
    [0] = 'GRENADE', 'GRENADELAUNCHER', 'STICKYBOMB', 'MOLOTOV', 'ROCKET', 'TANKSHELL', 'HI_OCTANE', 'CAR', 'PLANE', 'PETROL_PUMP',
    'BIKE', 'DIR_STEAM', 'DIR_FLAME', 'DIR_WATER_HYDRANT', 'DIR_GAS_CANISTER', 'BOAT', 'SHIP_DESTROY', 'TRUCK', 'BULLET',
    'SMOKEGRENADELAUNCHER', 'SMOKEGRENADE', 'BZGAS', 'FLARE', 'GAS_CANISTER', 'EXTINGUISHER', 'PROGRAMMABLEAR', 'TRAIN', 'BARREL',
    'PROPANE', 'BLIMP', 'DIR_FLAME_EXPLODE', 'TANKER', 'PLANE_ROCKET', 'VEHICLE_BULLET', 'GAS_TANK', 'BIRD_CRAP', 'RAILGUN', 'BLIMP2',
    'FIREWORK', 'SNOWBALL', 'PROXMINE', 'VALKYRIE_CANNON', 'AIR_DEFENCE', 'PIPEBOMB', 'VEHICLEMINE', 'EXPLOSIVEAMMO', 'APCSHELL',
    'BOMB_CLUSTER', 'BOMB_GAS', 'BOMB_INCENDIARY', 'BOMB_STANDARD', 'TORPEDO', 'TORPEDO_UNDERWATER', 'BOMBUSHKA_CANNON',
    'BOMB_CLUSTER_SECONDARY', 'HUNTER_BARRAGE', 'HUNTER_CANNON', 'ROGUE_CANNON', 'MINE_UNDERWATER', 'ORBITAL_CANNON',
    'BOMB_STANDARD_WIDE', 'EXPLOSIVEAMMO_SHOTGUN', 'OPPRESSOR2_CANNON', 'MORTAR_KINETIC', 'VEHICLEMINE_KINETIC', 'VEHICLEMINE_EMP',
    'VEHICLEMINE_SPIKE', 'VEHICLEMINE_SLICK', 'VEHICLEMINE_TAR', 'SCRIPT_DRONE', 'RAYGUN', 'BURIEDMINE', 'SCRIPT_MISSILE',
}

local POP_MISSION = 7
local TYPE_KEY = { [1] = 'Peds', [2] = 'Vehicles', [3] = 'Objects' }

MG.Sync.onConfig(function(modules)
    local sp = modules['entities.spawn']
    E.models = U.toSet(sp and sp.params.blacklistedModels or {}, U.toHash)
    local ex = modules['explosions.filter']
    E.explosionTypes = U.toSet(ex and ex.params.blacklistedTypes or {}, tonumber)
    local w = (sp and sp.params.windowSeconds or 10) * 1000
    E.limiters = {
        Vehicles = MG.RateLimiter.new(sp and sp.params.maxVehiclesPerWindow or 6, w),
        Peds = MG.RateLimiter.new(sp and sp.params.maxPedsPerWindow or 10, w),
        Objects = MG.RateLimiter.new(sp and sp.params.maxObjectsPerWindow or 40, w),
        explosion = MG.RateLimiter.new(ex and ex.params.maxPerWindow or 6, (ex and ex.params.windowSeconds or 10) * 1000),
        ptfx = MG.RateLimiter.new(modules['entities.ptfx'] and modules['entities.ptfx'].params.maxPerWindow or 30, (modules['entities.ptfx'] and modules['entities.ptfx'].params.windowSeconds or 10) * 1000),
        projectile = MG.RateLimiter.new(modules['entities.projectile'] and modules['entities.projectile'].params.maxPerWindow or 25, (modules['entities.projectile'] and modules['entities.projectile'].params.windowSeconds or 5) * 1000),
    }
end)

-- ------------------------------------------------------------------ expected spawns (export)
--- Server scripts that make a client spawn something call this first (ExpectEntity export).
function E.expect(src, model, count, durationMs)
    local p = MG.State.get(src)
    if not p then return false end
    p.expected = p.expected or {}
    local h = U.toHash(model)
    local cur = p.expected[h]
    local untilMs = GetGameTimer() + math.min(durationMs or 10000, 120000)
    p.expected[h] = { count = (cur and cur.count or 0) + math.max(1, math.min(count or 1, 50)), untilMs = untilMs }
    return true
end

local function consumeExpected(p, model, now)
    local e = p.expected and p.expected[model]
    if not e then return false end
    if e.untilMs < now or e.count <= 0 then
        p.expected[model] = nil
        return false
    end
    e.count = e.count - 1
    return true
end

--[[
  Pure decision for a client-created entity (unit tested).
  info = { pop, etype, model, script, now }
  Returns verdict: 'allow' | 'blacklisted' | 'flood', plus extra evidence.
]]
function E.evaluateEntity(p, info)
    if info.pop ~= POP_MISSION then return 'allow' end
    if info.script and info.script ~= '' and MG.Trusted.resources[info.script] then return 'allow' end
    if MG.Trusted.models[info.model] then return 'allow' end
    if consumeExpected(p, info.model, info.now) then return 'allow' end
    if E.models[info.model] then return 'blacklisted' end
    local kind = TYPE_KEY[info.etype]
    if kind and E.limiters[kind] then
        local ok, n = E.limiters[kind]:hit(p.src .. ':' .. kind, info.now)
        if not ok then return 'flood', { kind = kind, count = math.floor(n) } end
    end
    return 'allow'
end

AddEventHandler('entityCreating', function(entity)
    if not MG.Detections.module('entities.spawn') then return end
    local owner = NetworkGetEntityOwner(entity)
    local p = owner and MG.State.get(owner)
    if not p then return end
    local info = {
        pop = GetEntityPopulationType(entity), etype = GetEntityType(entity), model = U.u32(GetEntityModel(entity)),
        script = GetEntityScript(entity), now = GetGameTimer(),
    }
    local verdict, extra = E.evaluateEntity(p, info)
    if verdict == 'allow' then return end
    CancelEvent()
    local evidence = { reason = verdict, model = info.model, entityType = TYPE_KEY[info.etype] or info.etype, script = info.script }
    for k, v in pairs(extra or {}) do evidence[k] = v end
    MG.Detections.report(owner, 'entities.spawn', { blocked = true, severity = verdict == 'flood' and 'MEDIUM' or nil, evidence = evidence })
end)

-- ------------------------------------------------------------------ explosions
--- Pure evaluation of an explosionEvent (unit tested). Returns list of reasons.
function E.evaluateExplosion(sender, ev, params, now)
    local reasons = {}
    if E.explosionTypes[ev.explosionType] then reasons[#reasons + 1] = 'blacklisted_type' end
    if params.flagInvisibleSilent and ev.isInvisible and not ev.isAudible then reasons[#reasons + 1] = 'invisible_silent' end
    if (tonumber(ev.damageScale) or 1) > params.maxDamageScale then reasons[#reasons + 1] = 'damage_scale' end
    local ok = E.limiters.explosion:hit(sender, now)
    if not ok then reasons[#reasons + 1] = 'rate' end
    return reasons
end

AddEventHandler('explosionEvent', function(sender, ev)
    local m = MG.Detections.module('explosions.filter')
    if not m or not MG.State.get(sender) then return end
    local reasons = E.evaluateExplosion(sender, ev, m.params, GetGameTimer())
    if #reasons == 0 then return end
    CancelEvent()
    MG.Detections.report(sender, 'explosions.filter', {
        blocked = true,
        severity = (#reasons == 1 and reasons[1] == 'rate') and 'MEDIUM' or nil,
        evidence = {
            reasons = reasons, explosionType = ev.explosionType, explosionName = E.EXPLOSION_NAMES[ev.explosionType],
            damageScale = ev.damageScale, invisible = ev.isInvisible, audible = ev.isAudible,
            pos = { x = U.round(ev.posX or 0, 1), y = U.round(ev.posY or 0, 1), z = U.round(ev.posZ or 0, 1) },
        },
    })
end)

-- ------------------------------------------------------------------ other game events
AddEventHandler('clearPedTasksEvent', function(sender, ev)
    if not MG.Detections.module('entities.clear_tasks') or not MG.State.get(sender) then return end
    local ped = NetworkGetEntityFromNetworkId(ev.pedId)
    if not ped or ped == 0 or not DoesEntityExist(ped) or not IsPedAPlayer(ped) then return end
    local owner = NetworkGetEntityOwner(ped)
    if owner == sender then return end
    CancelEvent()
    MG.Detections.report(sender, 'entities.clear_tasks', { blocked = true, evidence = { target = owner, targetName = U.sanitize(GetPlayerName(owner) or '?'), immediately = ev.immediately } })
end)

AddEventHandler('ptFxEvent', function(sender, ev)
    local m = MG.Detections.module('entities.ptfx')
    if not m or not MG.State.get(sender) then return end
    local ok, n = E.limiters.ptfx:hit(sender, GetGameTimer())
    local big = (tonumber(ev.scale) or 1) > m.params.maxScale
    if ok and not big then return end
    CancelEvent()
    MG.Detections.report(sender, 'entities.ptfx', { blocked = true, evidence = { reason = big and 'scale' or 'rate', count = math.floor(n), scale = ev.scale, effect = ev.effectHash } })
end)

AddEventHandler('startProjectileEvent', function(sender, ev)
    local m = MG.Detections.module('entities.projectile')
    if not m or not MG.State.get(sender) then return end
    local ok, n = E.limiters.projectile:hit(sender, GetGameTimer())
    local banned = MG.WeaponChecks and MG.WeaponChecks.blacklist[U.u32(ev.weaponHash)]
    if ok and not banned then return end
    CancelEvent()
    MG.Detections.report(sender, 'entities.projectile', { blocked = true, evidence = { reason = banned and 'blacklisted_weapon' or 'rate', count = math.floor(n), weapon = MG.Weapons.name(ev.weaponHash) or U.u32(ev.weaponHash or 0) } })
end)

function E.start()
    Citizen.CreateThread(function()
        while true do
            Wait(60000)
            local now = GetGameTimer()
            for _, l in pairs(E.limiters) do l:gc(now) end
        end
    end)
end

return E
