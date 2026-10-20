-- Validates the static configuration at start. Problems are reported in detail; where a value is
-- unusable we fall back to a SAFE behaviour (feature disabled), never to a more permissive one.
MG = MG or {}
local U = MG.Util
local Check = {}
MG.ConfigCheck = Check

local FRAMEWORKS = { auto = true, esx = true, qbcore = true, standalone = true }
local PERM_SOURCES = { ace = true, framework = true, backend = true }

--- Returns errors (fatal for the affected feature) and warnings.
function Check.run(cfg)
    local errors, warnings = {}, {}
    local function err(path, msg) errors[#errors + 1] = path .. ': ' .. msg end
    local function warn(path, msg) warnings[#warnings + 1] = path .. ': ' .. msg end

    if not FRAMEWORKS[cfg.Framework] then
        err('Config.Framework', ("'%s' is not one of auto/esx/qbcore/standalone -> using standalone"):format(tostring(cfg.Framework)))
        cfg.Framework = 'standalone'
    end

    local api = cfg.Api or {}
    if api.enabled then
        local url = U.trim(api.url)
        if url == '' then
            warn('Config.Api.url', 'convar milcsoguard_api_url is empty -> running in local-only mode')
            api.enabled = false
        elseif not url:match('^https://') then
            local isLocal = url:match('^http://127%.0%.0%.1[:/]') or url:match('^http://localhost[:/]') or url == 'http://localhost' or url == 'http://127.0.0.1'
            if not (isLocal and api.allowInsecureLocalhost) then
                err('Config.Api.url', 'must use https:// (plain http only allowed for localhost) -> API disabled')
                api.enabled = false
            end
        end
        api.url = url:gsub('/+$', '')
        for _, k in ipairs({ 'timeoutMs', 'heartbeatSeconds', 'commandPollSeconds', 'banSyncSeconds', 'configSyncSeconds', 'flushSeconds', 'maxQueue' }) do
            if type(api[k]) ~= 'number' or api[k] <= 0 then
                err('Config.Api.' .. k, 'must be a positive number -> API disabled')
                api.enabled = false
            end
        end
        if api.commandPollSeconds and api.commandPollSeconds < 2 then
            warn('Config.Api.commandPollSeconds', 'below 2s is unnecessary load; using 2')
            api.commandPollSeconds = 2
        end
    end

    local perms = cfg.Permissions or {}
    local validSources = {}
    for _, s in ipairs(perms.sources or {}) do
        if PERM_SOURCES[s] then validSources[#validSources + 1] = s else err('Config.Permissions.sources', ("unknown source '%s' ignored"):format(tostring(s))) end
    end
    perms.sources = validSources
    if #validSources == 0 then warn('Config.Permissions.sources', 'no permission source -> nobody can open the admin panel') end
    for fw, map in pairs(perms.framework or {}) do
        for group, role in pairs(map) do
            if not cfg.Roles[role] then
                err(('Config.Permissions.framework.%s.%s'):format(fw, group), ("role '%s' does not exist -> mapping removed"):format(tostring(role)))
                map[group] = nil
            end
        end
    end
    for key, role in pairs(cfg.Roles or {}) do
        if type(role.level) ~= 'number' or role.level < 1 or role.level > 100 then err('Config.Roles.' .. key, 'level must be 1..100') end
    end

    for i, z in ipairs(cfg.TeleportZones or {}) do
        if type(z.x) ~= 'number' or type(z.y) ~= 'number' or type(z.z) ~= 'number' or type(z.radius) ~= 'number' or z.radius <= 0 or z.radius > 500 then
            err(('Config.TeleportZones[%d]'):format(i), 'needs numeric x, y, z and 0 < radius <= 500 -> zone ignored')
            z.invalid = true
        end
    end

    local perf = cfg.Performance or {}
    if (perf.movementIntervalMs or 0) < 250 then warn('Config.Performance.movementIntervalMs', 'below 250ms is too frequent; using 250'); perf.movementIntervalMs = 250 end
    if (perf.batchSize or 0) < 1 then perf.batchSize = 24 end

    if not MG.SEVERITY_RANK[cfg.Detections.notifyAdminsMinSeverity] then
        err('Config.Detections.notifyAdminsMinSeverity', 'invalid severity -> using MEDIUM')
        cfg.Detections.notifyAdminsMinSeverity = 'MEDIUM'
    end

    local rp = cfg.Replay
    if type(rp) == 'table' and rp.enabled then
        local limits = {
            seconds = { 5, 60 }, segmentSeconds = { 2, 15 }, width = { 320, 1920 }, height = { 180, 1080 }, fps = { 5, 30 },
            bitrateKbps = { 150, 4000 }, uploadTimeoutSeconds = { 5, 120 }, uploadBps = { 50000, 5000000 },
            maxBytes = { 1024 * 1024, 24 * 1024 * 1024 }, maxConcurrent = { 1, 16 },
        }
        for k, lim in pairs(limits) do
            local v = tonumber(rp[k])
            if not v then
                err('Config.Replay.' .. k, 'must be a number -> replays disabled')
                rp.enabled = false
            elseif v < lim[1] or v > lim[2] then
                warn('Config.Replay.' .. k, ('outside %d..%d; clamped'):format(lim[1], lim[2]))
                rp[k] = math.max(lim[1], math.min(lim[2], v))
            end
        end
        if rp.enabled and math.ceil(rp.seconds / rp.segmentSeconds) + 1 > 16 then
            warn('Config.Replay.segmentSeconds', 'too many segments for the replay length; raising segmentSeconds')
            rp.segmentSeconds = math.ceil(rp.seconds / 15)
        end
    end
    return errors, warnings
end

return Check
