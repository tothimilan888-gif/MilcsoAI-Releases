-- Event / exploit protection:
--  * honeypot events (names no legitimate client ever triggers),
--  * CheckEvent export: rate limiting for other resources' net event handlers,
--  * ReportSuspicious export: other resources report validated exploit attempts,
--  * economy monitoring through framework money events and ox_inventory hooks.
-- FiveM offers no global hook into other resources' net events, so exploit protection of
-- third-party events relies on those resources calling CheckEvent (documented limitation).
MG = MG or {}
local U = MG.Util
local Log = MG.Log
local Ev = { honeypots = {}, limiters = {}, economy = {} }
MG.EventChecks = Ev

local registered = {}

--- A honeypot is only armed if no started resource could legitimately own the event name.
function Ev.safeHoneypot(name)
    local prefix = name:match('^([^:]+):')
    if prefix and GetResourceState(prefix) ~= 'missing' then return false, ('resource "%s" exists'):format(prefix) end
    return true
end

MG.Sync.onConfig(function(modules)
    local hp = modules['events.honeypot']
    Ev.honeypots = {}
    for _, name in ipairs(hp and hp.params.events or {}) do
        local ok, why = Ev.safeHoneypot(name)
        if ok then
            Ev.honeypots[name] = true
            if not registered[name] then
                registered[name] = true
                RegisterNetEvent(name, function(...)
                    if not Ev.honeypots[name] then return end
                    local src = source
                    local argc = select('#', ...)
                    MG.Detections.report(src, 'events.honeypot', { conclusive = true, evidence = { event = name, argCount = argc } })
                end)
            end
        else
            Log.warn('honeypot "%s" skipped: %s', name, why)
        end
    end
    local sp = modules['events.spam']
    Ev.defaultWindowMs = (sp and sp.params.windowSeconds or 10) * 1000
    Ev.defaultLimit = sp and sp.params.defaultLimit or 20
    Ev.limiters = {}
end)

--- Rate limit check for a named event. Returns true when the call may proceed.
function Ev.check(src, eventName, opts)
    src = tonumber(src)
    if not src or src <= 0 or type(eventName) ~= 'string' then return false end
    opts = opts or {}
    local limit = tonumber(opts.limit) or Ev.defaultLimit or 20
    local windowMs = tonumber(opts.windowMs) or Ev.defaultWindowMs or 10000
    local key = eventName .. '|' .. limit .. '|' .. windowMs
    local lim = Ev.limiters[key]
    if not lim then
        lim = MG.RateLimiter.new(limit, windowMs)
        Ev.limiters[key] = lim
    end
    local ok, n = lim:hit(src, GetGameTimer())
    if not ok then
        MG.Detections.report(src, 'events.spam', { blocked = true, evidence = { event = eventName, count = math.floor(n), limit = limit, windowMs = windowMs, resource = GetInvokingResource() } })
    end
    return ok
end

--- Reports a suspicious action detected by another resource.
function Ev.reportFromResource(src, reason, evidence)
    local res = GetInvokingResource() or 'unknown'
    local ev = U.obj({ reason = U.sanitize(reason or 'unspecified', 200), resource = res })
    if type(evidence) == 'table' then
        local ok, encoded = pcall(json.encode, evidence)
        if ok and #encoded <= 4000 then ev.details = evidence else ev.details = '(evidence too large)' end
    end
    return MG.Detections.report(src, 'events.reported', { evidence = ev }) ~= nil
end

-- ------------------------------------------------------------------ economy
--- Pure evaluation (unit tested). state = { entries = { {t, amount} } }
function Ev.evaluateMoney(state, amount, now, params)
    local windowMs = params.windowMinutes * 60000
    local kept, sum = {}, 0
    for _, e in ipairs(state.entries) do
        if now - e.t < windowMs then
            kept[#kept + 1] = e
            sum = sum + e.amount
        end
    end
    kept[#kept + 1] = { t = now, amount = amount }
    sum = sum + amount
    state.entries = kept
    if amount >= params.singleAmount then return 'single', sum end
    if sum >= params.windowAmount then
        state.entries = {}
        return 'window', sum
    end
    return nil, sum
end

local function onEconomy(src, kind, amount, info)
    local m = MG.Detections.module('economy.transactions')
    if not m or not src or src <= 0 or amount <= 0 then return end
    local p = MG.State.get(src)
    if not p then return end
    if kind == 'money' then
        p.economy = p.economy or { entries = {} }
        local verdict, sum = Ev.evaluateMoney(p.economy, amount, GetGameTimer(), m.params)
        if verdict then
            MG.Detections.report(src, 'economy.transactions', { evidence = { reason = verdict, amount = amount, windowSum = sum, account = info.account, note = U.sanitize(info.reason or '', 120) } })
        end
    elseif kind == 'item' and amount >= m.params.itemCount then
        MG.Detections.report(src, 'economy.transactions', { evidence = { reason = 'item_count', item = info.item, count = amount, resource = info.resource } })
    end
end

function Ev.start()
    MG.Bridge.onEconomy(onEconomy)
end

return Ev
