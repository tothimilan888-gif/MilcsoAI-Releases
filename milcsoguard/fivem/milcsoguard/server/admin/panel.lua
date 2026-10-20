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
        monitored = (p.monitoredUntil or 0) > MG.State.now(),
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
    local duration = nil
    if payload.permanent == true then
        if not admin.perms['bans.permanent'] then return fail('Nincs jogosultságod végleges banhoz (bans.permanent).') end
    else
        duration = tonumber(payload.durationSeconds)
        if not duration or duration < 60 or duration > MAX_TEMP_BAN then return fail('Érvénytelen időtartam.') end
        duration = math.floor(duration)
    end
    local target = MG.State.get(payload.id)
    if not target then return fail('A játékos nincs online.') end
    if target.src == tonumber(src) then return fail('Saját magadat nem bannolhatod.') end
    if protectedTarget(admin, target) then return fail('Azonos vagy magasabb szintű admint nem bannolhatsz.') end
    local ban = MG.Bans.create({ identifiers = target.identifiers, playerName = target.name, reason = why, durationSeconds = duration, actor = Perm.actor(src) })
    Log.info('%s banned %s (%s): %s', admin.label, target.name, duration and U.formatDuration(duration) or 'permanent', why)
    DropPlayer(tostring(target.src), MG.Bans.message(ban))
    return ok({ id = ban.id })
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
