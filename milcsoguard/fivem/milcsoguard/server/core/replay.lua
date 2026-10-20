-- POV replays: collects the last seconds of a player's game view from their client and forwards
-- it to the backend. The client is untrusted: it can refuse, send garbage or nothing at all, so
-- every chunk is bounded and checked, nothing here ever blocks a ban for longer than the timeout,
-- and only the player the replay was requested from can contribute data to it.
MG = MG or {}
local U = MG.Util
local Log = MG.Log
local Replay = { jobs = {}, byPlayer = {}, active = 0 }
MG.Replay = Replay

local MAX_PARTS = 16
local MAX_CHUNKS_PER_PART = 64
local MAX_CHUNK_CHARS = 300 * 1024
local B64 = '^[A-Za-z0-9+/]+=?=?$'

function Replay.enabled()
    return type(Config.Replay) == 'table' and Config.Replay.enabled == true
end

--- Settings for the NUI recorder (sent with the client config).
function Replay.clientConfig()
    if not Replay.enabled() then return nil end
    local c = Config.Replay
    return {
        seconds = c.seconds, segmentSeconds = c.segmentSeconds, width = c.width, height = c.height,
        fps = c.fps, bitrateKbps = c.bitrateKbps, uploadBps = c.uploadBps, flipY = c.flipY == true,
    }
end

local function isUuid(s)
    return type(s) == 'string' and s:match('^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$') ~= nil
end
Replay.isUuid = isUuid

-- ------------------------------------------------------------------ backend upload
local function completeRemote(id, status, err)
    return MG.Api.await('POST', '/replays/' .. id .. '/complete', { status = status, error = err and U.sanitize(err, 300) or nil })
end

--- Marks a replay the dashboard requested as failed (player offline, busy, ...).
function Replay.failRemote(id, err)
    if not MG.Api.enabled() or not isUuid(id) then return end
    Citizen.CreateThread(function() completeRemote(id, 'failed', err) end)
end

local function upload(job, parts, err)
    if not MG.Api.enabled() then
        Log.warn('replay %s for %s not stored: backend disabled', job.id, job.playerName)
        return
    end
    Citizen.CreateThread(function()
        local meta = {
            id = job.id, kind = job.kind, playerName = job.playerName, identifiers = job.identifiers, reason = job.reason,
            banId = isUuid(job.banId) and job.banId or nil, banLocalId = job.banLocalId, requestedBy = job.actor,
            width = job.width, height = job.height, fps = job.fps,
        }
        local r = MG.Api.await('POST', '/replays', meta)
        if not r.ok then
            Log.warn('replay %s rejected by backend: %s', job.id, tostring(r.err))
            return
        end
        local okAll = #parts > 0
        for i, part in ipairs(parts) do
            -- Built by hand: the payload is a few MB of base64 that needs no escaping (checked on receipt).
            local body = ('{"durationMs":%d,"data":"%s"}'):format(part.durationMs, table.concat(part.chunks))
            local pr = MG.Api.await('PUT', ('/replays/%s/parts/%d'):format(job.id, i - 1), nil, { rawBody = body, timeoutMs = 60000 })
            if not pr.ok then
                okAll = false
                err = 'part ' .. (i - 1) .. ': ' .. tostring(pr.err)
                break
            end
        end
        local c = completeRemote(job.id, okAll and 'ready' or 'failed', err)
        Log.info('replay %s (%s, %s): %s%s', job.id, job.kind, job.playerName, okAll and 'stored' or 'failed', err and (' – ' .. err) or '')
        if c.ok and MG.Admin and job.requestedBy then
            TriggerClientEvent('milcsoguard:notice', job.requestedBy, okAll and ('Visszajátszás elkészült: ' .. job.playerName) or ('Visszajátszás sikertelen: ' .. tostring(err)))
        end
    end)
end

-- ------------------------------------------------------------------ capture jobs
local function completeParts(job)
    local out = {}
    local m = job.manifest
    if not m then return out end
    for idx = 1, #m.parts do
        local want = m.parts[idx]
        local got = job.parts[idx]
        if not got then break end
        for seq = 1, want.chunks do
            if not got.chunks[seq] then return out end
        end
        out[#out + 1] = { chunks = got.chunks, durationMs = want.durationMs }
    end
    return out
end

local function finish(job, err)
    if job.finished then return end
    job.finished = true
    Replay.byPlayer[job.src] = nil
    Replay.jobs[job.id] = nil
    Replay.active = math.max(0, Replay.active - 1)
    local parts = completeParts(job)
    if #parts == 0 and not err then err = 'no video received' end
    if job.onCaptured then
        local ok, e = pcall(job.onCaptured, #parts > 0, err)
        if not ok then Log.error('replay callback failed: %s', tostring(e)) end
    end
    upload(job, parts, err)
end

local function checkComplete(job)
    local m = job.manifest
    if not m then return end
    if #completeParts(job) == #m.parts then finish(job, m.error) end
end

--[[
  Asks the player's client for its buffered replay.
  opts = { kind = 'ban'|'manual', id = uuid (dashboard requests), reason, banId, banLocalId,
           actor (in-game admin, for audit), requestedBy (admin src to notify),
           onCaptured = function(gotVideo, err) end  -- called once, when the upload from the client
                                                       ended (or timed out); the backend upload follows }
  Returns the replay id, or nil + reason.
]]
function Replay.capture(src, opts)
    opts = opts or {}
    if not Replay.enabled() then return nil, 'disabled' end
    local p = MG.State.get(src)
    if not p then return nil, 'offline' end
    if Replay.byPlayer[p.src] then return nil, 'busy' end
    if Replay.active >= Config.Replay.maxConcurrent then return nil, 'too many uploads in progress' end
    local id = opts.id or U.uuid()
    if not isUuid(id) or Replay.jobs[id] then return nil, 'invalid id' end
    local job = {
        id = id, src = p.src, kind = opts.kind or 'manual', reason = U.sanitize(opts.reason or '', 500),
        banId = opts.banId, banLocalId = opts.banLocalId, actor = opts.actor, requestedBy = opts.requestedBy,
        playerName = p.name, identifiers = U.filterIdentifiers(p.identifiers, U.toSet(Config.Api.excludeIdentifierTypes)),
        parts = {}, chars = 0, manifest = nil, finished = false, onCaptured = opts.onCaptured,
    }
    Replay.jobs[id] = job
    Replay.byPlayer[p.src] = id
    Replay.active = Replay.active + 1
    TriggerClientEvent('milcsoguard:replay:capture', p.src, id)
    SetTimeout(Config.Replay.uploadTimeoutSeconds * 1000, function()
        if not job.finished then finish(job, 'timeout') end
    end)
    return id
end

--- Moves a player who is about to be dropped out of everyone's way while the replay uploads.
function Replay.isolate(p)
    SetPlayerRoutingBucket(p.src, 60000 + p.src)
    local ped = GetPlayerPed(p.src)
    if ped and ped ~= 0 then FreezeEntityPosition(ped, true) end
end

local function jobFor(src, id)
    local job = type(id) == 'string' and Replay.jobs[id] or nil
    if not job or job.finished or job.src ~= tonumber(src) then return nil end
    return job
end

RegisterNetEvent('milcsoguard:replay:status', function(state, detail)
    local p = MG.State.get(source)
    if not p or type(state) ~= 'string' then return end
    if state ~= 'recording' and state ~= 'unsupported' and state ~= 'error' and state ~= 'idle' then return end
    if p.replayState ~= state then
        p.replayState = state
        p.replayDetail = U.sanitize(type(detail) == 'string' and detail or '', 200)
        Log.debug('replay recorder of %s: %s %s', p.name, state, p.replayDetail)
    end
end)

RegisterNetEvent('milcsoguard:replay:chunk', function(id, part, seq, data)
    local job = jobFor(source, id)
    if not job then return end
    part, seq = tonumber(part), tonumber(seq)
    if not part or not seq or part % 1 ~= 0 or seq % 1 ~= 0 or part < 0 or part >= MAX_PARTS or seq < 0 or seq >= MAX_CHUNKS_PER_PART
        or type(data) ~= 'string' or #data == 0 or #data > MAX_CHUNK_CHARS or not data:match(B64) then
        return finish(job, 'malformed chunk')
    end
    job.chars = job.chars + #data
    if job.chars > Config.Replay.maxBytes * 4 / 3 then return finish(job, 'too large') end
    local slot = job.parts[part + 1] or { chunks = {} }
    job.parts[part + 1] = slot
    slot.chunks[seq + 1] = data
    checkComplete(job)
end)

RegisterNetEvent('milcsoguard:replay:done', function(id, manifest)
    local job = jobFor(source, id)
    if not job then return end
    if type(manifest) ~= 'table' or type(manifest.parts) ~= 'table' or #manifest.parts > MAX_PARTS then
        return finish(job, 'malformed manifest')
    end
    local m = { parts = {}, error = type(manifest.error) == 'string' and U.sanitize(manifest.error, 200) or nil }
    for i, pt in ipairs(manifest.parts) do
        local chunks, dur = tonumber(type(pt) == 'table' and pt.chunks), tonumber(type(pt) == 'table' and pt.durationMs)
        if not chunks or chunks < 1 or chunks > MAX_CHUNKS_PER_PART or not dur then return finish(job, 'malformed manifest') end
        m.parts[i] = { chunks = math.floor(chunks), durationMs = U.clamp(math.floor(dur), 0, 120000) }
    end
    job.width = tonumber(manifest.width) and U.clamp(math.floor(manifest.width), 16, 4096) or nil
    job.height = tonumber(manifest.height) and U.clamp(math.floor(manifest.height), 16, 4096) or nil
    job.fps = tonumber(manifest.fps) and U.clamp(math.floor(manifest.fps), 1, 60) or nil
    job.manifest = m
    if #m.parts == 0 then return finish(job, m.error or 'empty buffer') end
    checkComplete(job)
end)

--- The player left mid-upload: keep whatever complete parts arrived.
function Replay.onDropped(src)
    local id = Replay.byPlayer[tonumber(src)]
    local job = id and Replay.jobs[id]
    if job then finish(job, 'player left during upload') end
end

return Replay
