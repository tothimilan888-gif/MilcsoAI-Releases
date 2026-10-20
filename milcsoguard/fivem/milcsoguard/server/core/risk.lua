-- Risk scoring and action decision. Pure Lua (no natives) so it can be unit tested.
MG = MG or {}
local Risk = {}
MG.Risk = Risk

local ACTION_RANK = MG.ACTION_RANK

--- Creates per-player risk state.
function Risk.newState()
    return { score = 0.0, updatedAt = nil, types = {}, history = {} }
end

--- Exponential decay with the configured half-life.
function Risk.decayed(state, now, halfLifeMs)
    if not state.updatedAt or state.score <= 0 then return state.score end
    local elapsed = now - state.updatedAt
    if elapsed <= 0 then return state.score end
    return state.score * (0.5 ^ (elapsed / halfLifeMs))
end

--- Points contributed by one detection: severity points x source multiplier x optional module weight.
function Risk.points(cfg, severity, source, weight)
    local base = cfg.severityPoints[severity] or 0
    local mult = cfg.sourceMultiplier[source] or 1.0
    return base * mult * (weight or 1.0)
end

--- Adds a detection to the state and returns the new score.
function Risk.add(state, cfg, now, points, typeKey, source)
    state.score = Risk.decayed(state, now, cfg.halfLifeMs) + points
    state.updatedAt = now
    state.types[typeKey] = { at = now, source = source }
    local h = state.history
    h[#h + 1] = { at = now, type = typeKey, source = source, points = points }
    if #h > 50 then table.remove(h, 1) end
    return state.score
end

--- Number of distinct server-authoritative detection types seen within the window.
function Risk.distinctServerTypes(state, now, windowMs)
    local n = 0
    for _, t in pairs(state.types) do
        if t.source ~= 'client' and now - t.at <= windowMs then n = n + 1 end
    end
    return n
end

local function maxAction(a, b)
    if (ACTION_RANK[a] or 0) >= (ACTION_RANK[b] or 0) then return a end
    return b
end

--- Escalation purely from the accumulated score.
function Risk.thresholdAction(cfg, score)
    local t = cfg.thresholds
    if score >= t.ban then return 'ban' end
    if score >= t.kick then return 'kick' end
    if score >= t.monitor then return 'monitor' end
    if score >= t.warn then return 'warn' end
    return 'log'
end

--[[
  Decides the final action and explains it. Safety guards (not configurable away):
    * a detection whose own source is 'client' can never cause a ban by itself;
    * a ban needs >= minDistinctServerTypesForBan distinct server-side detection types in the
      corroboration window, unless the detection is marked conclusive AND server-side;
    * the auto-ban circuit breaker and the global autoBanEnabled switch downgrade bans to kicks.
  input = { moduleAction, source, conclusive, score, distinctServerTypes, breakerOpen }
]]
function Risk.decide(cfg, input)
    local action = maxAction(input.moduleAction or 'log', Risk.thresholdAction(cfg, input.score or 0))
    local notes = {}
    if action == 'ban' then
        local corroborated = (input.distinctServerTypes or 0) >= cfg.minDistinctServerTypesForBan
        local conclusive = input.conclusive and input.source ~= 'client'
        if not cfg.autoBanEnabled then
            action = 'kick'
            notes[#notes + 1] = 'auto-ban disabled'
        elseif input.source == 'client' and not corroborated then
            action = 'kick'
            notes[#notes + 1] = 'client-only signal cannot ban'
        elseif not corroborated and not conclusive then
            action = 'kick'
            notes[#notes + 1] = ('needs %d independent server-side detections'):format(cfg.minDistinctServerTypesForBan)
        elseif input.breakerOpen then
            action = 'kick'
            notes[#notes + 1] = 'auto-ban circuit breaker open'
        end
    end
    return action, table.concat(notes, '; ')
end

--- Circuit breaker: at most maxAutoBans automatic bans per window; beyond that, bans become kicks
--- and admins are alerted (protects against a buggy rule banning everyone).
local Breaker = {}
Breaker.__index = Breaker
Risk.Breaker = Breaker

function Breaker.new(maxBans, windowMs)
    return setmetatable({ max = maxBans, windowMs = windowMs, hits = {} }, Breaker)
end

function Breaker:isOpen(now)
    local kept = {}
    for _, t in ipairs(self.hits) do
        if now - t < self.windowMs then kept[#kept + 1] = t end
    end
    self.hits = kept
    return #kept >= self.max
end

function Breaker:record(now)
    self.hits[#self.hits + 1] = now
end

return Risk
