-- Server-side movement analysis from OneSync-synced positions. The analysis is a pure function
-- (MG.Movement.analyze) so it can be unit tested without a game server.
MG = MG or {}
local U = MG.Util
local M = {}
MG.Movement = M

local function inZone(pos)
    for _, z in ipairs(Config.TeleportZones or {}) do
        if not z.invalid and U.dist3(pos, z) <= z.radius then return true end
    end
    return false
end

--[[
  prev/cur sample: { pos = {x,y,z}, t = ms, vehicle = handle|0, vehType = string|nil, driver = bool,
                     vel = {x,y,z}, attached = bool, collisionDisabled = bool, bucket = int, ped = handle, dead = bool }
  cfg: effective module configs (MG.Detections.modules)
  Returns a list of findings { key, evidence, severity? } plus streak updates applied to `streaks`.
]]
function M.analyze(prev, cur, cfg, streaks)
    local findings = {}
    if not prev or not cur then return findings end
    local dt = (cur.t - prev.t) / 1000
    if dt <= 0.05 or dt > 5 then return findings end -- too close or a gap (lag spike): no conclusions
    -- baseline resets: respawn, model change (new ped), routing bucket change, death
    if prev.ped ~= cur.ped or prev.bucket ~= cur.bucket or prev.dead or cur.dead then return findings end

    local dist = U.dist3(prev.pos, cur.pos)
    local horiz = U.dist2(prev.pos, cur.pos)
    local hspeed = horiz / dt
    local vz = (cur.pos.z - prev.pos.z) / dt
    local inVeh = cur.vehicle ~= 0 or prev.vehicle ~= 0
    local reported = cur.vel and U.len3(cur.vel) or 0

    local function streak(key, cond)
        if cond then
            streaks[key] = (streaks[key] or 0) + 1
        else
            streaks[key] = nil
        end
        return streaks[key] or 0
    end

    -- teleport: a single impossible jump
    local tp = cfg['movement.teleport']
    if tp and tp.enabled then
        local limit = inVeh and tp.params.maxDistanceInVehicle or tp.params.maxDistanceOnFoot
        -- scale with the sampling interval (limits are defined for ~1s)
        limit = limit * math.max(1, dt)
        if dist > limit and not (tp.params.ignoreZones and (inZone(prev.pos) or inZone(cur.pos))) then
            findings[#findings + 1] = {
                key = 'movement.teleport',
                severity = dist >= tp.params.highSeverityDistance and 'HIGH' or nil,
                evidence = { distance = U.round(dist, 1), seconds = U.round(dt, 2), from = M.vec(prev.pos), to = M.vec(cur.pos), inVehicle = inVeh, limit = U.round(limit, 1) },
            }
            -- after a teleport the speed checks would double count
            return findings
        end
    end

    -- on-foot speed
    local sp = cfg['movement.speed']
    if sp and sp.enabled and not inVeh and not cur.attached then
        local falling = -vz > sp.params.fallingSpeedIgnore
        local n = streak('speed', hspeed > sp.params.maxOnFootSpeed and not falling)
        if n >= sp.params.consecutive then
            streaks.speed = nil
            findings[#findings + 1] = { key = 'movement.speed', evidence = { speed = U.round(hspeed, 2), limit = sp.params.maxOnFootSpeed, samples = n } }
        end
    else
        streaks.speed = nil
    end

    -- noclip: moving while the synced velocity says "standing still", or collision disabled
    local nc = cfg['movement.noclip']
    if nc and nc.enabled and not inVeh and not cur.attached then
        local displacement = dist / dt
        local suspicious = displacement > nc.params.minDisplacementSpeed and reported < nc.params.maxReportedVelocity
        local collision = nc.params.flagCollisionDisabled and cur.collisionDisabled and displacement > 1.0
        local n = streak('noclip', suspicious or collision)
        if n >= nc.params.consecutive then
            streaks.noclip = nil
            findings[#findings + 1] = {
                key = 'movement.noclip',
                evidence = { displacementSpeed = U.round(displacement, 2), reportedVelocity = U.round(reported, 2), collisionDisabled = cur.collisionDisabled == true, verticalSpeed = U.round(vz, 2), samples = n },
            }
        end
    else
        streaks.noclip = nil
    end

    -- vehicle speed (driver only, by vehicle type)
    local vs = cfg['movement.vehicle_speed']
    if vs and vs.enabled and cur.vehicle ~= 0 and cur.driver and cur.vehType then
        local limit = vs.params[cur.vehType]
        local vspeed = cur.vehSpeed or reported
        local n = streak('vspeed', limit ~= nil and vspeed > limit)
        if limit and n >= vs.params.consecutive then
            streaks.vspeed = nil
            findings[#findings + 1] = { key = 'movement.vehicle_speed', evidence = { speed = U.round(vspeed, 2), kmh = U.round(vspeed * 3.6, 0), limit = limit, vehicleType = cur.vehType, model = cur.vehModel } }
        end
    else
        streaks.vspeed = nil
    end
    return findings
end

function M.vec(v)
    return { x = U.round(v.x, 1), y = U.round(v.y, 1), z = U.round(v.z, 1) }
end

--- Reads one movement sample from the synced game state.
function M.sample(src, now)
    local ped = GetPlayerPed(src)
    if not ped or ped == 0 or not DoesEntityExist(ped) then return nil end
    local c = GetEntityCoords(ped)
    local v = GetEntityVelocity(ped)
    local veh = GetVehiclePedIsIn(ped, false)
    local s = {
        t = now, ped = ped,
        pos = { x = c.x, y = c.y, z = c.z },
        vel = { x = v.x, y = v.y, z = v.z },
        vehicle = veh or 0,
        attached = GetEntityAttachedTo(ped) ~= 0,
        collisionDisabled = GetEntityCollisionDisabled(ped),
        bucket = GetPlayerRoutingBucket(src),
        dead = GetEntityHealth(ped) <= 0,
    }
    if s.vehicle ~= 0 then
        s.vehType = GetVehicleType(s.vehicle)
        s.driver = GetPedInVehicleSeat(s.vehicle, -1) == ped
        s.vehSpeed = GetEntitySpeed(s.vehicle)
        s.vehModel = GetEntityModel(s.vehicle)
    end
    return s
end

local function tick(p, now)
    local cur = M.sample(p.src, now)
    if not cur then return end
    local prev = p.sample
    -- grace after respawn / ped change / bucket change
    if prev then
        if prev.ped ~= cur.ped then p.graceUntil = math.max(p.graceUntil, now + Config.Grace.modelChangeSeconds * 1000) end
        if prev.dead and not cur.dead then p.graceUntil = math.max(p.graceUntil, now + Config.Grace.respawnSeconds * 1000) end
        if prev.bucket ~= cur.bucket then p.graceUntil = math.max(p.graceUntil, now + Config.Grace.bucketChangeSeconds * 1000) end
    end
    p.sample = cur
    p.streaks = p.streaks or {}
    if now < (p.graceUntil or 0) then return end
    for _, f in ipairs(M.analyze(prev, cur, MG.Detections.modules, p.streaks)) do
        MG.Detections.report(p.src, f.key, { evidence = f.evidence, severity = f.severity })
    end

    -- super jump is a direct synced flag
    if MG.Detections.module('movement.superjump') and IsPlayerUsingSuperJump(tostring(p.src)) then
        MG.Detections.report(p.src, 'movement.superjump', { evidence = { pos = M.vec(cur.pos) } })
    end
end

function M.start()
    MG.Scheduler.every(Config.Performance.movementIntervalMs, tick)
end

return M
