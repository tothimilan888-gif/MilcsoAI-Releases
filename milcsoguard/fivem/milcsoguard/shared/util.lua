-- Pure helpers shared by server and client. No natives here except where guarded.
MG = MG or {}
MG.Util = MG.Util or {}
local U = MG.Util

MG.SEVERITIES = { 'INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL' }
MG.SEVERITY_RANK = { INFO = 1, LOW = 2, MEDIUM = 3, HIGH = 4, CRITICAL = 5 }
MG.ACTIONS = { 'log', 'warn', 'monitor', 'kick', 'ban' }
MG.ACTION_RANK = { log = 1, warn = 2, monitor = 3, kick = 4, ban = 5 }
MG.SOURCES = { server = true, client = true, event = true, resource = true, system = true }

--- Normalises a (possibly negative, signed 32-bit) hash to its unsigned value.
function U.u32(h)
    h = tonumber(h) or 0
    h = math.floor(h)
    return h % 4294967296
end

--- Jenkins one-at-a-time hash (GTA joaat), lower-cased. Matches GetHashKey for ASCII input.
function U.joaat(s)
    s = string.lower(tostring(s))
    local h = 0
    for i = 1, #s do
        h = (h + string.byte(s, i)) % 4294967296
        h = (h + (h << 10)) % 4294967296
        h = h ~ (h >> 6)
    end
    h = (h + (h << 3)) % 4294967296
    h = h ~ (h >> 11)
    h = (h + (h << 15)) % 4294967296
    return h
end

--- Accepts a model/weapon name or a numeric hash and returns the unsigned hash.
function U.toHash(v)
    if type(v) == 'number' then return U.u32(v) end
    local n = tonumber(v)
    if n then return U.u32(n) end
    return U.joaat(v)
end

--- Marks a table so FiveM's dkjson encodes it as {} even when empty (default is []).
function U.obj(t)
    return setmetatable(t or {}, { __jsontype = 'object' })
end

function U.clamp(v, lo, hi)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

function U.round(v, decimals)
    local m = 10 ^ (decimals or 0)
    return math.floor(v * m + 0.5) / m
end

function U.deepCopy(t)
    if type(t) ~= 'table' then return t end
    local out = {}
    for k, v in pairs(t) do out[k] = U.deepCopy(v) end
    return out
end

--- Recursively merges src into a copy of dst. Arrays (lists) in src replace those in dst.
function U.deepMerge(dst, src)
    local out = U.deepCopy(dst or {})
    if type(src) ~= 'table' then return out end
    for k, v in pairs(src) do
        if type(v) == 'table' and type(out[k]) == 'table' and not U.isList(v) and not U.isList(out[k]) then
            out[k] = U.deepMerge(out[k], v)
        else
            out[k] = U.deepCopy(v)
        end
    end
    return out
end

function U.isList(t)
    if type(t) ~= 'table' then return false end
    local n = 0
    for _ in pairs(t) do n = n + 1 end
    if n == 0 then return true end
    for i = 1, n do
        if t[i] == nil then return false end
    end
    return true
end

function U.count(t)
    local n = 0
    for _ in pairs(t or {}) do n = n + 1 end
    return n
end

function U.contains(list, value)
    for _, v in ipairs(list or {}) do
        if v == value then return true end
    end
    return false
end

function U.toSet(list, transform)
    local s = {}
    for _, v in ipairs(list or {}) do
        s[transform and transform(v) or v] = true
    end
    return s
end

function U.trim(s)
    return (tostring(s or ''):gsub('^%s+', ''):gsub('%s+$', ''))
end

function U.startsWith(s, prefix)
    return type(s) == 'string' and s:sub(1, #prefix) == prefix
end

--- Sanitises player-controlled text (names) for logs and UI: strips control chars and colour codes.
function U.sanitize(s, maxLen)
    s = tostring(s or '')
    s = s:gsub('%^%d', ''):gsub('[%c]', '')
    if #s > (maxLen or 64) then s = s:sub(1, maxLen or 64) end
    return s
end

local hex = '0123456789abcdef'
local seeded = false
--- Random v4-style id. Not cryptographic; only used for idempotency keys.
function U.uuid()
    if not seeded then
        -- Lua 5.4: randomseed() without arguments seeds from time and address-space randomness,
        -- so restarts with identical clocks still produce different ids.
        math.randomseed()
        seeded = true
    end
    local out = {}
    for i = 1, 32 do
        local r = math.random(1, 16)
        out[i] = hex:sub(r, r)
    end
    out[13] = '4'
    -- RFC 4122 variant bits (8, 9, a or b); strict UUID validators reject anything else.
    local v = math.random(1, 4)
    out[17] = ('89ab'):sub(v, v)
    local s = table.concat(out)
    return s:sub(1, 8) .. '-' .. s:sub(9, 12) .. '-' .. s:sub(13, 16) .. '-' .. s:sub(17, 20) .. '-' .. s:sub(21, 32)
end

--- Parses "type:value" identifiers into a map type -> value (first wins) and a cleaned list.
function U.parseIdentifiers(list)
    local map, clean = {}, {}
    for _, raw in ipairs(list or {}) do
        if type(raw) == 'string' then
            local t, v = raw:match('^([%w]+):(.+)$')
            if t and v then
                t = t:lower()
                v = v:lower()
                if not map[t] then map[t] = v end
                clean[#clean + 1] = t .. ':' .. v
            end
        end
    end
    return map, clean
end

--- Removes identifier types that must never leave the server unless configured (e.g. ip).
function U.filterIdentifiers(list, excluded)
    local out = {}
    for _, i in ipairs(list or {}) do
        local t = i:match('^([%w]+):')
        if t and not (excluded and excluded[t]) then out[#out + 1] = i end
    end
    return out
end

function U.isoTime(epoch)
    return os.date('!%Y-%m-%dT%H:%M:%SZ', epoch or os.time())
end

--- Parses an ISO-8601 UTC timestamp ("2026-01-02T03:04:05.000Z") into epoch seconds.
function U.parseIso(s)
    if type(s) ~= 'string' then return nil end
    local y, mo, d, h, mi, se = s:match('^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)')
    if not y then return nil end
    -- days from civil (Howard Hinnant), avoids os.time's local-time interpretation
    y, mo, d = tonumber(y), tonumber(mo), tonumber(d)
    y = mo <= 2 and y - 1 or y
    local era = (y >= 0 and y or y - 399) // 400
    local yoe = y - era * 400
    local mp = (mo + 9) % 12
    local doy = (153 * mp + 2) // 5 + d - 1
    local doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    local days = era * 146097 + doe - 719468
    return days * 86400 + tonumber(h) * 3600 + tonumber(mi) * 60 + tonumber(se)
end

function U.formatDuration(seconds)
    if not seconds then return 'végleges' end
    seconds = math.max(0, math.floor(seconds))
    local d = seconds // 86400
    local h = (seconds % 86400) // 3600
    local m = (seconds % 3600) // 60
    if d > 0 then return ('%d nap %d óra'):format(d, h) end
    if h > 0 then return ('%d óra %d perc'):format(h, m) end
    return ('%d perc'):format(math.max(1, m))
end

function U.dist3(a, b)
    local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end

function U.dist2(a, b)
    local dx, dy = a.x - b.x, a.y - b.y
    return math.sqrt(dx * dx + dy * dy)
end

function U.len3(v)
    return math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
end

return U
