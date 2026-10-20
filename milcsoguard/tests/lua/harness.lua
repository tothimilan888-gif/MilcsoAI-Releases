-- Usage: lua5.4 harness.lua <test file>   (run all with ./run.sh)
TEST_DIR = arg[0]:match('^(.*)/[^/]*$') or '.'
RES_DIR = TEST_DIR .. '/../../fivem/milcsoguard'

local Mock = dofile(TEST_DIR .. '/fivem_mock.lua')

local results = { passed = 0, failed = 0, failures = {} }
local current = ''

function describe(name, fn)
    local prev = current
    current = (prev ~= '' and (prev .. ' > ') or '') .. name
    fn()
    current = prev
end

function it(name, fn)
    local ok, err = xpcall(fn, debug.traceback)
    if ok then
        results.passed = results.passed + 1
        io.write('  \27[32m✓\27[0m ', current, ' > ', name, '\n')
    else
        results.failed = results.failed + 1
        results.failures[#results.failures + 1] = current .. ' > ' .. name .. '\n    ' .. tostring(err)
        io.write('  \27[31m✗\27[0m ', current, ' > ', name, '\n')
    end
end

local function fmt(v)
    if type(v) == 'table' then
        local ok, s = pcall(json.encode, v)
        return ok and s or tostring(v)
    end
    return tostring(v)
end

local function deepEq(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= 'table' then return a == b end
    for k, v in pairs(a) do if not deepEq(v, b[k]) then return false end end
    for k in pairs(b) do if a[k] == nil then return false end end
    return true
end

function expect(actual)
    local e = {}
    function e.toBe(expected) if actual ~= expected then error(('expected %s to be %s'):format(fmt(actual), fmt(expected)), 2) end end
    function e.toEqual(expected) if not deepEq(actual, expected) then error(('expected %s to equal %s'):format(fmt(actual), fmt(expected)), 2) end end
    function e.toBeTruthy() if not actual then error(('expected %s to be truthy'):format(fmt(actual)), 2) end end
    function e.toBeFalsy() if actual then error(('expected %s to be falsy'):format(fmt(actual)), 2) end end
    function e.toBeNil() if actual ~= nil then error(('expected %s to be nil'):format(fmt(actual)), 2) end end
    function e.toBeGreaterThan(n) if not (actual > n) then error(('expected %s > %s'):format(fmt(actual), fmt(n)), 2) end end
    function e.toBeLessThan(n) if not (actual < n) then error(('expected %s < %s'):format(fmt(actual), fmt(n)), 2) end end
    function e.toContain(s)
        if type(actual) == 'string' then
            if not actual:find(s, 1, true) then error(('expected "%s" to contain "%s"'):format(actual, s), 2) end
        else
            for _, v in ipairs(actual) do if deepEq(v, s) then return end end
            error(('expected %s to contain %s'):format(fmt(actual), fmt(s)), 2)
        end
    end
    function e.toHaveLength(n) if #actual ~= n then error(('expected length %d, got %d: %s'):format(n, #actual, fmt(actual)), 2) end end
    return e
end

--- Loads the resource's server scripts in fxmanifest order.
function loadResource(opts)
    opts = opts or {}
    local manifest = {}
    local env = {
        fx_version = function() end, game = function() end, lua54 = function() end, name = function() end,
        author = function() end, description = function() end, version = function() end, repository = function() end,
        ui_page = function() end, files = function() end, dependencies = function() end,
        shared_scripts = function(t) manifest.shared = t end,
        server_scripts = function(t) manifest.server = t end,
        client_scripts = function(t) manifest.client = t end,
    }
    local chunk = assert(loadfile(RES_DIR .. '/fxmanifest.lua', 't', env))
    chunk()
    for _, f in ipairs(manifest.shared) do dofile(RES_DIR .. '/' .. f) end
    for _, f in ipairs(manifest.server) do
        dofile(RES_DIR .. '/' .. f)
        if f == 'config/config.lua' and opts.config then opts.config(Config) end
    end
    Mock.settle()
end

local testFile = arg[1]
io.write('\27[1m', testFile, '\27[0m\n')
dofile(testFile)

for _, f in ipairs(results.failures) do io.write('\27[31mFAIL\27[0m ', f, '\n') end
io.write(('%d passed, %d failed\n'):format(results.passed, results.failed))
os.exit(results.failed == 0 and 0 or 1)
