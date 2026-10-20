-- POV replay capture, ban integration and the in-game admin tools, against the FXServer mock.
local Mock = MockFX
Mock.convars = { onesync = 'on', milcsoguard_api_url = 'https://ac.test', milcsoguard_api_key = 'mgk_AAAAAAAAAA_' .. string.rep('k', 43), sv_entityLockdown = 'relaxed' }

local backend = { replays = {}, parts = {}, completes = {}, bans = {}, commands = {}, acks = {}, audits = {}, adminParts = {} }
Mock.http = function(method, path, body)
    path = path:gsub('^/api/v1/game', '')
    if path == '/handshake' then
        return 200, { serverId = 'srv', serverName = 'Test', banMatchTypes = { 'license' }, config = { version = 0, overrides = {} }, whitelist = {} }
    elseif path == '/players/connect' then
        return 200, { playerId = 'p1', ban = json.null, whitelist = {}, admin = nil }
    elseif path == '/replays' then
        backend.replays[body.id] = body
        return 200, { ok = true, id = body.id }
    elseif path:match('^/replays/[^/]+/parts/%d+$') then
        local id, idx = path:match('^/replays/([^/]+)/parts/(%d+)$')
        backend.parts[id] = backend.parts[id] or {}
        backend.parts[id][tonumber(idx)] = body
        return 200, { ok = true }
    elseif path:match('^/replays/[^/]+/complete$') then
        backend.completes[path:match('^/replays/([^/]+)/complete$')] = body
        return 200, { ok = true, status = body.status }
    elseif path == '/bans' then
        backend.bans[#backend.bans + 1] = body
        return 200, { ban = { id = '9f0c2d4e-1111-4222-8333-444455556666', code = 'MG-R' .. #backend.bans, reason = body.reason, playerName = body.playerName, identifiers = body.identifiers, createdAt = '2026-01-01T00:00:00Z', expiresAt = json.null }, created = true }
    elseif path:match('^/bans/sync') then
        return 200, { now = '2026-01-02T00:00:00Z', full = true, matchTypes = { 'license' }, bans = backend.syncBans or {}, inactive = {} }
    elseif path == '/commands' then
        local c = backend.commands
        backend.commands = {}
        return 200, { commands = c }
    elseif path:match('^/commands/.+/ack') then
        backend.acks[#backend.acks + 1] = body
        return 200, { ok = true }
    elseif path == '/admin/audit' then
        backend.audits[#backend.audits + 1] = body
        return 200, { ok = true }
    elseif path:match('^/admin/replays/[^/]+/parts/%d+$') then
        local idx = tonumber(path:match('(%d+)$'))
        return 200, { mime = 'video/webm', durationMs = 5000, data = 'GkXfo' .. idx }
    elseif path:match('^/admin/replays/[^/]+/viewed$') then
        backend.viewed = body
        return 200, { ok = true }
    elseif path:match('^/admin/replays/[^/]+$') then
        return 200, { replay = { id = path:match('([^/]+)$'), status = 'ready', player_name = 'X', mime = 'video/webm' }, parts = { { idx = 0, duration_ms = 5000 }, { idx = 1, duration_ms = 4000 } } }
    end
    return 200, { ok = true }
end

loadResource()
Mock.advance(1000)

local function connect(src, opts)
    opts = opts or {}
    opts.identifiers = opts.identifiers or { 'license:' .. string.format('%040x', src), 'ip:10.0.0.' .. src }
    Mock.addPlayer(src, opts)
    local d = {}
    d.defer = function() end
    d.update = function() end
    d.done = function(m) d.result = m or true end
    Mock.trigger('playerConnecting', src, opts.name or ('P' .. src), function() end, d)
    Mock.advance(200)
    Mock.trigger('playerJoining', src, tostring(src))
    Mock.advance(100)
    return MG.State.get(src)
end

local function captureId(src)
    local ev = Mock.clientEventsNamed('milcsoguard:replay:capture', src)
    return ev[#ev] and ev[#ev].args[1]
end

local function droppedSrc(src)
    for _, d in ipairs(Mock.dropped) do if d.src == src then return d end end
    return nil
end

--- What the NUI + client bridge would send: parts of base64 split into chunks, then the manifest.
local function sendReplay(src, id, parts)
    local manifest = { parts = {}, width = 854, height = 480, fps = 15 }
    for idx, chunks in ipairs(parts) do
        manifest.parts[idx] = { chunks = #chunks, durationMs = 5000 }
        for seq, data in ipairs(chunks) do Mock.trigger('milcsoguard:replay:chunk', src, id, idx - 1, seq - 1, data) end
    end
    Mock.trigger('milcsoguard:replay:done', src, id, manifest)
    Mock.advance(500)
end

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

Mock.ace['1|milcsoguard.role.administrator'] = true
connect(1, { name = 'Admin' })

describe('client config', function()
    it('sends the recorder settings with the client config', function()
        local p = connect(2)
        Mock.trigger('milcsoguard:ready', 2)
        local cfg = Mock.clientEventsNamed('milcsoguard:clientConfig', 2)[1].args[1]
        expect(cfg.replay.seconds).toBe(15)
        expect(cfg.replay.width).toBe(854)
        expect(p.replayState).toBeNil()
        Mock.trigger('milcsoguard:replay:status', 2, 'recording', 'vp8')
        expect(p.replayState).toBe('recording')
        Mock.trigger('milcsoguard:replay:status', 2, 'pwned', 'x')
        expect(p.replayState).toBe('recording')
    end)
end)

describe('ban with replay', function()
    it('captures, isolates and drops only after the replay arrived', function()
        local p = connect(10, { name = 'Cheater' })
        Mock.trigger('milcsoguard:replay:status', 10, 'recording', '')
        local r = request(1, 'ban.create', { id = 10, reason = 'aimbot test', durationSeconds = 3600 })
        expect(r.ok).toBe(true)
        expect(r.data.replay).toBe(true)
        local id = captureId(10)
        expect(MG.Replay.isUuid(id)).toBe(true)
        expect(droppedSrc(10)).toBeNil()
        Mock.advance(1200)
        expect(Mock.players[10].bucket).toBe(60010)
        expect(Mock.ped(10).frozen).toBe(true)
        -- reconnecting meanwhile is refused: the ban is already cached
        expect(MG.Bans.find(p.identifiers)).toBeTruthy()

        sendReplay(10, id, { { 'GkXfo1', 'AAAA' }, { 'GkXfo2' } })
        local d = droppedSrc(10)
        expect(d).toBeTruthy()
        expect(d.reason).toContain('aimbot test')
        Mock.advance(500)
        local meta = backend.replays[id]
        expect(meta.kind).toBe('ban')
        expect(meta.banLocalId:sub(1, 5)).toBe('gban-')
        expect(meta.width).toBe(854)
        expect(backend.parts[id][0].data).toBe('GkXfo1AAAA')
        expect(backend.parts[id][1].data).toBe('GkXfo2')
        expect(backend.parts[id][0].durationMs).toBe(5000)
        expect(backend.completes[id].status).toBe('ready')
    end)

    it('drops at once when the recorder is not running (no waiting on a client that cannot answer)', function()
        connect(11)
        local r = request(1, 'ban.create', { id = 11, reason = 'no recorder', durationSeconds = 3600 })
        expect(r.data.replay).toBe(false)
        expect(captureId(11)).toBeNil()
        Mock.advance(300)
        expect(droppedSrc(11)).toBeTruthy()
    end)

    it('drops after the timeout when the client never answers', function()
        connect(12)
        Mock.trigger('milcsoguard:replay:status', 12, 'recording', '')
        request(1, 'ban.create', { id = 12, reason = 'silent client', durationSeconds = 3600 })
        local id = captureId(12)
        Mock.advance(20000)
        expect(droppedSrc(12)).toBeNil()
        Mock.advance(6000)
        expect(droppedSrc(12)).toBeTruthy()
        Mock.advance(200)
        expect(backend.completes[id].status).toBe('failed')
        expect(backend.completes[id].error).toBe('timeout')
    end)

    it('a malformed chunk ends the capture immediately', function()
        connect(13)
        Mock.trigger('milcsoguard:replay:status', 13, 'recording', '')
        request(1, 'ban.create', { id = 13, reason = 'garbage', durationSeconds = 3600 })
        Mock.trigger('milcsoguard:replay:chunk', 13, captureId(13), 0, 0, '"><script>')
        Mock.advance(300)
        expect(droppedSrc(13)).toBeTruthy()
        expect(backend.completes[captureId(13)].error).toBe('malformed chunk')
    end)

    it('another player cannot inject data into someone else\'s replay', function()
        connect(14)
        connect(15)
        Mock.trigger('milcsoguard:replay:status', 14, 'recording', '')
        request(1, 'ban.create', { id = 14, reason = 'victim', durationSeconds = 3600 })
        local id = captureId(14)
        Mock.trigger('milcsoguard:replay:chunk', 15, id, 0, 0, 'AAAA')
        Mock.trigger('milcsoguard:replay:done', 15, id, { parts = { { chunks = 1, durationMs = 1 } } })
        Mock.advance(300)
        expect(droppedSrc(14)).toBeNil()
        expect(MG.Replay.jobs[id].parts[1]).toBeNil()
        sendReplay(14, id, { { 'GkXfo9' } })
        expect(droppedSrc(14)).toBeTruthy()
    end)

    it('detections during the upload do not ban a second time', function()
        connect(16)
        Mock.trigger('milcsoguard:replay:status', 16, 'recording', '')
        request(1, 'ban.create', { id = 16, reason = 'first', durationSeconds = 3600 })
        local before = #backend.bans
        local rec = MG.Detections.report(16, 'events.honeypot', { conclusive = true, evidence = { event = 'x' } })
        Mock.advance(500)
        expect(rec.action).toBe('ban')
        expect(rec.actionResult).toBe('already banned')
        expect(#backend.bans).toBe(before)
        sendReplay(16, captureId(16), { { 'GkXfo3' } })
    end)

    it('keeps the complete parts when the player quits mid-upload', function()
        connect(17)
        Mock.trigger('milcsoguard:replay:status', 17, 'recording', '')
        request(1, 'ban.create', { id = 17, reason = 'ragequit', durationSeconds = 3600 })
        local id = captureId(17)
        Mock.trigger('milcsoguard:replay:chunk', 17, id, 0, 0, 'GkXfoA')
        Mock.trigger('milcsoguard:replay:chunk', 17, id, 1, 0, 'GkXfoB')
        Mock.trigger('milcsoguard:replay:done', 17, id, { parts = { { chunks = 1, durationMs = 5000 }, { chunks = 2, durationMs = 5000 } } })
        Mock.trigger('playerDropped', 17, 'Exiting')
        Mock.advance(500)
        expect(backend.parts[id][0].data).toBe('GkXfoA')
        expect(backend.parts[id][1]).toBeNil()
        expect(backend.completes[id].status).toBe('ready')
    end)

    it('web bans picked up by the ban sync are enforced through the same path', function()
        local p = connect(18)
        Mock.trigger('milcsoguard:replay:status', 18, 'recording', '')
        MG.Bans.applySync({ full = true, now = '2026-01-03T00:00:00Z', bans = { { id = '0e9c7f3a-2222-4333-9444-555566667777', code = 'MG-WEB', reason = 'web ban', identifiers = { p.identifiers[1] }, createdAt = '2026-01-01T00:00:00Z' } } })
        MG.Bans.enforceOnline()
        MG.Bans.enforceOnline() -- the next sync must not drop them before the upload ended
        local id = captureId(18)
        expect(id).toBeTruthy()
        expect(droppedSrc(18)).toBeNil()
        sendReplay(18, id, { { 'GkXfo4' } })
        expect(droppedSrc(18).reason).toContain('MG-WEB')
        Mock.advance(300)
        expect(backend.replays[id].banId).toBe('0e9c7f3a-2222-4333-9444-555566667777')
    end)
end)

describe('replay requested from the dashboard', function()
    it('checks the identity, captures and reports back', function()
        local p = connect(20)
        backend.commands = { { id = 'c1', type = 'replay_request', payload = { replayId = '1b2c3d4e-aaaa-4bbb-8ccc-ddddeeeeffff', netId = 20, identifiers = { p.identifiers[1] }, reason = 'report' } } }
        Citizen.CreateThread(MG.Sync.pollCommands)
        Mock.advance(300)
        expect(captureId(20)).toBe('1b2c3d4e-aaaa-4bbb-8ccc-ddddeeeeffff')
        expect(backend.acks[#backend.acks].status).toBe('done')
        sendReplay(20, captureId(20), { { 'GkXfo5' } })
        Mock.advance(300)
        expect(backend.replays['1b2c3d4e-aaaa-4bbb-8ccc-ddddeeeeffff'].kind).toBe('manual')
        expect(backend.completes['1b2c3d4e-aaaa-4bbb-8ccc-ddddeeeeffff'].status).toBe('ready')
        expect(droppedSrc(20)).toBeNil() -- a manual replay never removes the player
    end)

    it('marks the replay failed when the net id belongs to someone else now', function()
        connect(21)
        backend.commands = { { id = 'c2', type = 'replay_request', payload = { replayId = '2b2c3d4e-aaaa-4bbb-8ccc-ddddeeeeffff', netId = 21, identifiers = { 'license:' .. string.rep('f', 40) }, reason = 'x' } } }
        Citizen.CreateThread(MG.Sync.pollCommands)
        Mock.advance(300)
        expect(captureId(21)).toBeNil()
        expect(backend.completes['2b2c3d4e-aaaa-4bbb-8ccc-ddddeeeeffff'].status).toBe('failed')
    end)
end)

describe('in-game replay request and playback', function()
    it('needs replays.request and does not work on higher admins', function()
        connect(40)
        Mock.ace['41|milcsoguard.role.owner'] = true
        connect(41, { name = 'Owner' })
        Mock.ace['42|milcsoguard.role.viewer'] = true
        connect(42)
        expect(request(42, 'replay.request', { id = 40, reason = 'check' }).ok).toBe(false)
        local r = request(1, 'replay.request', { id = 41, reason = 'check' })
        expect(r.ok).toBe(false)
        expect(r.error).toContain('magasabb')
        expect(request(1, 'replay.request', { id = 40, reason = '' }).ok).toBe(false)
    end)

    it('captures without dropping the player and notifies the admin when stored', function()
        Mock.trigger('milcsoguard:replay:status', 40, 'recording', '')
        local r = request(1, 'replay.request', { id = 40, reason = 'report #12' })
        expect(r.ok).toBe(true)
        expect(r.data.recorder).toBe('recording')
        expect(request(1, 'replay.request', { id = 40, reason = 'again' }).error).toContain('folyamatban')
        sendReplay(40, r.data.id, { { 'GkXfo7' } })
        Mock.advance(300)
        expect(droppedSrc(40)).toBeNil()
        expect(backend.replays[r.data.id].requestedBy.name).toBe('Admin')
        local notes = Mock.clientEventsNamed('milcsoguard:notice', 1)
        expect(notes[#notes].args[1]).toContain('Visszajátszás elkészült')
    end)

    it('streams the parts of a stored replay to the admin and records the viewing', function()
        local id = '3c2c3d4e-aaaa-4bbb-8ccc-ddddeeeeffff'
        local r = request(1, 'replay.play', { id = id })
        expect(r.ok).toBe(true)
        expect(r.data.parts).toBe(2)
        Mock.advance(500)
        local parts = Mock.clientEventsNamed('milcsoguard:admin:replayPart', 1)
        expect(#parts).toBe(2)
        expect(parts[1].latent).toBeTruthy()
        expect(parts[2].args[1].data).toBe('GkXfo1')
        expect(parts[2].args[1].total).toBe(2)
        expect(backend.viewed.actor.name).toBe('Admin')
        expect(request(1, 'replay.play', { id = '../../etc' }).ok).toBe(false)
    end)
end)

describe('moderation tools', function()
    it('freeze / unfreeze is audited and refused on higher admins', function()
        connect(50)
        expect(request(1, 'player.freeze', { id = 50, freeze = true }).ok).toBe(true)
        expect(Mock.ped(50).frozen).toBe(true)
        expect(MG.State.get(50).frozen).toBe(true)
        expect(request(1, 'player.freeze', { id = 50, freeze = false }).ok).toBe(true)
        expect(Mock.ped(50).frozen).toBe(false)
        expect(request(1, 'player.freeze', { id = 41, freeze = true }).ok).toBe(false)
        Mock.advance(6000)
        local actions = {}
        for _, a in ipairs(backend.audits) do actions[#actions + 1] = a.action end
        expect(actions).toContain('player.freeze')
        expect(actions).toContain('player.unfreeze')
    end)

    it('goto moves the admin and exempts them from the teleport check', function()
        Mock.ped(50).pos = Mock.vec(1000, 2000, 30)
        Mock.players[50].bucket = 3
        expect(request(1, 'player.goto', { id = 50 }).ok).toBe(true)
        expect(Mock.ped(1).pos.x).toBe(1001.0)
        expect(Mock.players[1].bucket).toBe(3)
        expect((MG.State.isExempt(MG.State.get(1), 'movement.teleport'))).toBe(true)
    end)

    it('bring only works inside the same routing bucket', function()
        Mock.players[1].bucket = 0
        Mock.players[50].bucket = 3
        local r = request(1, 'player.bring', { id = 50 })
        expect(r.ok).toBe(false)
        expect(r.error).toContain('bucket')
        Mock.players[50].bucket = 0
        Mock.ped(1).pos = Mock.vec(10, 20, 30)
        expect(request(1, 'player.bring', { id = 50 }).ok).toBe(true)
        expect(Mock.ped(50).pos.y).toBe(20)
        expect((MG.State.isExempt(MG.State.get(50), 'movement.teleport'))).toBe(true)
    end)

    it('spectate follows the target and restores the admin afterwards', function()
        Mock.ped(1).pos = Mock.vec(5, 5, 5)
        Mock.players[1].bucket = 0
        Mock.players[50].bucket = 7
        Mock.ped(50).pos = Mock.vec(300, 300, 40)
        local r = request(1, 'player.spectate', { id = 50 })
        expect(r.ok).toBe(true)
        expect(Mock.players[1].bucket).toBe(7)
        local admin = MG.State.get(1)
        expect((MG.State.isExempt(admin, 'player.invisible'))).toBe(true)
        expect((MG.State.isExempt(admin, 'client.spectate'))).toBe(true)
        Mock.ped(50).pos = Mock.vec(900, 900, 40)
        Mock.advance(2500)
        local ev = Mock.clientEventsNamed('milcsoguard:admin:spectate', 1)
        expect(ev[#ev].args[1].update).toBe(true)
        expect(ev[#ev].args[1].x).toBe(900)
        expect(request(1, 'player.spectate.stop', {}).data.stopped).toBe(true)
        ev = Mock.clientEventsNamed('milcsoguard:admin:spectate', 1)
        expect(ev[#ev].args[1].stop).toBe(true)
        expect(ev[#ev].args[1].x).toBe(5)
        expect(Mock.players[1].bucket).toBe(0)
        expect((MG.State.isExempt(admin, 'player.ammo'))).toBe(true) -- 5 s grace after returning
        Mock.advance(6000)
        -- (player.invisible stays exempt: administrators have a permanent admin bypass for it)
        expect((MG.State.isExempt(admin, 'player.ammo'))).toBe(false)
    end)

    it('spectate ends when the target leaves', function()
        connect(51)
        expect(request(1, 'player.spectate', { id = 51 }).ok).toBe(true)
        Mock.trigger('playerDropped', 51, 'Exiting')
        Mock.removePlayer(51)
        local ev = Mock.clientEventsNamed('milcsoguard:admin:spectate', 1)
        expect(ev[#ev].args[1].stop).toBe(true)
        expect(MG.Admin.spectating[1]).toBeNil()
    end)

    it('a message is sanitized and shown to the target', function()
        expect(request(1, 'player.message', { id = 50, message = '^1Gyere a ^2dokkba\n' }).ok).toBe(true)
        local n = Mock.clientEventsNamed('milcsoguard:notice', 50)
        expect(n[#n].args[1]).toBe('~y~[Admin]~s~ Gyere a dokkba')
    end)

    it('players without players.moderate cannot use the tools', function()
        expect(request(42, 'player.goto', { id = 50 }).error).toContain('players.moderate')
        expect(request(42, 'player.spectate', { id = 50 }).ok).toBe(false)
    end)
end)

describe('recently left players and offline ban', function()
    it('lists players who left and bans them by their stored identifiers', function()
        local p = connect(60, { name = 'Leaver' })
        local license = p.identifiers[1]
        Mock.trigger('playerDropped', 60, 'Exiting')
        Mock.removePlayer(60)
        local list = request(1, 'players.recent', {}).data
        expect(list[1].name).toBe('Leaver')
        local r = request(1, 'ban.offline', { key = list[1].key, reason = 'combat log + cheat', durationSeconds = 86400 })
        expect(r.ok).toBe(true)
        expect(MG.Bans.find({ license })).toBeTruthy()
        Mock.advance(500)
        expect(backend.bans[#backend.bans].playerName).toBe('Leaver')
        expect(request(1, 'ban.offline', { key = 'nope', reason = 'xxx', durationSeconds = 86400 }).ok).toBe(false)
    end)

    it('banned players do not show up as "recently left"', function()
        local list = request(1, 'players.recent', {}).data
        for _, e in ipairs(list) do expect(e.name == 'Cheater').toBe(false) end
    end)

    it('offline-banning a higher admin is refused', function()
        Mock.trigger('playerDropped', 41, 'Exiting')
        Mock.removePlayer(41)
        local list = request(1, 'players.recent', {}).data
        local key
        for _, e in ipairs(list) do if e.name == 'Owner' then key = e.key end end
        local r = request(1, 'ban.offline', { key = key, reason = 'nope nope', permanent = true })
        expect(r.ok).toBe(false)
    end)
end)
