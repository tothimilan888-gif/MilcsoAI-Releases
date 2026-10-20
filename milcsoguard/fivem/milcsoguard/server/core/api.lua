-- Backend HTTP client with timeouts, backoff and a persistent outbound queue.
-- The game server keeps protecting players when the backend is down: nothing here is required
-- for detection or enforcement, it only reports and synchronises.
MG = MG or {}
local U = MG.Util
local Log = MG.Log
local Api = {
    online = false,
    lastOkAt = 0,
    lastError = nil,
    failures = 0,
    nextAttemptAt = 0,
    queue = {},
    queueDirty = false,
    serverId = nil,
    serverName = nil,
    stats = { sent = 0, failed = 0, dropped = 0 },
}
MG.Api = Api

local QUEUE_KEY = 'mg:queue'

function Api.enabled()
    return Config.Api.enabled == true
end

local function key()
    return GetConvar('milcsoguard_api_key', '')
end

--- Low-level request. cb(ok, status, data, err). Never throws; enforces its own timeout.
function Api.request(method, path, body, cb, opts)
    if not Api.enabled() then return cb(false, 0, nil, 'api disabled') end
    local k = key()
    if k == '' then return cb(false, 0, nil, 'missing milcsoguard_api_key convar') end
    local done = false
    local timeoutMs = (opts and opts.timeoutMs) or Config.Api.timeoutMs
    -- opts.rawBody: pre-encoded JSON (large replay uploads)
    local payload = (opts and opts.rawBody) or (body ~= nil and json.encode(body) or '')
    local headers = {
        ['Authorization'] = 'Bearer ' .. k,
        ['Content-Type'] = 'application/json',
        ['Accept'] = 'application/json',
        ['User-Agent'] = 'MilcsoGuard/' .. (MG.VERSION or '0'),
    }
    local function finish(ok, status, data, err)
        if done then return end
        done = true
        if ok then
            Api.online = true
            Api.lastOkAt = os.time()
            Api.failures = 0
            Api.lastError = nil
        elseif status == 0 or status >= 500 or status == 401 or status == 403 or status == 429 then
            -- 401/403 mean a wrong/revoked key or HTTPS misconfiguration: keep the queue and back off.
            -- transport-level failure: back off (5s, 10s, 20s ... max 5min)
            Api.failures = Api.failures + 1
            Api.online = false
            Api.lastError = err or ('HTTP ' .. tostring(status))
            Api.nextAttemptAt = GetGameTimer() + math.min(300000, 5000 * (2 ^ math.min(Api.failures - 1, 6)))
        else
            Api.lastError = err or ('HTTP ' .. tostring(status))
        end
        cb(ok, status, data, err)
    end
    SetTimeout(timeoutMs, function()
        finish(false, 0, nil, ('timeout after %dms'):format(timeoutMs))
    end)
    PerformHttpRequest(Config.Api.url .. '/api/v1/game' .. path, function(status, respBody)
        local data = nil
        if respBody and respBody ~= '' then
            local okDecode, decoded = pcall(json.decode, respBody)
            if okDecode then data = decoded end
        end
        status = tonumber(status) or 0
        local ok = status >= 200 and status < 300
        local err = nil
        if not ok then
            err = data and data.error and data.error.message or ('HTTP ' .. status)
            if data and data.error and data.error.details then
                err = err .. ' ' .. json.encode(data.error.details)
            end
        end
        finish(ok, status, data, err)
    end, method, payload, headers, { followLocation = false })
end

--- Coroutine-friendly variant (use inside Citizen.CreateThread).
function Api.await(method, path, body, opts)
    local p = promise.new()
    Api.request(method, path, body, function(ok, status, data, err)
        p:resolve({ ok = ok, status = status, data = data, err = err })
    end, opts)
    return Citizen.Await(p)
end

--- True when the backoff window allows another attempt.
function Api.canAttempt()
    return Api.enabled() and GetGameTimer() >= Api.nextAttemptAt
end

-- ------------------------------------------------------------------ persistent queue
function Api.loadQueue()
    local raw = GetResourceKvpString(QUEUE_KEY)
    if raw and raw ~= '' then
        local ok, q = pcall(json.decode, raw)
        if ok and type(q) == 'table' then Api.queue = q end
    end
    if #Api.queue > 0 then Log.info('%d queued item(s) restored from previous run', #Api.queue) end
end

function Api.saveQueue()
    if not Api.queueDirty then return end
    Api.queueDirty = false
    SetResourceKvp(QUEUE_KEY, json.encode(Api.queue))
end

--- Queues an item ({ kind = 'detection'|'ban'|'revoke'|'event'|'audit', data = {...} }).
--- When full, the oldest detections are dropped first; bans are never dropped silently.
function Api.enqueue(kind, data)
    if not Api.enabled() then return end
    local q = Api.queue
    if #q >= Config.Api.maxQueue then
        for i = 1, #q do
            if q[i].kind == 'detection' or q[i].kind == 'event' or q[i].kind == 'audit' then
                table.remove(q, i)
                Api.stats.dropped = Api.stats.dropped + 1
                break
            end
        end
        if #q >= Config.Api.maxQueue then
            Log.error('outbound queue full of bans/revokes; backend unreachable for too long')
            return
        end
    end
    q[#q + 1] = { kind = kind, data = data, attempts = 0 }
    Api.queueDirty = true
end

--- Permanent rejections (the request itself is invalid); anything else is retried later.
local function rejected(status)
    return status == 400 or status == 404 or status == 409 or status == 413 or status == 422
end

local flushing = false
--- Sends queued items in order. Detections are batched (<=100). Items rejected with 4xx are
--- logged and dropped (they would never succeed); 5xx/timeouts are retried with backoff.
function Api.flush()
    if flushing or #Api.queue == 0 or not Api.canAttempt() then return end
    flushing = true
    Citizen.CreateThread(function()
        while #Api.queue > 0 and Api.canAttempt() do
            local head = Api.queue[1]
            if head.kind == 'detection' then
                local batch, n = {}, 0
                for i = 1, #Api.queue do
                    if Api.queue[i].kind ~= 'detection' or n >= 100 then break end
                    n = n + 1
                    batch[n] = Api.queue[i].data
                end
                local r = Api.await('POST', '/detections', { detections = batch })
                if r.ok or rejected(r.status) then
                    if not r.ok then Log.warn('backend rejected %d detection(s): %s', n, tostring(r.err)) end
                    for _ = 1, n do table.remove(Api.queue, 1) end
                    Api.queueDirty = true
                    Api.stats.sent = Api.stats.sent + (r.ok and n or 0)
                else
                    Api.stats.failed = Api.stats.failed + 1
                    break
                end
            else
                local path, method = nil, 'POST'
                if head.kind == 'ban' then path = '/bans'
                elseif head.kind == 'revoke' then path = '/bans/' .. head.data.banId .. '/revoke'
                elseif head.kind == 'event' then path = '/system-events'
                elseif head.kind == 'audit' then path = '/admin/audit' end
                local body = head.data
                if head.kind == 'revoke' then body = { reason = head.data.reason, actor = head.data.actor } end
                if head.kind == 'ban' then
                    body = U.deepCopy(head.data)
                    body.ageSeconds = math.max(0, os.time() - (head.data.queuedAt or os.time()))
                    body.queuedAt = nil
                end
                local r = path and Api.await(method, path, body) or { ok = false, status = 400, err = 'unknown kind' }
                if r.ok then
                    if head.kind == 'ban' and MG.Bans then MG.Bans.onRemoteCreated(head.data.localId, r.data and r.data.ban) end
                    table.remove(Api.queue, 1)
                    Api.queueDirty = true
                elseif rejected(r.status) then
                    Log.error('backend rejected queued %s: %s', head.kind, tostring(r.err))
                    table.remove(Api.queue, 1)
                    Api.queueDirty = true
                else
                    break
                end
            end
        end
        Api.saveQueue()
        flushing = false
    end)
end

return Api
