MG = MG or {}
local U = MG.Util
local State = { players = {}, pending = {} }
MG.State = State

function State.now() return GetGameTimer() end

--- Reads all identifiers (and optionally hardware tokens) of a player.
function State.readIdentifiers(src, withTokens)
    local list = {}
    for i = 0, GetNumPlayerIdentifiers(src) - 1 do
        local id = GetPlayerIdentifier(src, i)
        if id then list[#list + 1] = id end
    end
    if withTokens then
        for i = 0, GetNumPlayerTokens(src) - 1 do
            local t = GetPlayerToken(src, i)
            if t then list[#list + 1] = 'token:' .. t end
        end
    end
    local map, clean = U.parseIdentifiers(list)
    return clean, map
end

function State.create(src, data)
    local now = State.now()
    local p = {
        src = src,
        name = U.sanitize(data.name or GetPlayerName(src) or '?'),
        identifiers = data.identifiers or {},
        idmap = data.idmap or {},
        joinedAt = now,
        graceUntil = now + (Config.Grace.joinSeconds * 1000),
        exempt = {},
        whitelist = data.whitelist or {},     -- list of { modules = {...} }
        backendAdmin = data.backendAdmin,     -- admin info from the backend (linked web account)
        admin = nil,                          -- resolved permissions (MG.Permissions)
        risk = MG.Risk.newState(),
        monitoredUntil = 0,
        consecutive = {},
        lastDetectionAt = {},
        hb = { ready = false, misses = 0, nonce = nil, sentAt = 0 },
        sample = nil,
        notes = {},
    }
    State.players[src] = p
    return p
end

function State.get(src)
    return State.players[tonumber(src)]
end

function State.remove(src)
    State.players[tonumber(src)] = nil
end

--- True if the module should not be applied to this player right now.
--- Covers: join/respawn grace, explicit exemptions (exports), whitelist entries and admin bypass.
function State.isExempt(p, moduleKey, now, opts)
    now = now or State.now()
    if not (opts and opts.ignoreGrace) and now < (p.graceUntil or 0) and U.startsWith(moduleKey, 'movement.') then return true, 'grace' end
    if not (opts and opts.ignoreGrace) and now < (p.graceUntil or 0) and (moduleKey == 'player.invisible' or moduleKey == 'player.godmode') then return true, 'grace' end
    for key, untilMs in pairs(p.exempt) do
        if untilMs > now then
            if key == '*' or key == moduleKey or (key:sub(-2) == '.*' and U.startsWith(moduleKey, key:sub(1, -2))) then
                return true, 'exempt:' .. key
            end
        else
            p.exempt[key] = nil
        end
    end
    for _, w in ipairs(p.whitelist or {}) do
        local mods = w.modules or {}
        if #mods == 0 or U.contains(mods, moduleKey) or U.contains(mods, moduleKey:match('^([^.]+)') .. '.*') then
            return true, 'whitelist'
        end
    end
    local bypass = Config.Permissions.bypass
    if p.admin and p.admin.level >= bypass.minLevel and U.contains(bypass.modules, moduleKey) then
        return true, 'admin-bypass'
    end
    return false
end

function State.setExempt(p, key, durationMs, now)
    now = now or State.now()
    local untilMs = now + math.max(0, math.min(durationMs or 5000, 3600000))
    if (p.exempt[key] or 0) < untilMs then p.exempt[key] = untilMs end
end

--- Increments a per-player streak counter and returns its value; reset with State.clearStreak.
function State.streak(p, key)
    p.consecutive[key] = (p.consecutive[key] or 0) + 1
    return p.consecutive[key]
end

function State.clearStreak(p, key)
    p.consecutive[key] = nil
end

--- Players iterated in batches so that expensive checks are spread across ticks.
function State.list()
    local out = {}
    for src, p in pairs(State.players) do out[#out + 1] = p end
    table.sort(out, function(a, b) return a.src < b.src end)
    return out
end

return State
