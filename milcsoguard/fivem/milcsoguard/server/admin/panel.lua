-- In-game admin panel (server side). The NUI only sends requests; every request is permission
-- checked here, right before it runs, and every state change is audited by the backend.
MG = MG or {}
local U = MG.Util
local Log = MG.Log
local Perm = MG.Permissions
local Admin = { open = {}, limiter = MG.RateLimiter.new(40, 10000) }
MG.Admin = Admin

local MAX_TEMP_BAN = 365 * 86400

local function fail(msg) return { ok = false, error = msg } end
local function ok(data) return { ok = true, data = data } end

local function maskIds(list, full)
    if full then return list end
    local out = {}
    for _, i in ipairs(list or {}) do
        local t, v = i:match('^([%w]+):(.+)$')
        if t and v then out[#out + 1] = t .. ':' .. (#v > 6 and (v:sub(1, 4) .. '…' .. v:sub(-2)) or '***') end
    end
    return out
end

local function reason(payload)
    local r = U.trim(type(payload.reason) == 'string' and payload.reason or '')
    if #r < 3 then return nil end
    return U.sanitize(r, 500)
end

local function banDuration(admin, payload)
    if payload.permanent == true then
        if not admin.perms['bans.permanent'] then return nil, 'Nincs jogosultságod végleges banhoz (bans.permanent).' end
        return false
    end
    local duration = tonumber(payload.durationSeconds)
    if not duration or duration < 60 or duration > MAX_TEMP_BAN then return nil, 'Érvénytelen időtartam.' end
    return math.floor(duration)
end

local function needApi()
    if not MG.Api.enabled() then return 'A backend nincs beállítva (local-only mód).' end
    if not MG.Api.online and not MG.Sync.handshakeDone then return 'A backend jelenleg nem érhető el.' end
    return nil
end

local function query(params)
    local parts = {}
    for k, v in pairs(params or {}) do
        if v ~= nil and v ~= '' then parts[#parts + 1] = k .. '=' .. tostring(v):gsub('[^%w%-_%.~:]', function(c) return ('%%%02X'):format(string.byte(c)) end) end
    end
    return #parts > 0 and ('?' .. table.concat(parts, '&')) or ''
end

local function remote(method, path, body)
    local e = needApi()
    if e then return fail(e) end
    local r = MG.Api.await(method, path, body)
    if not r.ok then return fail(r.err or 'backend error') end
    return ok(r.data)
end

local function playerSummary(p, admin)
    local full = admin.perms['players.identifiers'] == true
    return {
        id = p.src, name = p.name, ping = GetPlayerPing(p.src), risk = MG.Detections.score(p),
        monitored = (p.monitoredUntil or 0) > MG.State.now(), frozen = p.frozen == true,
        recorder = p.replayState or 'unknown',
        admin = p.admin and { role = p.admin.label, level = p.admin.level, source = p.admin.source } or nil,
        identifiers = maskIds(U.filterIdentifiers(p.identifiers, { token = true, ip = not full }), full),
        joinedSecondsAgo = math.floor((MG.State.now() - p.joinedAt) / 1000),
    }
end

--- Target admin protection: you cannot kick/ban someone at or above your own level.
local function protectedTarget(actorAdmin, target)
    local ta = target and Perm.refresh(target.src)
    return ta and ta.level >= actorAdmin.level and actorAdmin.level < 100
end

--- Audits an in-game admin action in the backend (queued, so it survives backend outages).
function Admin.audit(src, action, details)
    MG.Api.enqueue('audit', { action = action, details = U.obj(details or {}), actor = Perm.actor(src) })
    MG.Api.flush()
end

-- action -> { permission, handler(src, admin, payload) }
local actions = {}

actions['dashboard'] = { 'detections.view', function(src, admin)
    local now = MG.State.now()
    local today = U.isoTime():sub(1, 10)
    local local_today, alerts = 0, 0
    for _, d in ipairs(MG.Detections.ring) do
        if d.occurredAt:sub(1, 10) == today then local_today = local_today + 1 end
        if MG.SEVERITY_RANK[d.severity] >= MG.SEVERITY_RANK.HIGH and d.occurredAt:sub(1, 10) == today then alerts = alerts + 1 end
    end
    local data = {
        onlinePlayers = U.count(MG.State.players), detectionsToday = local_today, alertsToday = alerts, cachedBans = MG.Bans.count(),
        recent = MG.Detections.recent(8), api = { enabled = MG.Api.enabled(), online = MG.Api.online, lastError = MG.Api.lastError },
        remote = nil,
    }
    if MG.Api.enabled() and MG.Api.online then
        local r = MG.Api.await('GET', '/admin/stats')
        if r.ok then data.remote = r.data end
    end
    return ok(data)
end }

actions['players.list'] = { 'players.view', function(src, admin)
    local out = {}
    for _, p in ipairs(MG.State.list()) do out[#out + 1] = playerSummary(p, admin) end
    return ok(out)
end }

actions['player.details'] = { 'players.view', function(src, admin, payload)
    local p = MG.State.get(payload.id)
    if not p then return fail('A játékos nincs online.') end
    local data = {
        player = playerSummary(p, admin),
        riskHistory = p.risk.history,
        localDetections = admin.perms['detections.view'] and MG.Detections.recent(30, function(d) return d.netId == p.src end) or {},
        remote = nil,
    }
    if MG.Api.enabled() and MG.Api.online then
        local r = MG.Api.await('POST', '/admin/players/lookup', { identifiers = U.filterIdentifiers(p.identifiers, { ip = true }) })
        if r.ok then data.remote = r.data end
    end
    return ok(data)
end }

actions['detections.list'] = { 'detections.view', function(src, admin, payload)
    if MG.Api.enabled() and MG.Api.online then
        local r = MG.Api.await('GET', '/admin/detections' .. query({ page = tonumber(payload.page) or 1, pageSize = 25, severity = payload.severity, q = payload.q, review = payload.review }))
        if r.ok then return ok({ source = 'backend', page = r.data }) end
    end
    return ok({ source = 'local', items = MG.Detections.recent(100) })
end }

actions['detections.review'] = { 'detections.review', function(src, admin, payload)
    local why = reason({ reason = payload.note })
    if not why then return fail('Indoklás kötelező (min. 3 karakter).') end
    if not ({ confirmed = 1, false_positive = 1, dismissed = 1, pending = 1 })[payload.status] then return fail('Érvénytelen státusz.') end
    if type(payload.id) ~= 'string' or not payload.id:match('^[%x%-]+$') then return fail('Érvénytelen azonosító.') end
    return remote('POST', '/admin/detections/' .. payload.id .. '/review', { status = payload.status, note = why, actor = Perm.actor(src) })
end }

actions['bans.list'] = { 'bans.view', function(src, admin, payload)
    if MG.Api.enabled() and MG.Api.online then
        local r = MG.Api.await('GET', '/admin/bans' .. query({ page = tonumber(payload.page) or 1, pageSize = 25, status = payload.status or 'active', q = payload.q }))
        if r.ok then
            for _, b in ipairs(r.data.items or {}) do b.identifiers = maskIds(b.identifiers, admin.perms['players.identifiers']) end
            return ok({ source = 'backend', page = r.data })
        end
    end
    local items = {}
    for _, b in pairs(MG.Bans.byId) do
        items[#items + 1] = { id = b.id, public_code = b.code, player_name = b.playerName, reason = b.reason, expires_at = b.expiresAt and U.isoTime(b.expiresAt) or nil, status = 'active', pending = b.pending, identifiers = maskIds(b.identifiers, admin.perms['players.identifiers']) }
    end
    table.sort(items, function(a, b) return tostring(a.player_name) < tostring(b.player_name) end)
    return ok({ source = 'local', items = items })
end }

actions['ban.create'] = { 'bans.create', function(src, admin, payload)
    local why = reason(payload)
    if not why then return fail('Indoklás kötelező (min. 3 karakter).') end
    -- Permanent bans must be requested explicitly; a missing duration is an error, not "forever".
    local duration, derr = banDuration(admin, payload)
    if duration == nil then return fail(derr) end
    duration = duration or nil
    local target = MG.State.get(payload.id)
    if not target then return fail('A játékos nincs online.') end
    if target.src == tonumber(src) then return fail('Saját magadat nem bannolhatod.') end
    if protectedTarget(admin, target) then return fail('Azonos vagy magasabb szintű admint nem bannolhatsz.') end
    local ban = MG.Bans.create({ identifiers = target.identifiers, playerName = target.name, reason = why, durationSeconds = duration, actor = Perm.actor(src) })
    Log.info('%s banned %s (%s): %s', admin.label, target.name, duration and U.formatDuration(duration) or 'permanent', why)
    MG.Bans.enforce(target.src, ban)
    return ok({ id = ban.id, replay = ban.replayId ~= nil })
end }

actions['ban.revoke'] = { 'bans.remove', function(src, admin, payload)
    local why = reason(payload)
    if not why then return fail('Indoklás kötelező (min. 3 karakter).') end
    if type(payload.id) ~= 'string' or #payload.id > 80 then return fail('Érvénytelen ban azonosító.') end
    local isLocal = MG.Bans.byId[payload.id] ~= nil
    if not isLocal and needApi() then return fail(needApi()) end
    MG.Bans.revoke(payload.id, why, Perm.actor(src))
    return ok({ revoked = payload.id })
end }

actions['kick'] = { 'players.kick', function(src, admin, payload)
    local why = reason(payload)
    if not why then return fail('Indoklás kötelező (min. 3 karakter).') end
    local target = MG.State.get(payload.id)
    if not target then return fail('A játékos nincs online.') end
    if protectedTarget(admin, target) then return fail('Azonos vagy magasabb szintű admint nem kickelhetsz.') end
    Admin.audit(src, 'player.kick', { target = target.name, netId = target.src, reason = why })
    DropPlayer(tostring(target.src), ('Kickelve: %s'):format(why))
    return ok({ kicked = target.src })
end }

actions['player.monitor'] = { 'detections.review', function(src, admin, payload)
    local target = MG.State.get(payload.id)
    if not target then return fail('A játékos nincs online.') end
    local minutes = U.clamp(tonumber(payload.minutes) or 30, 1, 1440)
    target.monitoredUntil = MG.State.now() + minutes * 60000
    Admin.audit(src, 'player.monitor', { target = target.name, netId = target.src, minutes = minutes })
    return ok({ monitoredMinutes = minutes })
end }

actions['whitelist.list'] = { 'whitelist.view', function()
    if MG.Api.enabled() and MG.Api.online then
        local r = MG.Api.await('GET', '/admin/whitelist')
        if r.ok then return ok({ source = 'backend', items = r.data.items }) end
    end
    return ok({ source = 'local', items = MG.Sync.whitelist })
end }

actions['whitelist.add'] = { 'whitelist.manage', function(src, admin, payload)
    local kind = payload.kind
    if kind ~= 'player' and kind ~= 'resource' and kind ~= 'model' then return fail('Érvénytelen típus.') end
    local value = U.trim(payload.value)
    if kind == 'player' and tonumber(value) and MG.State.get(tonumber(value)) then
        -- allow "server id" input for online players: use their license
        value = 'license:' .. (MG.State.get(tonumber(value)).idmap.license or '')
    end
    local modules = type(payload.modules) == 'table' and payload.modules or {}
    local r = remote('POST', '/admin/whitelist', { entry = { kind = kind, value = value, modules = modules, note = U.sanitize(payload.note or '', 500) }, actor = Perm.actor(src) })
    if r.ok then Citizen.CreateThread(MG.Sync.pullConfig) end
    return r
end }

actions['whitelist.remove'] = { 'whitelist.manage', function(src, admin, payload)
    if type(payload.id) ~= 'string' or not payload.id:match('^[%x%-]+$') then return fail('Érvénytelen azonosító.') end
    local r = remote('POST', '/admin/whitelist/' .. payload.id .. '/delete', { actor = Perm.actor(src) })
    if r.ok then Citizen.CreateThread(MG.Sync.pullConfig) end
    return r
end }

actions['admins.list'] = { 'admins.view', function()
    local onlineAdmins = {}
    for _, p in ipairs(MG.State.list()) do
        local a = Perm.refresh(p.src)
        if a then onlineAdmins[#onlineAdmins + 1] = { id = p.src, name = p.name, role = a.label, level = a.level, source = a.source } end
    end
    local data = { online = onlineAdmins, members = nil, roles = {} }
    for key, r in pairs(Config.Roles) do data.roles[#data.roles + 1] = { key = key, label = r.label, level = r.level } end
    table.sort(data.roles, function(a, b) return a.level > b.level end)
    if MG.Api.enabled() and MG.Api.online then
        local r = MG.Api.await('GET', '/admin/members')
        if r.ok then data.members = r.data.items end
    end
    return ok(data)
end }

actions['audit.list'] = { 'audit.view', function(src, admin, payload)
    return remote('GET', '/admin/audit' .. query({ page = tonumber(payload.page) or 1, pageSize = 30, action = payload.action, actor = payload.actor }))
end }

actions['settings.get'] = { 'settings.view', function(src, admin)
    return ok({
        schema = MG.Schema.descriptor(), effective = MG.Detections.modules, risk = MG.Detections.risk,
        version = MG.Sync.configVersion, canEdit = admin.perms['settings.manage'] == true and MG.Api.enabled(),
        remote = MG.Sync.remoteOverrides,
    })
end }

actions['settings.save'] = { 'settings.manage', function(src, admin, payload)
    local why = reason({ reason = payload.note })
    if not why then return fail('Indoklás kötelező (min. 3 karakter).') end
    local clean, issues = MG.Schema.validate(payload.overrides)
    if #issues > 0 then return fail('Érvénytelen beállítás: ' .. issues[1].path .. ' – ' .. issues[1].message) end
    local _, risk = MG.Schema.build(MG.Sync.localOverrides, clean)
    local riskIssues = MG.Schema.checkRisk(risk)
    if #riskIssues > 0 then return fail(riskIssues[1].message) end
    local r = remote('PUT', '/admin/config', { overrides = U.obj({ modules = U.obj(clean.modules), risk = U.obj(clean.risk) }), expectedVersion = MG.Sync.configVersion, note = why, actor = Perm.actor(src) })
    if r.ok then
        MG.Sync.applyConfig(clean, r.data.version)
    end
    return r
end }

actions['system.status'] = { 'system.view', function()
    local data = {
        version = MG.VERSION, framework = MG.Bridge.name, inventory = MG.Bridge.inventory, deps = MG.Bridge.deps,
        onesync = GetConvar('onesync', 'off'), artifact = GetConvar('version', ''), entityLockdown = GetConvar('sv_entityLockdown', 'inactive'),
        api = { enabled = MG.Api.enabled(), online = MG.Api.online, lastError = MG.Api.lastError, lastOkAt = MG.Api.lastOkAt > 0 and U.isoTime(MG.Api.lastOkAt) or nil, queue = #MG.Api.queue, stats = MG.Api.stats, server = MG.Api.serverName },
        configVersion = MG.Sync.configVersion, cachedBans = MG.Bans.count(), lastBanSync = MG.Bans.lastSync,
        uptimeSeconds = os.time() - MG.Sync.startedAt, players = U.count(MG.State.players),
        breaker = { open = MG.Detections.breaker:isOpen(MG.State.now()), recent = #MG.Detections.breaker.hits },
        counters = MG.Detections.counters, events = nil,
    }
    if MG.Api.enabled() and MG.Api.online then
        local r = MG.Api.await('GET', '/admin/system-events')
        if r.ok then data.events = r.data.items end
    end
    return ok(data)
end }

-- ------------------------------------------------------------------ recently left players / offline ban
actions['players.recent'] = { 'players.view', function(src, admin)
    local full = admin.perms['players.identifiers'] == true
    local out = {}
    for _, r in ipairs(MG.State.recent) do
        out[#out + 1] = {
            key = r.key, name = r.name, id = r.src, reason = r.reason, risk = r.risk, droppedAt = U.isoTime(r.droppedAt),
            identifiers = maskIds(U.filterIdentifiers(r.identifiers, { token = true, ip = not full }), full),
        }
    end
    return ok(out)
end }

actions['ban.offline'] = { 'bans.create', function(src, admin, payload)
    local why = reason(payload)
    if not why then return fail('Indoklás kötelező (min. 3 karakter).') end
    local duration, derr = banDuration(admin, payload)
    if duration == nil then return fail(derr) end
    local entry
    for _, r in ipairs(MG.State.recent) do if r.key == payload.key then entry = r break end end
    if not entry then return fail('A játékos már nincs a listában.') end
    if entry.adminLevel >= admin.level and admin.level < 100 then return fail('Azonos vagy magasabb szintű admint nem bannolhatsz.') end
    if MG.State.get(entry.src) and MG.State.get(entry.src).name == entry.name then return fail('A játékos újra online – bannold a Játékosok listából.') end
    local ban = MG.Bans.create({ identifiers = entry.identifiers, playerName = entry.name, reason = why, durationSeconds = duration or nil, actor = Perm.actor(src) })
    Log.info('%s banned offline player %s: %s', admin.label, entry.name, why)
    return ok({ id = ban.id })
end }

-- ------------------------------------------------------------------ POV replays
local REPLAY_ERRORS = {
    disabled = 'A visszajátszás ki van kapcsolva (Config.Replay.enabled).',
    offline = 'A játékos nincs online.',
    busy = 'Ettől a játékostól már folyamatban van egy felvétel.',
}

actions['replay.request'] = { 'replays.request', function(src, admin, payload)
    if not MG.Api.enabled() then return fail('A visszajátszások a backendben tárolódnak; local-only módban nem elérhető.') end
    local why = reason(payload)
    if not why then return fail('Indoklás kötelező (min. 3 karakter).') end
    local target = MG.State.get(payload.id)
    if not target then return fail('A játékos nincs online.') end
    if protectedTarget(admin, target) then return fail('Azonos vagy magasabb szintű admintól nem kérhetsz felvételt.') end
    local id, err = MG.Replay.capture(target.src, { kind = 'manual', reason = why, actor = Perm.actor(src), requestedBy = src })
    if not id then return fail(REPLAY_ERRORS[err] or ('Nem sikerült: ' .. tostring(err))) end
    return ok({ id = id, recorder = target.replayState or 'unknown' })
end }

actions['replays.list'] = { 'replays.view', function(src, admin, payload)
    return remote('GET', '/admin/replays' .. query({ page = tonumber(payload.page) or 1, pageSize = 20 }))
end }

Admin.playing = {}
actions['replay.play'] = { 'replays.view', function(src, admin, payload)
    if not MG.Replay.isUuid(payload.id) then return fail('Érvénytelen azonosító.') end
    local r = remote('GET', '/admin/replays/' .. payload.id)
    if not r.ok then return r end
    if r.data.replay.status ~= 'ready' then return fail('Ez a felvétel nem játszható le (' .. tostring(r.data.replay.status) .. ').') end
    MG.Api.request('POST', '/admin/replays/' .. payload.id .. '/viewed', { actor = Perm.actor(src) }, function() end)
    local token = U.uuid()
    Admin.playing[src] = token
    local parts = r.data.parts or {}
    -- Streamed after the response; each part is a few hundred KB, sent as a latent event.
    Citizen.CreateThread(function()
        for i, part in ipairs(parts) do
            if Admin.playing[src] ~= token then return end
            local pr = MG.Api.await('GET', ('/admin/replays/%s/parts/%d'):format(payload.id, part.idx))
            if not pr.ok or Admin.playing[src] ~= token then
                TriggerClientEvent('milcsoguard:admin:replayPart', src, { id = payload.id, error = pr.err or 'megszakítva' })
                return
            end
            TriggerLatentClientEvent('milcsoguard:admin:replayPart', src, (Config.Replay and Config.Replay.uploadBps or 500000) * 2, {
                id = payload.id, idx = i - 1, total = #parts, durationMs = pr.data.durationMs, mime = pr.data.mime, data = pr.data.data,
            })
        end
    end)
    return ok({ replay = r.data.replay, parts = #parts })
end }

-- ------------------------------------------------------------------ moderation tools
-- These move players around; the anticheat's own movement checks are told about it first.
local SPECTATE_EXEMPT = { 'movement.*', 'player.*', 'client.spectate' }
Admin.spectating = {}

local function pedCoords(src)
    local c = GetEntityCoords(GetPlayerPed(src))
    return { x = c.x, y = c.y, z = c.z }
end

local function moderationTarget(src, admin, payload, allowProtected)
    local target = MG.State.get(payload.id)
    if not target then return nil, 'A játékos nincs online.' end
    if target.src == tonumber(src) then return nil, 'Ezt magadon nem használhatod.' end
    if not allowProtected and protectedTarget(admin, target) then return nil, 'Azonos vagy magasabb szintű adminon nem használhatod.' end
    return target
end

actions['player.freeze'] = { 'players.moderate', function(src, admin, payload)
    local target, err = moderationTarget(src, admin, payload)
    if not target then return fail(err) end
    local freeze = payload.freeze ~= false
    FreezeEntityPosition(GetPlayerPed(target.src), freeze)
    target.frozen = freeze or nil
    TriggerClientEvent('milcsoguard:notice', target.src, freeze and 'Egy admin lefagyasztott.' or 'Már mozoghatsz.')
    Admin.audit(src, freeze and 'player.freeze' or 'player.unfreeze', { target = target.name, netId = target.src })
    return ok({ frozen = freeze })
end }

actions['player.goto'] = { 'players.moderate', function(src, admin, payload)
    local target, err = moderationTarget(src, admin, payload, true)
    if not target then return fail(err) end
    local me = MG.State.get(src)
    local c = pedCoords(target.src)
    if me then
        MG.State.setExempt(me, 'movement.*', 8000)
        me.sample = nil
    end
    SetPlayerRoutingBucket(src, GetPlayerRoutingBucket(target.src))
    SetEntityCoords(GetPlayerPed(src), c.x + 1.0, c.y, c.z, false, false, false, false)
    Admin.audit(src, 'player.goto', { target = target.name, netId = target.src })
    return ok({ coords = c })
end }

actions['player.bring'] = { 'players.moderate', function(src, admin, payload)
    local target, err = moderationTarget(src, admin, payload)
    if not target then return fail(err) end
    -- Moving someone across routing buckets would break instanced scripts (housing, jobs).
    if GetPlayerRoutingBucket(target.src) ~= GetPlayerRoutingBucket(src) then return fail('A játékos másik routing bucketben van – használd az Odamegyek gombot.') end
    local c = pedCoords(src)
    MG.State.setExempt(target, 'movement.*', 8000)
    target.sample = nil
    SetEntityCoords(GetPlayerPed(target.src), c.x + 1.0, c.y, c.z, false, false, false, false)
    TriggerClientEvent('milcsoguard:notice', target.src, 'Egy admin magához teleportált.')
    Admin.audit(src, 'player.bring', { target = target.name, netId = target.src })
    return ok({ coords = c })
end }

actions['player.message'] = { 'players.moderate', function(src, admin, payload)
    local target, err = moderationTarget(src, admin, payload, true)
    if not target then return fail(err) end
    local msg = U.sanitize(U.trim(payload.message), 200)
    if #msg < 2 then return fail('Üres üzenet.') end
    TriggerClientEvent('milcsoguard:notice', target.src, ('~y~[Admin]~s~ %s'):format(msg))
    Admin.audit(src, 'player.message', { target = target.name, netId = target.src, message = msg })
    return ok({ sent = true })
end }

function Admin.stopSpectate(src)
    local s = Admin.spectating[src]
    if not s then return false end
    Admin.spectating[src] = nil
    local me = MG.State.get(src)
    if me then
        local untilMs = MG.State.now() + 5000
        for _, k in ipairs(SPECTATE_EXEMPT) do me.exempt[k] = untilMs end
        me.sample = nil
    end
    if GetPlayerName(src) then
        SetPlayerRoutingBucket(src, s.bucket)
        TriggerClientEvent('milcsoguard:admin:spectate', src, { stop = true, x = s.coords.x, y = s.coords.y, z = s.coords.z })
    end
    return true
end

actions['player.spectate'] = { 'players.moderate', function(src, admin, payload)
    local target, err = moderationTarget(src, admin, payload, true)
    if not target then return fail(err) end
    local me = MG.State.get(src)
    if not me then return fail('Belső hiba.') end
    if not Admin.spectating[src] then
        Admin.spectating[src] = { coords = pedCoords(src), bucket = GetPlayerRoutingBucket(src) }
    end
    Admin.spectating[src].target = target.src
    for _, k in ipairs(SPECTATE_EXEMPT) do MG.State.setExempt(me, k, 3600000) end
    me.sample = nil
    SetPlayerRoutingBucket(src, GetPlayerRoutingBucket(target.src))
    local c = pedCoords(target.src)
    TriggerClientEvent('milcsoguard:admin:spectate', src, { target = target.src, name = target.name, x = c.x, y = c.y, z = c.z })
    Admin.audit(src, 'player.spectate', { target = target.name, netId = target.src })
    return ok({ spectating = target.src, name = target.name })
end }

actions['player.spectate.stop'] = { 'players.moderate', function(src)
    return ok({ stopped = Admin.stopSpectate(src) })
end }

-- Keeps spectating admins next to their target (the target may drive away or teleport).
Citizen.CreateThread(function()
    while true do
        Wait(2000)
        for src, s in pairs(Admin.spectating) do
            if not MG.State.get(s.target) then
                TriggerClientEvent('milcsoguard:notice', src, 'A megfigyelt játékos kilépett.')
                Admin.stopSpectate(src)
            else
                if GetPlayerRoutingBucket(src) ~= GetPlayerRoutingBucket(s.target) then SetPlayerRoutingBucket(src, GetPlayerRoutingBucket(s.target)) end
                local c = pedCoords(s.target)
                TriggerClientEvent('milcsoguard:admin:spectate', src, { update = true, target = s.target, x = c.x, y = c.y, z = c.z })
            end
        end
    end
end)

function Admin.onDropped(src)
    Admin.open[src] = nil
    Admin.playing[src] = nil
    Admin.spectating[src] = nil
    for admin, s in pairs(Admin.spectating) do
        if s.target == tonumber(src) then
            TriggerClientEvent('milcsoguard:notice', admin, 'A megfigyelt játékos kilépett.')
            Admin.stopSpectate(admin)
        end
    end
end

-- ------------------------------------------------------------------ transport
function Admin.openFor(src)
    local admin = Perm.refresh(src)
    if not admin then
        TriggerClientEvent('milcsoguard:notice', src, 'Nincs jogosultságod az anticheat panelhez.')
        return
    end
    Admin.open[src] = true
    TriggerClientEvent('milcsoguard:admin:open', src, {
        brand = Config.Brand, version = MG.VERSION, role = admin.label, level = admin.level,
        permissions = Perm.list(admin), apiEnabled = MG.Api.enabled(), apiOnline = MG.Api.online,
        notifyMin = Config.Detections.notifyAdminsMinSeverity,
        replayEnabled = MG.Replay.enabled(), spectating = Admin.spectating[src] and Admin.spectating[src].target or nil,
    })
end

RegisterCommand(Config.Permissions.command, function(src)
    if src == 0 then
        print('[MilcsoGuard] The panel is in-game only. Console: milcsoguard status | milcsoguard sync')
        return
    end
    Admin.openFor(src)
end, false)

RegisterNetEvent('milcsoguard:admin:closed', function()
    Admin.open[source] = nil
end)

RegisterNetEvent('milcsoguard:admin:request', function(reqId, action, payload)
    local src = source
    if type(reqId) ~= 'number' or type(action) ~= 'string' then return end
    if not Admin.limiter:hit(src, GetGameTimer()) then
        TriggerClientEvent('milcsoguard:admin:response', src, reqId, fail('Túl sok kérés, lassíts.'))
        return
    end
    local def = actions[action]
    if not def then
        TriggerClientEvent('milcsoguard:admin:response', src, reqId, fail('Ismeretlen művelet.'))
        return
    end
    -- Fresh permission check for every request; the client-side UI state is never trusted.
    local admin = Perm.refresh(src)
    if not admin or not admin.perms[def[1]] then
        Log.warn('denied %s for #%d (%s): missing %s', action, src, GetPlayerName(src) or '?', def[1])
        if not admin then
            MG.Detections.report(src, 'events.spam', { evidence = { reason = 'admin request without admin rights', action = action } })
        end
        TriggerClientEvent('milcsoguard:admin:response', src, reqId, fail('Nincs jogosultságod: ' .. def[1]))
        return
    end
    Citizen.CreateThread(function()
        local okCall, result = pcall(def[2], src, admin, type(payload) == 'table' and payload or {})
        if not okCall then
            Log.error('admin action %s failed: %s', action, tostring(result))
            result = fail('Belső hiba.')
        end
        TriggerClientEvent('milcsoguard:admin:response', src, reqId, result)
    end)
end)

--- Live detection push to admins who may see detections.
function Admin.broadcastDetection(rec)
    local minRank = MG.SEVERITY_RANK[Config.Detections.notifyAdminsMinSeverity] or 3
    for _, p in ipairs(MG.State.list()) do
        if p.admin and p.admin.perms['detections.view'] and (Admin.open[p.src] or MG.SEVERITY_RANK[rec.severity] >= minRank) then
            TriggerClientEvent('milcsoguard:admin:detection', p.src, {
                localId = rec.localId, type = rec.type, severity = rec.severity, action = rec.action, actionResult = rec.actionResult,
                playerName = rec.playerName, netId = rec.netId, riskScore = rec.riskScore, occurredAt = rec.occurredAt, source = rec.source,
            })
        end
    end
end

function Admin.broadcastSystem(message, severity)
    for _, p in ipairs(MG.State.list()) do
        if p.admin and p.admin.perms['system.view'] then
            TriggerClientEvent('milcsoguard:admin:system', p.src, { message = message, severity = severity })
        end
    end
end

return Admin
