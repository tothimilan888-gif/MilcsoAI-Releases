-- Local ban store. Bans are cached in resource KVP so they are enforced even when the backend is
-- unreachable or the server restarts while it is down. The backend stays the source of truth:
-- full/delta syncs replace the cache, local bans are pushed through the outbound queue.
MG = MG or {}
local U = MG.Util
local Log = MG.Log
local Bans = { byId = {}, index = {}, lastSync = nil, matchTypes = nil, syncing = false }
MG.Bans = Bans

local PREFIX = 'mg:ban:'
local SYNC_KEY = 'mg:bansync'
-- Same default as the backend. Hardware tokens are collected as evidence but only match when
-- enabled per server (shared PCs would otherwise cause collateral bans).
local DEFAULT_MATCH = { 'license', 'license2', 'discord', 'fivem', 'steam', 'xbl', 'live' }

local function matchSet()
    return U.toSet(Bans.matchTypes or DEFAULT_MATCH)
end

local function indexBan(ban)
    for _, i in ipairs(ban.identifiers or {}) do
        Bans.index[i] = Bans.index[i] or {}
        Bans.index[i][ban.id] = true
    end
end

local function unindexBan(ban)
    for _, i in ipairs(ban.identifiers or {}) do
        if Bans.index[i] then
            Bans.index[i][ban.id] = nil
            if next(Bans.index[i]) == nil then Bans.index[i] = nil end
        end
    end
end

function Bans.isActive(ban, now)
    return ban and (ban.expiresAt == nil or ban.expiresAt > (now or os.time()))
end

local function persist(ban)
    SetResourceKvp(PREFIX .. ban.id, json.encode(ban))
end

function Bans.put(ban)
    local old = Bans.byId[ban.id]
    if old then unindexBan(old) end
    Bans.byId[ban.id] = ban
    indexBan(ban)
    persist(ban)
end

function Bans.remove(id)
    local ban = Bans.byId[id]
    if not ban then return end
    unindexBan(ban)
    Bans.byId[id] = nil
    DeleteResourceKvp(PREFIX .. id)
end

function Bans.load()
    local handle = StartFindKvp(PREFIX)
    local n, expired = 0, 0
    if handle ~= -1 then
        while true do
            local k = FindKvp(handle)
            if not k then break end
            local raw = GetResourceKvpString(k)
            local ok, ban = pcall(json.decode, raw or '')
            if ok and type(ban) == 'table' and ban.id then
                if Bans.isActive(ban) then
                    Bans.byId[ban.id] = ban
                    indexBan(ban)
                    n = n + 1
                else
                    DeleteResourceKvp(k)
                    expired = expired + 1
                end
            else
                DeleteResourceKvp(k)
            end
        end
        EndFindKvp(handle)
    end
    local sync = GetResourceKvpString(SYNC_KEY)
    if sync and sync ~= '' then
        local ok, s = pcall(json.decode, sync)
        if ok and type(s) == 'table' then
            Bans.lastSync = s.lastSync
            Bans.matchTypes = s.matchTypes
        end
    end
    Log.info('ban cache loaded: %d active (%d expired removed)', n, expired)
end

--- Returns the active ban matching any of the identifiers (types limited to the match list).
function Bans.find(identifiers)
    local allowed = matchSet()
    local now = os.time()
    local best = nil
    for _, i in ipairs(identifiers or {}) do
        local t = i:match('^([%w]+):')
        if t and allowed[t] and Bans.index[i] then
            for id in pairs(Bans.index[i]) do
                local ban = Bans.byId[id]
                if Bans.isActive(ban, now) then
                    -- prefer permanent, then the longest remaining
                    if not best or (best.expiresAt and (not ban.expiresAt or ban.expiresAt > best.expiresAt)) then best = ban end
                end
            end
        end
    end
    return best
end

function Bans.message(ban)
    local expires = ban.expiresAt and os.date('%Y-%m-%d %H:%M', ban.expiresAt) or 'soha (végleges)'
    local msg = Config.Bans.message:format(ban.reason or '-', expires, ban.code or ban.id)
    if Config.Bans.appealText and Config.Bans.appealText ~= '' then msg = msg .. '\n' .. Config.Bans.appealText end
    return msg
end

--[[
  Removes a banned player from the server. When the player's replay recorder runs, the last
  seconds of their view are collected first (Config.Replay.onBan): the player is moved to a
  private routing bucket and frozen, and dropped as soon as the upload ended – at the latest
  after Config.Replay.uploadTimeoutSeconds. The ban itself is already in force (cached), so a
  reconnect during that time is refused.
]]
function Bans.enforce(src, ban)
    local p = MG.State.get(src)
    if not p or p.banning then return false end
    p.banning = true
    local msg = Bans.message(ban)
    local R = MG.Replay
    if R and R.enabled() and Config.Replay.onBan and p.replayState == 'recording' then
        local id = R.capture(p.src, {
            kind = 'ban', reason = ban.reason, banLocalId = ban.localId,
            banId = not U.startsWith(ban.id, 'local:') and ban.id or nil,
            onCaptured = function() DropPlayer(tostring(p.src), msg) end,
        })
        if id then
            ban.replayId = id
            if Config.Replay.isolateOnBan then
                -- a moment later, so the client stops its recorder before the world disappears
                SetTimeout(1000, function() if MG.State.get(p.src) then R.isolate(p) end end)
            end
            return true
        end
    end
    SetTimeout(250, function() DropPlayer(tostring(p.src), msg) end)
    return true
end

--- Drops every online player matching an active ban.
function Bans.enforceOnline()
    for _, p in ipairs(MG.State.list()) do
        local ban = Bans.find(p.identifiers)
        if ban and not p.banning then
            Log.info('dropping banned player %s (#%d) – ban %s', p.name, p.src, ban.code or ban.id)
            Bans.enforce(p.src, ban)
        end
    end
end

--[[
  Creates a ban. The ban is enforced locally immediately and queued for the backend.
  opts = { identifiers, playerName, reason, durationSeconds (nil = permanent), actor (nil = system),
           detectionLocalIds }
]]
function Bans.create(opts)
    local localId = 'gban-' .. U.uuid():gsub('-', '')
    local now = os.time()
    local ids = {}
    for _, i in ipairs(opts.identifiers or {}) do
        if not U.startsWith(i, 'ip:') then ids[#ids + 1] = i end
    end
    local ban = {
        id = 'local:' .. localId,
        localId = localId,
        code = 'PENDING',
        reason = opts.reason,
        playerName = opts.playerName,
        identifiers = ids,
        createdAt = now,
        expiresAt = opts.durationSeconds and (now + opts.durationSeconds) or nil,
        pending = true,
        by = opts.actor and opts.actor.name or 'MilcsoGuard',
    }
    Bans.put(ban)
    MG.Api.enqueue('ban', {
        localId = localId,
        identifiers = U.filterIdentifiers(ids, U.toSet(Config.Api.excludeIdentifierTypes)),
        playerName = opts.playerName or '',
        reason = opts.reason,
        durationSeconds = opts.durationSeconds,
        actor = opts.actor,
        detectionLocalIds = opts.detectionLocalIds or {},
        -- local timestamp; converted to a relative age when sent, so clock skew between the game
        -- server and the backend cannot shorten or lengthen a ban that waited in the queue
        queuedAt = now,
    })
    MG.Api.flush()
    return ban
end

--- Called when the backend confirmed a queued ban: swap the local id for the real one.
function Bans.onRemoteCreated(localId, remote)
    local localKey = 'local:' .. localId
    local cur = Bans.byId[localKey]
    if not remote then
        -- expired before it could be synced
        Bans.remove(localKey)
        return
    end
    Bans.remove(localKey)
    Bans.put({
        id = remote.id, code = remote.code, reason = remote.reason, playerName = remote.playerName,
        identifiers = remote.identifiers or (cur and cur.identifiers) or {},
        createdAt = U.parseIso(remote.createdAt) or os.time(),
        expiresAt = remote.expiresAt and U.parseIso(remote.expiresAt) or nil,
    })
end

--- Revokes a ban. Remote bans are revoked through the backend (queued if offline).
function Bans.revoke(id, reason, actor)
    local ban = Bans.byId[id]
    if U.startsWith(id, 'local:') then
        -- not yet synced: drop the queued creation instead
        local localId = id:sub(7)
        for i = #MG.Api.queue, 1, -1 do
            local q = MG.Api.queue[i]
            if q.kind == 'ban' and q.data.localId == localId then table.remove(MG.Api.queue, i) end
        end
        MG.Api.queueDirty = true
        MG.Api.saveQueue()
    else
        MG.Api.enqueue('revoke', { banId = id, reason = reason, actor = actor })
        MG.Api.flush()
    end
    if ban then Bans.remove(id) end
    return ban ~= nil
end

local function fromRemote(b)
    return {
        id = b.id, code = b.code, reason = b.reason, playerName = b.playerName, identifiers = b.identifiers or {},
        createdAt = U.parseIso(b.createdAt) or os.time(), expiresAt = b.expiresAt and U.parseIso(b.expiresAt) or nil,
    }
end

--- Applies a /bans/sync response. Full syncs replace every non-pending cached ban.
function Bans.applySync(data)
    if type(data) ~= 'table' or type(data.bans) ~= 'table' then return false end
    if data.full then
        for id, ban in pairs(Bans.byId) do
            if not ban.pending then Bans.remove(id) end
        end
    end
    for _, b in ipairs(data.bans) do Bans.put(fromRemote(b)) end
    for _, id in ipairs(data.inactive or {}) do Bans.remove(id) end
    if type(data.matchTypes) == 'table' then Bans.matchTypes = data.matchTypes end
    Bans.lastSync = data.now
    SetResourceKvp(SYNC_KEY, json.encode({ lastSync = Bans.lastSync, matchTypes = Bans.matchTypes }))
    return true
end

function Bans.sync(forceFull)
    if Bans.syncing or not MG.Api.enabled() then return end
    Bans.syncing = true
    Citizen.CreateThread(function()
        local path = '/bans/sync'
        if Bans.lastSync and not forceFull then path = path .. '?since=' .. Bans.lastSync end
        local r = MG.Api.await('GET', path)
        if r.ok and Bans.applySync(r.data) then
            Log.debug('ban sync ok (%s, %d bans, %d inactive)', r.data.full and 'full' or 'delta', #r.data.bans, #(r.data.inactive or {}))
            Bans.enforceOnline()
        elseif not r.ok then
            Log.debug('ban sync failed: %s', tostring(r.err))
        end
        Bans.syncing = false
    end)
end

--- Removes expired bans from memory and KVP.
function Bans.prune()
    local now = os.time()
    for id, ban in pairs(Bans.byId) do
        if not Bans.isActive(ban, now) then Bans.remove(id) end
    end
end

function Bans.count()
    return U.count(Bans.byId)
end

return Bans
