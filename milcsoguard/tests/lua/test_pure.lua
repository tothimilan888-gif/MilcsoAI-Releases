-- Pure logic: util, rate limiter, risk engine, schema validation, analysers.
loadResource()
local U = MG.Util

describe('util', function()
    it('joaat matches GetHashKey for known names', function()
        expect(U.joaat('WEAPON_PISTOL')).toBe(453432689)       -- 0x1B06D571
        expect(U.joaat('weapon_unarmed')).toBe(2725352035)     -- 0xA2719263
        expect(U.joaat('adder')).toBe(3078201489)              -- 0xB779A091
    end)
    it('normalises signed hashes', function()
        expect(U.u32(-1)).toBe(4294967295)
        expect(U.u32(-1569615261)).toBe(2725352035)
        expect(U.toHash('-1569615261')).toBe(2725352035)
    end)
    it('round-trips ISO timestamps in UTC', function()
        local t = 1767225600 -- 2026-01-01T00:00:00Z
        expect(U.isoTime(t)).toBe('2026-01-01T00:00:00Z')
        expect(U.parseIso('2026-01-01T00:00:00.000Z')).toBe(t)
        expect(U.parseIso(U.isoTime(1760001234))).toBe(1760001234)
        expect(U.parseIso('garbage')).toBeNil()
    end)
    it('sanitises player names', function()
        expect(U.sanitize('^1Red^7 Name\n')).toBe('Red Name')
        expect(#U.sanitize(string.rep('x', 300), 64)).toBe(64)
    end)
    it('encodes empty objects as {} with U.obj', function()
        expect(json.encode({})).toBe('[]')
        expect(json.encode(U.obj({}))).toBe('{}')
    end)
end)

describe('rate limiter', function()
    it('allows up to the limit and blocks above it', function()
        local rl = MG.RateLimiter.new(3, 1000)
        expect(rl:hit('a', 0)).toBe(true)
        expect(rl:hit('a', 10)).toBe(true)
        expect(rl:hit('a', 20)).toBe(true)
        expect(rl:hit('a', 30)).toBe(false)
        expect(rl:hit('b', 30)).toBe(true)
    end)
    it('recovers after the window', function()
        local rl = MG.RateLimiter.new(2, 1000)
        rl:hit('a', 0); rl:hit('a', 0)
        expect(rl:hit('a', 2500)).toBe(true)
    end)
end)

describe('risk engine', function()
    local cfg = {
        halfLifeMs = 60000, thresholds = { warn = 25, monitor = 45, kick = 80, ban = 140 },
        minDistinctServerTypesForBan = 2, autoBanEnabled = true,
        severityPoints = { INFO = 0, LOW = 5, MEDIUM = 15, HIGH = 35, CRITICAL = 60 },
        sourceMultiplier = { server = 1.0, event = 1.0, client = 0.5 },
    }
    it('decays with the half-life', function()
        local s = MG.Risk.newState()
        MG.Risk.add(s, cfg, 0, 100, 'a', 'server')
        expect(math.floor(MG.Risk.decayed(s, 60000, cfg.halfLifeMs) + 0.5)).toBe(50)
        expect(math.floor(MG.Risk.decayed(s, 120000, cfg.halfLifeMs) + 0.5)).toBe(25)
    end)
    it('weights client signals lower', function()
        expect(MG.Risk.points(cfg, 'HIGH', 'client')).toBe(17.5)
        expect(MG.Risk.points(cfg, 'HIGH', 'server')).toBe(35.0)
    end)
    it('escalates by threshold', function()
        expect(MG.Risk.thresholdAction(cfg, 10)).toBe('log')
        expect(MG.Risk.thresholdAction(cfg, 50)).toBe('monitor')
        expect(MG.Risk.thresholdAction(cfg, 200)).toBe('ban')
    end)
    it('never bans on a client-only signal', function()
        local a, note = MG.Risk.decide(cfg, { moduleAction = 'kick', source = 'client', score = 500, distinctServerTypes = 0 })
        expect(a).toBe('kick')
        expect(note).toContain('client-only')
    end)
    it('requires corroboration by independent server-side detections', function()
        expect((MG.Risk.decide(cfg, { moduleAction = 'warn', source = 'server', score = 200, distinctServerTypes = 1 }))).toBe('kick')
        expect((MG.Risk.decide(cfg, { moduleAction = 'warn', source = 'server', score = 200, distinctServerTypes = 2 }))).toBe('ban')
    end)
    it('allows conclusive server-side evidence to ban alone', function()
        expect((MG.Risk.decide(cfg, { moduleAction = 'ban', source = 'event', conclusive = true, score = 60, distinctServerTypes = 1 }))).toBe('ban')
        expect((MG.Risk.decide(cfg, { moduleAction = 'ban', source = 'client', conclusive = true, score = 60, distinctServerTypes = 0 }))).toBe('kick')
    end)
    it('downgrades when the breaker is open or auto-ban is disabled', function()
        expect((MG.Risk.decide(cfg, { moduleAction = 'ban', source = 'event', conclusive = true, score = 60, distinctServerTypes = 3, breakerOpen = true }))).toBe('kick')
        local off = U.deepCopy(cfg); off.autoBanEnabled = false
        expect((MG.Risk.decide(off, { moduleAction = 'ban', source = 'event', conclusive = true, score = 60, distinctServerTypes = 3 }))).toBe('kick')
    end)
    it('breaker opens after max bans and closes after the window', function()
        local b = MG.Risk.Breaker.new(2, 1000)
        b:record(0); b:record(10)
        expect(b:isOpen(20)).toBe(true)
        expect(b:isOpen(1500)).toBe(false)
    end)
end)

describe('schema validation', function()
    it('accepts valid overrides and layers local < remote', function()
        local clean, issues = MG.Schema.validate({ modules = { ['movement.teleport'] = { action = 'kick', params = { maxDistanceOnFoot = 200 } } }, risk = { banThreshold = 200 } })
        expect(#issues).toBe(0)
        local modules, risk = MG.Schema.build({ modules = { ['movement.teleport'] = { params = { maxDistanceOnFoot = 150, maxDistanceInVehicle = 999 } } } }, clean)
        expect(modules['movement.teleport'].action).toBe('kick')
        expect(modules['movement.teleport'].params.maxDistanceOnFoot).toBe(200)
        expect(modules['movement.teleport'].params.maxDistanceInVehicle).toBe(999)
        expect(risk.banThreshold).toBe(200)
        expect(risk.kickThreshold).toBe(80)
    end)
    it('reports precise paths for invalid values and drops them', function()
        local clean, issues = MG.Schema.validate({
            modules = { ['movement.teleport'] = { params = { maxDistanceOnFoot = 1 }, action = 'nuke', extra = 1 }, ['nope.module'] = {} },
            risk = { banThreshold = 1.5 }, other = true,
        })
        local paths = {}
        for _, i in ipairs(issues) do paths[#paths + 1] = i.path end
        expect(paths).toContain('modules.movement.teleport.params.maxDistanceOnFoot')
        expect(paths).toContain('modules.movement.teleport.action')
        expect(paths).toContain('modules.movement.teleport.extra')
        expect(paths).toContain('modules.nope.module')
        expect(paths).toContain('risk.banThreshold')
        expect(paths).toContain('other')
        expect(clean.modules['movement.teleport'].params.maxDistanceOnFoot).toBeNil()
    end)
    it('forbids automatic bans from client modules', function()
        local _, issues = MG.Schema.validate({ modules = { ['client.heartbeat'] = { action = 'ban' } } })
        expect(issues[1].message).toContain('client-side')
    end)
    it('checks threshold ordering', function()
        local _, risk = MG.Schema.build(nil, { risk = { kickThreshold = 500 } })
        expect(#MG.Schema.checkRisk(risk)).toBe(1)
    end)
    it('every module default is valid against its own schema', function()
        for key, spec in pairs(MG.Schema.modules) do
            local params = {}
            for pk, ps in pairs(spec.params) do params[pk] = ps.default end
            local _, issues = MG.Schema.validate({ modules = { [key] = { enabled = spec.defaults.enabled, action = spec.defaults.action, severity = spec.defaults.severity, params = params } } })
            if #issues > 0 then error(key .. ': ' .. json.encode(issues)) end
        end
    end)
    it('descriptor JSON keeps empty records as objects', function()
        local d = json.decode(json.encode(MG.Schema.descriptor()))
        local raw = json.encode(MG.Schema.descriptor())
        expect(raw).toContain('"movement.superjump":{')
        expect(raw:find('"params":%[%]')).toBeNil()
        expect(d.version).toBe(1)
    end)
end)

describe('movement analysis', function()
    local modules = MG.Schema.build(nil, nil)
    local function s(t, x, y, z, extra)
        local r = { t = t, ped = 1, bucket = 0, pos = { x = x, y = y, z = z }, vel = { x = 0, y = 0, z = 0 }, vehicle = 0, attached = false, collisionDisabled = false, dead = false }
        for k, v in pairs(extra or {}) do r[k] = v end
        return r
    end
    it('flags a teleport', function()
        local f = MG.Movement.analyze(s(0, 0, 0, 0), s(1000, 800, 0, 0), modules, {})
        expect(f[1].key).toBe('movement.teleport')
        expect(f[1].evidence.distance).toBe(800)
    end)
    it('ignores normal walking and sprinting', function()
        local streaks = {}
        for i = 1, 10 do
            local f = MG.Movement.analyze(s((i - 1) * 1000, (i - 1) * 7, 0, 0, { vel = { x = 7, y = 0, z = 0 } }), s(i * 1000, i * 7, 0, 0, { vel = { x = 7, y = 0, z = 0 } }), modules, streaks)
            expect(#f).toBe(0)
        end
    end)
    it('ignores teleports inside configured zones', function()
        Config.TeleportZones = { { x = 800, y = 0, z = 0, radius = 20 } }
        expect(#MG.Movement.analyze(s(0, 0, 0, 0), s(1000, 800, 0, 0), modules, {})).toBe(0)
        Config.TeleportZones = {}
    end)
    it('needs consecutive samples for speedhack and skips falling', function()
        local streaks = {}
        local fast = { vel = { x = 30, y = 0, z = 0 } }
        expect(#MG.Movement.analyze(s(0, 0, 0, 0, fast), s(1000, 30, 0, 0, fast), modules, streaks)).toBe(0)
        expect(#MG.Movement.analyze(s(1000, 30, 0, 0, fast), s(2000, 60, 0, 0, fast), modules, streaks)).toBe(0)
        local f = MG.Movement.analyze(s(2000, 60, 0, 0, fast), s(3000, 90, 0, 0, fast), modules, streaks)
        expect(f[1].key).toBe('movement.speed')
        local falling = {}
        for i = 1, 5 do
            local r = MG.Movement.analyze(s(i * 1000, i * 30, 0, 500 - i * 20, fast), s((i + 1) * 1000, (i + 1) * 30, 0, 500 - (i + 1) * 20, fast), modules, falling)
            expect(#r).toBe(0)
        end
    end)
    it('flags noclip: moving with zero synced velocity', function()
        local streaks, found = {}, nil
        for i = 1, 3 do
            local f = MG.Movement.analyze(s((i - 1) * 1000, (i - 1) * 10, 0, 50), s(i * 1000, i * 10, 0, 50), modules, streaks)
            found = found or f[1]
        end
        expect(found.key).toBe('movement.noclip')
    end)
    it('does not flag attached peds (carried / cuffed)', function()
        local streaks = {}
        for i = 1, 5 do
            expect(#MG.Movement.analyze(s((i - 1) * 1000, (i - 1) * 10, 0, 50, { attached = true }), s(i * 1000, i * 10, 0, 50, { attached = true }), modules, streaks)).toBe(0)
        end
    end)
    it('resets the baseline on respawn, model or bucket change and on lag gaps', function()
        expect(#MG.Movement.analyze(s(0, 0, 0, 0), s(1000, 5000, 0, 0, { ped = 2 }), modules, {})).toBe(0)
        expect(#MG.Movement.analyze(s(0, 0, 0, 0), s(1000, 5000, 0, 0, { bucket = 3 }), modules, {})).toBe(0)
        expect(#MG.Movement.analyze(s(0, 0, 0, 0, { dead = true }), s(1000, 5000, 0, 0), modules, {})).toBe(0)
        expect(#MG.Movement.analyze(s(0, 0, 0, 0), s(9000, 5000, 0, 0), modules, {})).toBe(0)
    end)
    it('flags excessive vehicle speed for the driver only', function()
        local car = { vehicle = 5, vehType = 'automobile', driver = true, vehSpeed = 140 }
        local streaks = {}
        MG.Movement.analyze(s(0, 0, 0, 0, car), s(1000, 140, 0, 0, car), modules, streaks)
        local f = MG.Movement.analyze(s(1000, 140, 0, 0, car), s(2000, 280, 0, 0, car), modules, streaks)
        expect(f[1].key).toBe('movement.vehicle_speed')
        local passenger = { vehicle = 5, vehType = 'automobile', driver = false, vehSpeed = 140 }
        local st2 = {}
        MG.Movement.analyze(s(0, 0, 0, 0, passenger), s(1000, 140, 0, 0, passenger), modules, st2)
        expect(#MG.Movement.analyze(s(1000, 140, 0, 0, passenger), s(2000, 280, 0, 0, passenger), modules, st2)).toBe(0)
    end)
end)

describe('weapon damage analysis', function()
    local params = MG.Schema.build(nil, nil)['weapons.damage'].params
    local PISTOL, KNIFE = U.joaat('WEAPON_PISTOL'), U.joaat('WEAPON_KNIFE')
    it('caps damage values', function()
        local f = MG.WeaponChecks.evaluateDamage({ weaponType = PISTOL, overrideDefaultDamage = true, weaponDamage = 5000 }, { now = 0, selected = PISTOL, mismatches = {} }, params)
        expect(f[1].reason).toBe('damage_cap')
        expect(f[1].cancel).toBe(true)
    end)
    it('flags melee hits from far away', function()
        local f = MG.WeaponChecks.evaluateDamage({ weaponType = KNIFE }, { now = 0, selected = KNIFE, distance = 40, mismatches = {} }, params)
        expect(f[1].reason).toBe('melee_distance')
    end)
    it('counts weapon mismatches before flagging and ignores vehicles', function()
        local m = {}
        local ctx = { selected = U.joaat('WEAPON_UNARMED'), mismatches = m }
        for i = 1, params.weaponMismatchCount - 1 do
            ctx.now = i * 100
            expect(#MG.WeaponChecks.evaluateDamage({ weaponType = PISTOL }, ctx, params)).toBe(0)
        end
        ctx.now = 1000
        expect(MG.WeaponChecks.evaluateDamage({ weaponType = PISTOL }, ctx, params)[1].reason).toBe('weapon_mismatch')
        expect(#MG.WeaponChecks.evaluateDamage({ weaponType = PISTOL }, { now = 0, selected = 0, inVehicle = true, mismatches = {} }, params)).toBe(0)
    end)
    it('legit hit produces nothing', function()
        expect(#MG.WeaponChecks.evaluateDamage({ weaponType = PISTOL, overrideDefaultDamage = false, weaponDamage = 0 }, { now = 0, selected = PISTOL, distance = 30, mismatches = {} }, params)).toBe(0)
    end)
end)

describe('entity & explosion analysis', function()
    local p = { src = 7 }
    it('allows ambient population and trusted resources', function()
        expect(MG.EntityChecks.evaluateEntity(p, { pop = 5, etype = 2, model = U.joaat('blimp'), now = 0 })).toBe('allow')
        MG.Trusted.resources = { ['qb-garages'] = true }
        expect(MG.EntityChecks.evaluateEntity(p, { pop = 7, etype = 2, model = U.joaat('blimp'), script = 'qb-garages', now = 0 })).toBe('allow')
        MG.Trusted.resources = {}
    end)
    it('blocks blacklisted models and floods', function()
        expect(MG.EntityChecks.evaluateEntity(p, { pop = 7, etype = 2, model = U.joaat('blimp'), now = 0 })).toBe('blacklisted')
        local verdict
        for i = 1, 8 do verdict = MG.EntityChecks.evaluateEntity(p, { pop = 7, etype = 2, model = U.joaat('adder'), now = i }) end
        expect(verdict).toBe('flood')
    end)
    it('consumes expected spawns', function()
        local q = { src = 8, expected = { [U.joaat('blimp')] = { count = 1, untilMs = 1000 } } }
        expect(MG.EntityChecks.evaluateEntity(q, { pop = 7, etype = 2, model = U.joaat('blimp'), now = 10 })).toBe('allow')
        expect(MG.EntityChecks.evaluateEntity(q, { pop = 7, etype = 2, model = U.joaat('blimp'), now = 20 })).toBe('blacklisted')
    end)
    it('evaluates explosions', function()
        local params = MG.Schema.build(nil, nil)['explosions.filter'].params
        expect(MG.EntityChecks.evaluateExplosion(1, { explosionType = 59, damageScale = 1, isAudible = true }, params, 0)).toContain('blacklisted_type')
        expect(MG.EntityChecks.evaluateExplosion(2, { explosionType = 2, isInvisible = true, isAudible = false, damageScale = 1 }, params, 0)).toContain('invisible_silent')
        expect(MG.EntityChecks.evaluateExplosion(3, { explosionType = 2, damageScale = 8, isAudible = true }, params, 0)).toContain('damage_scale')
        expect(#MG.EntityChecks.evaluateExplosion(4, { explosionType = 2, damageScale = 1, isAudible = true }, params, 0)).toBe(0)
        local r
        for i = 1, 7 do r = MG.EntityChecks.evaluateExplosion(5, { explosionType = 2, damageScale = 1, isAudible = true }, params, i) end
        expect(r).toContain('rate')
    end)
end)

describe('economy and heartbeat', function()
    local eco = MG.Schema.build(nil, nil)['economy.transactions'].params
    it('flags large single and accumulated money gains', function()
        expect((MG.EventChecks.evaluateMoney({ entries = {} }, 600000, 0, eco))).toBe('single')
        local st = { entries = {} }
        local v
        for i = 1, 5 do v = MG.EventChecks.evaluateMoney(st, 450000, i * 1000, eco) end
        expect(v).toBe('window')
        expect((MG.EventChecks.evaluateMoney({ entries = {} }, 1000, 0, eco))).toBeNil()
    end)
    it('heartbeat: misses counted only after ready', function()
        local params = { maxMisses = 2, readyTimeoutSeconds = 60 }
        local hb = { ready = false, misses = 0 }
        expect(MG.ResourceChecks.heartbeatStep(hb, 30000, 0, params)).toBeNil()
        expect(MG.ResourceChecks.heartbeatStep(hb, 61000, 0, params)).toBe('not_ready')
        expect(MG.ResourceChecks.heartbeatStep(hb, 90000, 0, params)).toBeNil()
        hb.ready = true; hb.nonce = 'x'
        expect(MG.ResourceChecks.heartbeatStep(hb, 1, 0, params)).toBeNil()
        expect(MG.ResourceChecks.heartbeatStep(hb, 2, 0, params)).toBe('missed')
    end)
end)
