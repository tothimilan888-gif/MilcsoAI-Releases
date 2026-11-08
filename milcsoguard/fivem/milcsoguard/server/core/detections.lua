-- Central detection pipeline: exemptions -> dedup -> risk -> decision (with safety guards) ->
-- action -> local ring buffer + outbound queue + admin notification.
MG = MG or {}
local U = MG.Util
local Log = MG.Log
local Risk = MG.Risk
local D = { ring = {}, modules = {}, risk = nil, breaker = nil, counters = { total = 0, byAction = {} } }
MG.Detections = D

--- Applies an effective configuration (from MG.Schema.build).
function D.configure(modules, risk)
    D.modules = modules
    D.risk = {
        halfLifeMs = risk.halfLifeMinutes * 60000,
        thresholds = { warn = risk.warnThreshold, monitor = risk.monitorThreshold, kick = risk.kickThreshold, ban = risk.banThreshold },
        minDistinctServerTypesForBan = risk.minDistinctServerTypesForBan,
        autoBanEnabled = risk.autoBanEnabled,
        autoBanDuration = risk.autoBanDurationHours > 0 and risk.autoBanDurationHours * 3600 or nil,
        monitorMs = risk.monitorMinutes * 60000,
        severityPoints = Config.Risk.severityPoints,
        sourceMultiplier = Config.Risk.sourceMultiplier,
        corroborationWindowMs = Config.Risk.corroborationWindowMinutes * 60000,
    }
    local prev = D.breaker
    D.breaker = Risk.Breaker.new(risk.breakerMaxBans, risk.breakerWindowMinutes * 60000)
    if prev then D.breaker.hits = prev.hits end
end

function D.module(key)
    local m = D.modules[key]
    if m and m.enabled then return m end
    return nil
end

local function pushRing(rec)
    local r = D.ring
    r[#r + 1] = rec
    if #r > Config.Detections.ringSize then table.remove(r, 1) end
end

function D.recent(limit, filter)
    local out = {}
    for i = #D.ring, 1, -1 do
        local rec = D.ring[i]
        if not filter or filter(rec) then
            out[#out + 1] = rec
            if #out >= (limit or 50) then break end
        end
    end
    return out
end

local function recentLocalIds(src, max)
    local ids = {}
    for i = #D.ring, 1, -1 do
        local rec = D.ring[i]
        if rec.netId == src then
            ids[#ids + 1] = rec.localId
            if #ids >= (max or 10) then break end
        end
    end
    return ids
end

--[[
  Asks the player's recorder for the last seconds as evidence for this detection (Config.Replay
  onDetection). Returns the replay id, or nil when not eligible (disabled, severity too low,
  recorder not running, cooldown, another capture running).
]]
function D.captureEvidence(p, rec, now, onCaptured)
    local R, c = MG.Replay, Config.Replay
    if not (R and R.enabled() and c.onDetection) or p.banning or p.removing or p.replayState ~= 'recording' then return nil end
    if (MG.SEVERITY_RANK[rec.severity] or 0) < (MG.SEVERITY_RANK[c.detectionMinSeverity] or 4) then return nil end
    if p.lastEvidenceAt and now - p.lastEvidenceAt < c.detectionCooldownSeconds * 1000 then return nil end
    local id = R.capture(p.src, { kind = 'detection', detectionLocalId = rec.localId, reason = rec.type, onCaptured = onCaptured })
    if id then
        p.lastEvidenceAt = now
        rec.replayId = id
    end
    return id
end

local function execute(p, rec, now)
    local action = rec.action
    if p.banning or (p.removing and action ~= 'ban') then
        -- already being removed (replay upload in progress): record, but do not act twice
        rec.actionResult = p.banning and 'already banned' or 'already being kicked'
        return
    end
    if action == 'warn' or action == 'monitor' then
        if Config.Detections.warnPlayerMessage ~= '' and action == 'warn' then
            TriggerClientEvent('milcsoguard:notice', p.src, Config.Detections.warnPlayerMessage)
        end
        if action == 'monitor' then
            p.monitoredUntil = now + D.risk.monitorMs
            rec.actionResult = 'monitored ' .. math.floor(D.risk.monitorMs / 60000) .. 'm'
        end
    elseif action == 'kick' then
        rec.actionResult = (rec.actionResult ~= '' and rec.actionResult .. '; ' or '') .. 'kicked'
        local msg = Config.Detections.kickMessage:format(rec.type)
        -- with a replay: drop once it is uploaded (isolated meanwhile), like a ban
        local id = D.captureEvidence(p, rec, now, function() DropPlayer(tostring(p.src), msg) end)
        if id then
            p.removing = true -- only a ban may still follow while the replay uploads
            if Config.Replay.isolateOnBan then
                SetTimeout(1000, function() if MG.State.get(p.src) then MG.Replay.isolate(p) end end)
            end
        else
            SetTimeout(250, function() DropPlayer(tostring(p.src), msg) end)
        end
    elseif action == 'ban' then
        D.breaker:record(now)
        local ban = MG.Bans.create({
            identifiers = p.identifiers,
            playerName = p.name,
            reason = ('Automatikus: %s (kockázat %d)'):format(rec.type, rec.riskScore),
            durationSeconds = D.risk.autoBanDuration,
            actor = nil,
            detectionLocalIds = recentLocalIds(p.src, 10),
        })
        rec.actionResult = 'banned ' .. (D.risk.autoBanDuration and U.formatDuration(D.risk.autoBanDuration) or 'permanent')
        MG.Bans.enforce(p.src, ban)
        if D.breaker:isOpen(now) then
            Log.warn('auto-ban circuit breaker reached its limit; further automatic bans become kicks')
            if MG.Admin then MG.Admin.broadcastSystem('Auto-ban circuit breaker aktív: a további automatikus banok kickre módosulnak.', 'CRITICAL') end
        end
    end
end

--[[
  Reports a detection for a player.
  opts = {
    evidence   = table (bounded, rendered as JSON),
    severity   = override severity,
    source     = override source ('server'|'client'|'event'|'resource'|'system'),
    conclusive = true when the evidence alone proves cheating (server-side only, e.g. honeypot),
    blocked    = true when the offending game event was cancelled,
  }
  Returns the detection record, or nil when skipped (disabled / exempt / deduplicated).
]]
function D.report(src, key, opts)
    opts = opts or {}
    local m = D.module(key)
    if not m then return nil end
    local spec = MG.Schema.modules[key]
    local p = MG.State.get(src)
    if not p then return nil end
    local now = MG.State.now()

    local exempt, why = MG.State.isExempt(p, key, now, { ignoreGrace = opts.ignoreGrace })
    if exempt then
        Log.debug('skip %s for #%d (%s)', key, src, why)
        return nil
    end

    -- Dedup: repeated identical detections within the window only bump the counter.
    local last = p.lastDetectionAt[key]
    if last and now - last.at < Config.Detections.dedupSeconds * 1000 then
        last.rec.repeats = (last.rec.repeats or 1) + 1
        return nil
    end

    local severity = opts.severity or m.severity
    local source = opts.source or spec.source
    local points = Risk.points(D.risk, severity, source)
    local score = Risk.add(p.risk, D.risk, now, points, key, source)
    local distinct = Risk.distinctServerTypes(p.risk, now, D.risk.corroborationWindowMs)
    local action, note = Risk.decide(D.risk, {
        moduleAction = m.action, source = source,
        -- banAlone: the admin trusts this module enough to ban on one detection (never for client signals)
        conclusive = opts.conclusive == true or (m.params.banAlone == true and opts.banAloneEligible ~= false),
        score = score, distinctServerTypes = distinct, breakerOpen = D.breaker:isOpen(now),
    })

    local evidence = U.obj(opts.evidence or {})
    if opts.blocked then evidence.blocked = true end
    if (p.monitoredUntil or 0) > now then evidence.monitored = true end

    local rec = {
        localId = 'det-' .. U.uuid():gsub('-', ''),
        type = key,
        module = key:match('^([^.]+)'),
        severity = severity,
        riskScore = math.floor(score + 0.5),
        source = source,
        action = action,
        actionResult = note or '',
        netId = src,
        playerName = p.name,
        identifiers = U.filterIdentifiers(p.identifiers, U.toSet(Config.Api.excludeIdentifierTypes)),
        evidence = evidence,
        occurredAt = U.isoTime(),
        repeats = 1,
    }
    p.lastDetectionAt[key] = { at = now, rec = rec }
    D.counters.total = D.counters.total + 1
    D.counters.byAction[action] = (D.counters.byAction[action] or 0) + 1

    Log.info('%s %s #%d %s -> %s (risk %d)%s', severity, key, src, p.name, action, rec.riskScore, note ~= '' and (' [' .. note .. ']') or '')
    execute(p, rec, now)
    if action ~= 'kick' and action ~= 'ban' then D.captureEvidence(p, rec, now) end
    pushRing(rec)
    MG.Api.enqueue('detection', {
        localId = rec.localId, type = rec.type, module = rec.module, severity = rec.severity, riskScore = rec.riskScore,
        source = rec.source, action = rec.action, actionResult = rec.actionResult, netId = rec.netId, playerName = rec.playerName,
        identifiers = rec.identifiers, evidence = rec.evidence, occurredAt = rec.occurredAt,
    })
    if action == 'kick' or action == 'ban' then MG.Api.flush() end
    if MG.Admin then MG.Admin.broadcastDetection(rec) end
    return rec
end

--- Current decayed risk score for a player.
function D.score(p)
    if not p or not D.risk then return 0 end
    return math.floor(Risk.decayed(p.risk, MG.State.now(), D.risk.halfLifeMs) + 0.5)
end

return D
