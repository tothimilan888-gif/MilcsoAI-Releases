MG = MG or {}
local Log = {}
MG.Log = Log

local COLORS = { debug = '^5', info = '^2', warn = '^3', error = '^1' }

local function emit(level, fmt, ...)
    if level == 'debug' and not (Config and Config.Debug) then return end
    local ok, msg = pcall(string.format, fmt, ...)
    if not ok then msg = tostring(fmt) end
    print(('%s[MilcsoGuard:%s]^7 %s'):format(COLORS[level] or '', level, msg))
end

function Log.debug(fmt, ...) emit('debug', fmt, ...) end
function Log.info(fmt, ...) emit('info', fmt, ...) end
function Log.warn(fmt, ...) emit('warn', fmt, ...) end
function Log.error(fmt, ...) emit('error', fmt, ...) end

return Log
