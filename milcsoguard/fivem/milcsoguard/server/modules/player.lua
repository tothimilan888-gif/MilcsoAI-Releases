-- Player state checks from synced flags: invincibility, health/armour above max, invisibility,
-- damage modifiers. Each finding needs N consecutive samples to filter out transient states.
MG = MG or {}
local P = {}
MG.PlayerChecks = P

local function streakReport(p, key, cond, needed, evidence)
    if not cond then
        MG.State.clearStreak(p, key)
        return
    end
    local n = MG.State.streak(p, key)
    if n >= needed then
        MG.State.clearStreak(p, key)
        evidence.samples = n
        MG.Detections.report(p.src, key, { evidence = evidence })
    end
end

--- Pure evaluation used by tick() and the unit tests.
function P.evaluate(s, cfg)
    local out = {}
    local god = cfg['player.godmode']
    if god and god.enabled then out['player.godmode'] = { cond = s.invincible == true, needed = god.params.consecutive, evidence = { invincible = true } } end
    local hp = cfg['player.health']
    if hp and hp.enabled then
        local overHealth = s.health > s.maxHealth + hp.params.tolerance
        local overArmour = s.armour > s.maxArmour + hp.params.tolerance
        out['player.health'] = { cond = overHealth or overArmour, needed = hp.params.consecutive, evidence = { health = s.health, maxHealth = s.maxHealth, armour = s.armour, maxArmour = s.maxArmour } }
    end
    local inv = cfg['player.invisible']
    if inv and inv.enabled then out['player.invisible'] = { cond = (not s.visible) and s.health > 0, needed = inv.params.consecutive, evidence = { visible = false } } end
    local dm = cfg['player.damage_modifier']
    if dm and dm.enabled then
        out['player.damage_modifier'] = {
            cond = s.weaponMod > dm.params.maxWeaponModifier or s.meleeMod > dm.params.maxMeleeModifier, needed = 1,
            evidence = { weaponModifier = s.weaponMod, meleeModifier = s.meleeMod },
        }
    end
    return out
end

function P.sample(src)
    local ped = GetPlayerPed(src)
    if not ped or ped == 0 or not DoesEntityExist(ped) then return nil end
    local ssrc = tostring(src)
    return {
        invincible = GetPlayerInvincible(ssrc),
        health = GetEntityHealth(ped),
        maxHealth = GetEntityMaxHealth(ped),
        armour = GetPedArmour(ped),
        maxArmour = GetPlayerMaxArmour(ssrc),
        visible = IsEntityVisible(ped),
        weaponMod = GetPlayerWeaponDamageModifier(src) or 1.0,
        meleeMod = GetPlayerMeleeWeaponDamageModifier(src) or 1.0,
    }
end

local function tick(p, now)
    if now < (p.graceUntil or 0) then return end
    local s = P.sample(p.src)
    if not s then return end
    for key, r in pairs(P.evaluate(s, MG.Detections.modules)) do
        streakReport(p, key, r.cond, r.needed, r.evidence)
    end
end

function P.start()
    MG.Scheduler.every(Config.Performance.stateIntervalMs, tick)
end

return P
