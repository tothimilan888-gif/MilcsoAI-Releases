-- Sliding-window counters keyed by arbitrary strings. Pure Lua; time is passed in by the caller.
MG = MG or {}
local RateLimiter = {}
RateLimiter.__index = RateLimiter

--- @param limit number max hits per window
--- @param windowMs number window length in milliseconds
function RateLimiter.new(limit, windowMs)
    return setmetatable({ limit = limit, windowMs = windowMs, buckets = {} }, RateLimiter)
end

--- Registers a hit. Returns allowed (boolean) and the hit count inside the window.
function RateLimiter:hit(key, now, weight)
    local b = self.buckets[key]
    if not b then
        b = { start = now, count = 0, prevCount = 0 }
        self.buckets[key] = b
    end
    local elapsed = now - b.start
    if elapsed >= self.windowMs then
        local windows = elapsed // self.windowMs
        b.prevCount = windows == 1 and b.count or 0
        b.count = 0
        b.start = b.start + windows * self.windowMs
        elapsed = now - b.start
    end
    b.count = b.count + (weight or 1)
    -- weighted sliding window approximation
    local estimate = b.prevCount * ((self.windowMs - elapsed) / self.windowMs) + b.count
    return estimate <= self.limit, estimate
end

function RateLimiter:reset(key)
    self.buckets[key] = nil
end

--- Drops buckets idle for more than two windows (call periodically).
function RateLimiter:gc(now)
    for k, b in pairs(self.buckets) do
        if now - b.start > self.windowMs * 2 then self.buckets[k] = nil end
    end
end

MG.RateLimiter = RateLimiter
return RateLimiter
