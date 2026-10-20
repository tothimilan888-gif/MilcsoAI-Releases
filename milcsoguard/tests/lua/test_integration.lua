-- End-to-end flows of the server resource against the FXServer mock and a fake backend.
local Mock = MockFX
Mock.convars = { onesync = 'on', milcsoguard_api_url = 'https://ac.test', milcsoguard_api_key = 'mgk_AAAAAAAAAA_' .. string.rep('k', 43), sv_entityLockdown = 'relaxed' }

local backend = { up = true, bans = {}, detections = {}, commands = {}, banned = {}, admins = {}, configVersion = 0, overrides = {}, connectCalls = 0 }
Mock.http = function(method, path, body)
    if not backend.up then return 0, nil end
    path = path:gsub('^/api/v1/game', '')
    if path == '/handshake' then
        backend.schema = body.schema
        return 200, { serverId = 'srv', serverName = 'Test', banMatchTypes = { 'license', 'discord' }, config = { version = backend.configVersion, overrides = backend.overrides }, whitelist = backend.whitelist or {} }
    elseif path == '/players/connect' then
        backend.connectCalls = backend.connectCalls + 1
        for _, i in ipairs(body.identifiers) do
            if backend.banned[i] then return 200, { playerId = 'p1', ban = backend.banned[i], whitelist = {}, admin = nil } end
        end
        local admin = nil
        for _, i in ipairs(body.identifiers) do if backend.admins[i] then admin = backend.admins[i] end end
        return 200, { playerId = 'p1', ban = json.null, whitelist = {}, admin = admin }
    elseif path == '/detections' then
        for _, d in ipairs(body.detections) do backend.detections[#backend.detections + 1] = d end
        return 200, { ids = {}, created = #body.detections }
    elseif path == '/bans' then
        if backend.rejectBans then return 422, { error = { message = 'nope' } } end
        backend.bans[#backend.bans + 1] = body
        return 200, { ban = { id = 'remote-' .. #backend.bans, code = 'MG-TEST' .. #backend.bans, reason = body.reason, playerName = body.playerName, identifiers = body.identifiers, createdAt = '2026-01-01T00:00:00Z', expiresAt = json.null }, created = true }
    elseif path:match('^/bans/sync') then
        return 200, { now = '2026-01-02T00:00:00Z', full = not path:find('since'), matchTypes = { 'license', 'discord' }, bans = backend.syncBans or {}, inactive = backend.inactive or {} }
    elseif path == '/commands' then
        local c = backend.commands
        backend.commands = {}
        return 200, { commands = c }
    elseif path:match('^/commands/.+/ack') then
        backend.acks = backend.acks or {}
        backend.acks[#backend.acks + 1] = body
        return 200, { ok = true }
    elseif path == '/heartbeat' then
        backend.heartbeats = (backend.heartbeats or 0) + 1
        backend.lastHeartbeat = body
        return 200, { configVersion = backend.configVersion, pendingCommands = 0 }
    elseif path == '/config' then
        return 200, { version = backend.configVersion, overrides = backend.overrides, whitelist = backend.whitelist or {}, banMatchTypes = { 'license', 'discord' } }
    end
    return 200, { ok = true }
end

loadResource()
Mock.advance(1000)

local function deferralsMock()
    local d = { result = nil, updates = {} }
    function d.defer() end
    function d.update(m) d.updates[#d.updates + 1] = m end
    function d.done(m) d.result = m or true end
    return d
end

local nextTemp = 60000
--- Simulates the full connect -> join sequence. Returns the deferral result (true = admitted).
local function connect(src, opts)
    nextTemp = nextTemp + 1
    local temp = nextTemp
    opts = opts or {}
    -- identifiers belong to the person, not to the (temporary) server id
    opts.identifiers = opts.identifiers or { 'license:' .. string.format('%040x', src), 'discord:1000000000000000' .. src, 'ip:10.0.0.' .. src }
    opts.name = opts.name or ('P' .. src)
    Mock.addPlayer(temp, opts)
    local d = deferralsMock()
    Mock.trigger('playerConnecting', temp, opts.name, function() end, d)
    Mock.advance(200)
    if d.result ~= true then
        Mock.removePlayer(temp)
        return d.result
    end
    local p = Mock.players[temp]
    Mock.players[temp] = nil
    Mock.entities[p.ped] = nil
    Mock.addPlayer(src, opts)
    Mock.trigger('playerJoining', src, tostring(temp))
    Mock.advance(100)
    return true
end

local function lastDropped()
    return Mock.dropped[#Mock.dropped]
end

describe('start-up', function()
    it('handshakes with the backend and reports the schema', function()
        expect(MG.Sync.handshakeDone).toBe(true)
        expect(backend.schema.modules['movement.teleport'].label).toBe('Teleport anomália')
        expect(#Mock.requests('/bans/sync')).toBeGreaterThan(0)
    end)
    it('never sends the API key anywhere but the Authorization header', function()
        local r = Mock.requests('/handshake')[1]
        expect(r.headers.Authorization).toContain('Bearer mgk_')
        expect(json.encode(r.body):find('mgk_', 1, true)).toBeNil()
    end)
end)

describe('connection ban checks', function()
    it('admits a clean player', function()
        expect(connect(1)).toBe(true)
        expect(MG.State.get(1)).toBeTruthy()
    end)
    it('rejects a player banned in the backend and caches the ban locally', function()
        backend.banned['license:' .. string.rep('2', 40)] = { id = 'b-1', code = 'MG-ABC', reason = 'Aimbot', expiresAt = json.null }
        local r = connect(2, { identifiers = { 'license:' .. string.rep('2', 40) } })
        expect(r).toContain('Aimbot')
        expect(r).toContain('MG-ABC')
        expect(MG.Bans.byId['b-1']).toBeTruthy()
    end)
    it('still enforces cached bans while the backend is down', function()
        backend.up = false
        local r = connect(3, { identifiers = { 'license:' .. string.rep('2', 40) } })
        expect(r).toContain('Aimbot')
        backend.up = true
        MG.Api.nextAttemptAt = 0
    end)
    it('admits unknown players when the backend is down (fail-open) without mass rejections', function()
        backend.up = false
        MG.Api.nextAttemptAt = 0
        expect(connect(4, { identifiers = { 'license:' .. string.rep('4', 40) } })).toBe(true)
        backend.up = true
        MG.Api.nextAttemptAt = 0
        Mock.advance(1000)
    end)
    it('refuses connections without a license identifier', function()
        local r = connect(5, { identifiers = { 'discord:123456789012345678' } })
        expect(r).toContain('license')
    end)
    it('survives a restart: bans are reloaded from KVP', function()
        local count = MG.Bans.count()
        MG.Bans.byId, MG.Bans.index = {}, {}
        MG.Bans.load()
        expect(MG.Bans.count()).toBe(count)
        expect(MG.Bans.find({ 'license:' .. string.rep('2', 40) }).code).toBe('MG-ABC')
    end)
end)

describe('detection pipeline', function()
    it('reports a teleport, warns, and ships it to the backend', function()
        connect(10)
        local p = MG.State.get(10)
        p.graceUntil = 0
        Mock.advance(1100)
        Mock.ped(10).pos = Mock.vec(3000, 3000, 70)
        Mock.advance(1100)
        local rec = MG.Detections.recent(1)[1]
        expect(rec.type).toBe('movement.teleport')
        expect(rec.action).toBe('warn')
        expect(rec.source).toBe('server')
        Mock.advance(6000)
        local found = false
        for _, d in ipairs(backend.detections) do if d.localId == rec.localId then found = true end end
        expect(found).toBe(true)
        -- the IP identifier never leaves the server
        for _, i in ipairs(rec.identifiers) do expect(i:sub(1, 3) ~= 'ip:').toBe(true) end
    end)
    it('honours AllowMovement for server-initiated teleports', function()
        local before = #MG.Detections.ring
        Mock.exportsTable.AllowMovement(10, 5000)
        Mock.ped(10).pos = Mock.vec(-3000, -3000, 70)
        Mock.advance(2200)
        expect(#MG.Detections.ring).toBe(before)
    end)
    it('admins with bypass skip movement checks', function()
        connect(11)
        Mock.ace['11|milcsoguard.role.administrator'] = true
        MG.Permissions.refresh(11)
        local p = MG.State.get(11)
        p.graceUntil = 0
        Mock.advance(1100)
        local before = #MG.Detections.ring
        Mock.ped(11).pos = Mock.vec(5000, 0, 70)
        Mock.advance(1100)
        expect(#MG.Detections.ring).toBe(before)
    end)
    it('deduplicates repeated detections', function()
        local p = MG.State.get(10)
        local a = MG.Detections.report(10, 'events.reported', { evidence = { n = 1 } })
        local b = MG.Detections.report(10, 'events.reported', { evidence = { n = 2 } })
        expect(a).toBeTruthy()
        expect(b).toBeNil()
        expect(a.repeats).toBe(2)
    end)
    it('a client-side signal never bans, even with huge risk', function()
        connect(12)
        local p = MG.State.get(12)
        p.risk.score = 10000
        p.risk.updatedAt = Mock.now
        local rec = MG.Detections.report(12, 'client.resource_injection', { evidence = {} })
        expect(rec.action).toBe('kick')
        expect(rec.actionResult).toContain('client-only')
        Mock.advance(500)
        expect(lastDropped().src).toBe(12)
        expect(lastDropped().reason).toContain('kickelve')
    end)
    it('bans only with two independent server-side detection types, and queues the ban', function()
        connect(13, { identifiers = { 'license:' .. string.rep('d', 40), 'discord:111111111111111111' } })
        local p = MG.State.get(13)
        p.graceUntil = 0
        local r1 = MG.Detections.report(13, 'player.health', { evidence = {} })       -- HIGH 35 -> warn threshold
        expect(r1.action).toBe('kick') -- module action kick
        Mock.advance(500)
        -- simulate same session continuing for the test: a fresh state with existing risk
        connect(14, { identifiers = { 'license:' .. string.rep('e', 40) } })
        local q = MG.State.get(14)
        q.graceUntil = 0
        MG.Detections.report(14, 'weapons.blacklist', { evidence = {} })           -- HIGH kick
        q = MG.State.get(14)
        q.risk.score = 130
        q.risk.updatedAt = Mock.now
        local rec = MG.Detections.report(14, 'explosions.filter', { severity = 'CRITICAL', evidence = {} })
        expect(rec.action).toBe('ban')
        Mock.advance(7000)
        local last = backend.bans[#backend.bans]
        expect(last.reason).toContain('Automatikus')
        expect(last.actor).toBeNil()
        expect(#last.detectionLocalIds).toBeGreaterThan(0)
        -- the local id was swapped for the remote one
        expect(MG.Bans.find({ 'license:' .. string.rep('e', 40) }).code).toContain('MG-TEST')
    end)
    it('the circuit breaker turns further automatic bans into kicks', function()
        MG.Detections.breaker.hits = {}
        for i = 1, 5 do MG.Detections.breaker:record(Mock.now) end
        connect(15, { identifiers = { 'license:' .. string.rep('f', 40) } })
        local q = MG.State.get(15)
        q.graceUntil = 0
        MG.Detections.report(15, 'weapons.blacklist', { evidence = {} })
        q.risk.score = 500
        local rec = MG.Detections.report(15, 'explosions.filter', { severity = 'CRITICAL', evidence = {} })
        expect(rec.action).toBe('kick')
        expect(rec.actionResult).toContain('circuit breaker')
        MG.Detections.breaker.hits = {}
    end)
end)

describe('game event handlers', function()
    it('cancels explosions of blacklisted types', function()
        connect(20)
        local cancelled = Mock.trigger('explosionEvent', nil, 20, { explosionType = 59, damageScale = 1.0, isAudible = true, isInvisible = false, posX = 1, posY = 2, posZ = 3 })
        expect(cancelled).toBe(true)
        expect(MG.Detections.recent(1)[1].type).toBe('explosions.filter')
        expect(MG.Detections.recent(1)[1].evidence.blocked).toBe(true)
    end)
    it('lets normal explosions through', function()
        connect(21)
        expect(Mock.trigger('explosionEvent', nil, 21, { explosionType = 7, damageScale = 1.0, isAudible = true, isInvisible = false })).toBe(false)
    end)
    it('cancels weapon gifts to other players', function()
        connect(22); connect(23)
        local victimPed = Mock.players[23].ped
        expect(Mock.trigger('giveWeaponEvent', nil, 22, { pedId = Mock.entities[victimPed].netId, weaponType = MG.Util.joaat('WEAPON_RPG'), ammo = 10, givenAsPickup = false })).toBe(true)
    end)
    it('ignores events about own ped', function()
        local ownPed = Mock.players[22].ped
        expect(Mock.trigger('removeAllWeaponsEvent', nil, 22, { pedId = Mock.entities[ownPed].netId })).toBe(false)
    end)
    it('blocks blacklisted entity spawns and allows trusted ones', function()
        connect(24)
        Mock.entities[9000] = { type = 2, pop = 7, model = MG.Util.joaat('rhino'), owner = 24, netId = 9000, pos = Mock.vec(0, 0, 0) }
        expect(Mock.trigger('entityCreating', nil, 9000)).toBe(true)
        Mock.entities[9001] = { type = 2, pop = 7, model = MG.Util.joaat('rhino'), owner = 24, netId = 9001, script = 'army_event', pos = Mock.vec(0, 0, 0) }
        MG.Trusted.resources.army_event = true
        expect(Mock.trigger('entityCreating', nil, 9001)).toBe(false)
    end)
    it('ExpectEntity lets a scripted client spawn through once', function()
        Mock.exportsTable.ExpectEntity(24, 'rhino', 1, 5000)
        Mock.entities[9002] = { type = 2, pop = 7, model = MG.Util.joaat('rhino'), owner = 24, netId = 9002, pos = Mock.vec(0, 0, 0) }
        expect(Mock.trigger('entityCreating', nil, 9002)).toBe(false)
        Mock.entities[9003] = { type = 2, pop = 7, model = MG.Util.joaat('rhino'), owner = 24, netId = 9003, pos = Mock.vec(0, 0, 0) }
        expect(Mock.trigger('entityCreating', nil, 9003)).toBe(true)
    end)
    it('CheckEvent rate limits other resources\' events', function()
        connect(25)
        local okCount = 0
        for _ = 1, 8 do if Mock.exportsTable.CheckEvent(25, 'shop:buy', { limit = 5, windowMs = 10000 }) then okCount = okCount + 1 end end
        expect(okCount).toBe(5)
        expect(MG.Detections.recent(1)[1].type).toBe('events.spam')
    end)
    it('rejects forged client heartbeat nonces', function()
        connect(26)
        local p = MG.State.get(26)
        Mock.trigger('milcsoguard:ready', 26)
        p.hb.nonce = 'expected'
        Mock.trigger('milcsoguard:hb', 26, 'forged')
        expect(p.hb.nonce).toBe('expected')
        Mock.trigger('milcsoguard:hb', 26, 'expected')
        expect(p.hb.nonce).toBeNil()
    end)
    it('flags spam of MilcsoGuard client events', function()
        connect(27)
        for _ = 1, 40 do Mock.trigger('milcsoguard:signal', 27, 'noop') end
        expect(MG.Detections.recent(1)[1].type).toBe('events.spam')
    end)
    it('honeypot events are conclusive and ban', function()
        Config.Modules['events.honeypot'] = { params = { events = { 'fakeshop:giveMoney' } } }
        MG.Sync.loadLocal()
        MG.Sync.applyConfig(nil, MG.Sync.configVersion)
        connect(28, { identifiers = { 'license:' .. string.rep('9', 40) } })
        MG.Detections.breaker.hits = {}
        Mock.trigger('fakeshop:giveMoney', 28, 999999)
        local rec = MG.Detections.recent(1)[1]
        expect(rec.type).toBe('events.honeypot')
        expect(rec.action).toBe('ban')
    end)
    it('does not arm honeypots that collide with an installed resource', function()
        Mock.resources['esx_society'] = 'started'
        expect((MG.EventChecks.safeHoneypot('esx_society:withdrawMoney'))).toBe(false)
        expect((MG.EventChecks.safeHoneypot('ghost_resource:event'))).toBe(true)
    end)
end)

describe('admin panel permissions', function()
    local reqId = 0
    local function request(src, action, payload)
        reqId = reqId + 1
        Mock.trigger('milcsoguard:admin:request', src, reqId, action, payload or {})
        Mock.advance(300)
        for _, e in ipairs(Mock.clientEventsNamed('milcsoguard:admin:response', src)) do
            if e.args[1] == reqId then return e.args[2] end
        end
        return nil
    end
    it('a normal player cannot open the panel or run actions', function()
        connect(30)
        Mock.commands.anticheat(30, {})
        expect(#Mock.clientEventsNamed('milcsoguard:admin:open', 30)).toBe(0)
        local r = request(30, 'kick', { id = 1, reason = 'test kick' })
        expect(r.ok).toBe(false)
        expect(r.error).toContain('Nincs jogosultságod')
    end)
    it('a moderator can open the panel but cannot permanently ban', function()
        connect(31)
        Mock.ace['31|milcsoguard.role.moderator'] = true
        Mock.commands.anticheat(31, {})
        local open = Mock.clientEventsNamed('milcsoguard:admin:open', 31)[1]
        expect(open.args[1].role).toBe('Moderator')
        connect(32)
        local r = request(31, 'ban.create', { id = 32, reason = 'Cheating', permanent = true })
        expect(r.ok).toBe(false)
        expect(r.error).toContain('bans.permanent')
    end)
    it('requires a reason and an explicit duration', function()
        local r = request(31, 'ban.create', { id = 32, reason = '' , durationSeconds = 3600 })
        expect(r.error).toContain('Indoklás')
        r = request(31, 'ban.create', { id = 32, reason = 'Cheating' })
        expect(r.error).toContain('időtartam')
    end)
    it('cannot ban an admin of the same or higher level', function()
        connect(33)
        Mock.ace['33|milcsoguard.role.administrator'] = true
        local r = request(31, 'ban.create', { id = 33, reason = 'Abuse', durationSeconds = 3600 })
        expect(r.error).toContain('magasabb')
    end)
    it('a moderator can temp-ban a player: dropped, cached, queued with the admin as actor', function()
        local r = request(31, 'ban.create', { id = 32, reason = 'Speedhack bizonyítva', durationSeconds = 3600 })
        expect(r.ok).toBe(true)
        expect(lastDropped().src).toBe(32)
        Mock.advance(6000)
        local last = backend.bans[#backend.bans]
        expect(last.actor.name).toBe('P31')
        expect(last.durationSeconds).toBe(3600)
    end)
    it('permission is re-checked on every request (revoked ACE takes effect immediately)', function()
        Mock.ace['31|milcsoguard.role.moderator'] = nil
        local r = request(31, 'players.list', {})
        expect(r.ok).toBe(false)
    end)
    it('an owner gets the full player list with identifiers', function()
        connect(34)
        Mock.ace['34|milcsoguard.role.owner'] = true
        local r = request(34, 'players.list', {})
        expect(r.ok).toBe(true)
        expect(#r.data).toBeGreaterThan(3)
    end)
    it('rejects invalid settings before sending them to the backend', function()
        local r = request(34, 'settings.save', { overrides = { modules = { ['client.heartbeat'] = { action = 'ban' } } }, note = 'próba' })
        expect(r.ok).toBe(false)
        expect(r.error).toContain('client-side')
    end)
    it('backend-linked admin rights come from /players/connect', function()
        backend.admins['license:' .. string.rep('7', 40)] = { role = 'developer', roleName = 'Developer', level = 90, permissions = { 'players.view', 'bans.view' } }
        connect(35, { identifiers = { 'license:' .. string.rep('7', 40) } })
        local a = MG.Permissions.refresh(35)
        expect(a.source).toBe('backend')
        expect(a.perms['players.view']).toBe(true)
        expect(a.perms['bans.create']).toBeNil()
    end)
end)

describe('remote configuration and commands', function()
    it('applies a valid remote config', function()
        backend.configVersion = 3
        backend.overrides = { modules = { ['movement.teleport'] = { action = 'kick' } } }
        Mock.advance(31000)
        expect(MG.Sync.configVersion).toBe(3)
        expect(MG.Detections.modules['movement.teleport'].action).toBe('kick')
    end)
    it('rejects an invalid remote config as a whole and keeps the previous one', function()
        backend.configVersion = 4
        backend.overrides = { modules = { ['movement.teleport'] = { action = 'warn' }, ['client.heartbeat'] = { action = 'ban' } } }
        Citizen.CreateThread(MG.Sync.pullConfig)
        Mock.advance(500)
        expect(MG.Sync.configVersion).toBe(3)
        expect(MG.Detections.modules['movement.teleport'].action).toBe('kick')
        expect(MG.Sync.rejectedVersion).toBe(4)
    end)
    it('executes a kick command only if the net id still belongs to the same identifiers', function()
        connect(40, { identifiers = { 'license:' .. string.rep('a', 39) .. 'b' } })
        backend.commands = {
            { id = 'c1', type = 'kick', payload = { netId = 40, identifiers = { 'license:' .. string.rep('c', 40) }, reason = 'x', by = 'web' } },
            { id = 'c2', type = 'kick', payload = { netId = 40, identifiers = { 'license:' .. string.rep('a', 39) .. 'b' }, reason = 'AFK', by = 'web' } },
        }
        Mock.advance(6000)
        local acks = backend.acks
        expect(acks[#acks - 1].status).toBe('failed')
        expect(acks[#acks].status).toBe('done')
        expect(lastDropped().src).toBe(40)
    end)
    it('heartbeat reports players without IP identifiers', function()
        Mock.advance(31000)
        local hb = backend.lastHeartbeat
        expect(#hb.players).toBeGreaterThan(0)
        for _, pl in ipairs(hb.players) do
            for _, i in ipairs(pl.identifiers) do expect(i:sub(1, 3) ~= 'ip:').toBe(true) end
        end
    end)
end)

describe('outbound queue', function()
    it('keeps items on 5xx/timeouts and persists them', function()
        backend.up = false
        MG.Api.nextAttemptAt = 0
        connect(50)
        MG.Detections.report(50, 'events.reported', { evidence = { x = 1 } })
        Mock.advance(10000)
        expect(#MG.Api.queue).toBeGreaterThan(0)
        expect(Mock.kvp['mg:queue']).toBeTruthy()
        backend.up = true
        MG.Api.nextAttemptAt = 0
        Mock.advance(10000)
        expect(#MG.Api.queue).toBe(0)
    end)
    it('drops items the backend permanently rejects (422) instead of retrying forever', function()
        backend.rejectBans = true
        MG.Bans.create({ identifiers = { 'license:' .. string.rep('1', 40) }, playerName = 'X', reason = 'Test', durationSeconds = 600 })
        Mock.advance(10000)
        expect(#MG.Api.queue).toBe(0)
        backend.rejectBans = false
    end)
end)
