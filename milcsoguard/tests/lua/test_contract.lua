-- Contract test: the REAL server resource against the REAL backend over HTTP (curl bridge).
-- Skipped unless MG_CONTRACT_URL and MG_CONTRACT_KEY are set, e.g.
--   MG_CONTRACT_URL=http://127.0.0.1:8080 MG_CONTRACT_KEY=mgk_... ./run.sh
local Mock = MockFX
local BASE = os.getenv('MG_CONTRACT_URL')
local KEY = os.getenv('MG_CONTRACT_KEY')
if not BASE or not KEY then
    io.write('  (skipped: set MG_CONTRACT_URL and MG_CONTRACT_KEY to run against a live backend)\n')
    return
end

local function shellQuote(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end
local tmpBody = os.tmpname()
--- Synchronous HTTP via curl; returns status, decoded body.
local function http(method, path, body, headers)
    local args = { 'curl', '-s', '-o', shellQuote(tmpBody .. '.out'), '-w', '%{http_code}', '-X', method }
    for k, v in pairs(headers or {}) do args[#args + 1] = '-H ' .. shellQuote(k .. ': ' .. v) end
    if body then
        local f = io.open(tmpBody, 'w'); f:write(json.encode(body)); f:close()
        args[#args + 1] = '--data-binary @' .. shellQuote(tmpBody)
    end
    args[#args + 1] = shellQuote(BASE .. path)
    local p = io.popen(table.concat(args, ' '))
    local status = tonumber(p:read('*a')) or 0
    p:close()
    local f = io.open(tmpBody .. '.out', 'r')
    local text = f and f:read('*a') or ''
    if f then f:close() end
    local ok, data = pcall(json.decode, text)
    return status, ok and data or nil, text
end

Mock.convars = { onesync = 'on', milcsoguard_api_url = BASE, milcsoguard_api_key = KEY, sv_entityLockdown = 'relaxed' }
Mock.http = function(method, path, body, headers)
    local status, data = http(method, path, body, headers)
    return status, data
end
local function game(method, path, body)
    return http(method, '/api/v1/game' .. path, body, { Authorization = 'Bearer ' .. KEY, ['Content-Type'] = 'application/json' })
end

loadResource()
Mock.advance(2000)

local nextTemp = 61000
local function connect(src, license, name)
    nextTemp = nextTemp + 1
    local ids = { 'license:' .. license, 'discord:2000000000000000' .. src, 'ip:10.1.0.' .. src }
    Mock.addPlayer(nextTemp, { identifiers = ids, name = name })
    local d = { result = nil }
    function d.defer() end
    function d.update() end
    function d.done(m) d.result = m or true end
    Mock.trigger('playerConnecting', nextTemp, name, function() end, d)
    Mock.advance(300)
    local temp = nextTemp
    if d.result ~= true then Mock.removePlayer(temp); return d.result end
    Mock.entities[Mock.players[temp].ped] = nil
    Mock.players[temp] = nil
    Mock.addPlayer(src, { identifiers = ids, name = name })
    Mock.trigger('playerJoining', src, tostring(temp))
    Mock.advance(300)
    return true
end

describe('live backend contract', function()
    it('handshake is accepted (schema passes backend validation)', function()
        expect(MG.Sync.handshakeDone).toBe(true)
        expect(MG.Api.serverName).toBeTruthy()
    end)
    it('connect / join / heartbeat create sessions in the backend', function()
        expect(connect(1, string.rep('1', 40), 'Contract One')).toBe(true)
        expect(connect(2, string.rep('2', 40), 'Contract Two')).toBe(true)
        Mock.advance(31000)
        local status, data = game('GET', '/admin/stats')
        expect(status).toBe(200)
        expect(data.online_players).toBe(2)
    end)
    it('detections reach the backend with evidence intact', function()
        local p = MG.State.get(1)
        p.graceUntil = 0
        Mock.advance(1100)
        Mock.ped(1).pos = Mock.vec(2500, -900, 40)
        Mock.advance(1100)
        Mock.trigger('explosionEvent', nil, 2, { explosionType = 59, damageScale = 1.0, isAudible = true, isInvisible = false, posX = 1, posY = 2, posZ = 3 })
        Mock.advance(8000)
        expect(#MG.Api.queue).toBe(0)
        local status, data = game('GET', '/admin/detections?pageSize=10')
        expect(status).toBe(200)
        local types = {}
        for _, d in ipairs(data.items) do types[d.type] = d end
        expect(types['movement.teleport']).toBeTruthy()
        expect(types['explosions.filter'].evidence.explosionName).toBe('ORBITAL_CANNON')
        expect(types['explosions.filter'].evidence.blocked).toBe(true)
    end)
    it('an in-game ban is created in the backend with the admin as actor and enforced on reconnect', function()
        Mock.ace['1|milcsoguard.role.owner'] = true
        Mock.trigger('milcsoguard:admin:request', 1, 1, 'ban.create', { id = 2, reason = 'Contract test ban', durationSeconds = 3600 })
        Mock.advance(8000)
        if os.getenv('MG_DEBUG') then
            for _, r in ipairs(Mock.requests('/bans')) do io.write('REQ ', r.method, ' ', r.path, ' ', json.encode(r.body), '\n') end
            io.write('QUEUE ', json.encode(MG.Api.queue), ' ERR ', tostring(MG.Api.lastError), '\n')
        end
        local status, data = game('GET', '/admin/bans?q=contract')
        expect(status).toBe(200)
        expect(data.items[1].created_by_label).toContain('ingame:Contract One')
        expect(data.items[1].source).toBe('ingame')
        -- local cache got the real id after sync
        expect(MG.Bans.find({ 'license:' .. string.rep('2', 40) }).code:sub(1, 3)).toBe('MG-')
        Mock.removePlayer(2); MG.State.remove(2)
        local r = connect(2, string.rep('2', 40), 'Contract Two')
        expect(r).toContain('Contract test ban')
    end)
    it('a ban with POV replay: the segments reach the backend byte-exact and are linked to the ban', function()
        connect(3, string.rep('3', 40), 'Contract Three')
        Mock.trigger('milcsoguard:replay:status', 3, 'recording', 'vp8')
        Mock.trigger('milcsoguard:admin:request', 1, 4, 'ban.create', { id = 3, reason = 'Contract replay ban', durationSeconds = 3600 })
        Mock.advance(300)
        local ev = Mock.clientEventsNamed('milcsoguard:replay:capture', 3)
        local id = ev[#ev].args[1]
        -- base64 of 1A 45 DF A3 (EBML magic) followed by zero bytes, split like the NUI does
        local partA = 'GkXfow' .. string.rep('A', 2 + 4 * 2000)
        local partB = 'GkXfow' .. string.rep('B', 2 + 4 * 500)
        Mock.trigger('milcsoguard:replay:chunk', 3, id, 0, 0, partA:sub(1, 4000))
        Mock.trigger('milcsoguard:replay:chunk', 3, id, 0, 1, partA:sub(4001))
        Mock.trigger('milcsoguard:replay:chunk', 3, id, 1, 0, partB)
        Mock.trigger('milcsoguard:replay:done', 3, id, { parts = { { chunks = 2, durationMs = 5000 }, { chunks = 1, durationMs = 3200 } }, width = 854, height = 480, fps = 15 })
        Mock.advance(10000)
        local status, data = game('GET', '/admin/replays/' .. id)
        expect(status).toBe(200)
        expect(data.replay.status).toBe('ready')
        expect(data.replay.kind).toBe('ban')
        expect(data.replay.duration_ms).toBe(8200)
        expect(data.replay.ban_code:sub(1, 3)).toBe('MG-')
        local _, p0 = game('GET', '/admin/replays/' .. id .. '/parts/0')
        expect(p0.data).toBe(partA)
        local _, p1 = game('GET', '/admin/replays/' .. id .. '/parts/1')
        expect(p1.data).toBe(partB)
        local dropped = false
        for _, d in ipairs(Mock.dropped) do if d.src == 3 then dropped = true end end
        expect(dropped).toBe(true)
    end)
    it('in-game unban revokes in the backend', function()
        local ban = MG.Bans.find({ 'license:' .. string.rep('2', 40) })
        Mock.trigger('milcsoguard:admin:request', 1, 2, 'ban.revoke', { id = ban.id, reason = 'Contract unban' })
        Mock.advance(8000)
        local _, data = game('GET', '/admin/bans?status=revoked&q=contract')
        expect(data.items[1].revoke_reason).toBe('Contract unban')
        expect(connect(2, string.rep('2', 40), 'Contract Two')).toBe(true)
    end)
    it('remote config edited in-game is validated, versioned and applied', function()
        local before = MG.Sync.configVersion
        Mock.trigger('milcsoguard:admin:request', 1, 3, 'settings.save', { overrides = { modules = { ['movement.teleport'] = { action = 'kick' } } }, note = 'contract config' })
        Mock.advance(3000)
        expect(MG.Sync.configVersion).toBe(before + 1)
        expect(MG.Detections.modules['movement.teleport'].action).toBe('kick')
        local _, cfg = game('GET', '/config')
        expect(cfg.version).toBe(before + 1)
    end)
end)
