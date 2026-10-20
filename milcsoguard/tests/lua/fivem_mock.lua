-- Minimal FXServer emulation for unit/integration tests of the MilcsoGuard server scripts.
-- Provides: virtual clock, coroutine scheduler (Wait / CreateThread / SetTimeout / promises),
-- event registry, KVP store, fake HTTP backend, ACE table, players/peds world and recorders.
local Mock = { now = 100000, epoch = 1760000000, threads = {}, timeouts = {}, handlers = {}, kvp = {}, convars = {},
    resources = {}, ace = {}, players = {}, entities = {}, http = nil, httpLog = {}, clientEvents = {}, dropped = {},
    cancelled = false, commands = {}, exportsTable = {}, prints = {} }
_G.MockFX = Mock

dofile(TEST_DIR .. '/vendor/json.lua')

-- --------------------------------------------------------------- printing
local realPrint = print
_G.print = function(...)
    local parts = {}
    for i = 1, select('#', ...) do parts[#parts + 1] = tostring(select(i, ...)) end
    local line = table.concat(parts, ' ')
    Mock.prints[#Mock.prints + 1] = line
    if os.getenv('MG_TEST_VERBOSE') then realPrint(line) end
end

-- --------------------------------------------------------------- time & scheduling
function GetGameTimer() return Mock.now end
local realTime = os.time
os.time = function(t)
    if t then return realTime(t) end
    return Mock.epoch + math.floor((Mock.now - 100000) / 1000)
end

local function spawn(fn, ...)
    local co = coroutine.create(fn)
    local th = { co = co, wake = Mock.now, args = table.pack(...) }
    Mock.threads[#Mock.threads + 1] = th
    Mock.resume(th)
    return th
end

function Mock.resume(th)
    if coroutine.status(th.co) == 'dead' then return end
    local ok, kind, value
    if th.args then
        ok, kind, value = coroutine.resume(th.co, table.unpack(th.args, 1, th.args.n))
        th.args = nil
    else
        ok, kind, value = coroutine.resume(th.co, th.resumeValue)
        th.resumeValue = nil
    end
    if not ok then error('thread error: ' .. tostring(kind) .. '\n' .. debug.traceback(th.co), 0) end
    if kind == 'wait' then th.wake = Mock.now + (value or 0); th.promise = nil
    elseif kind == 'await' then th.promise = value; th.wake = nil end
end

Citizen = {}
function Citizen.CreateThread(fn) spawn(fn) end
CreateThread = Citizen.CreateThread
function Citizen.Wait(ms)
    if not coroutine.isyieldable() then error('Wait outside a thread') end
    coroutine.yield('wait', ms)
end
Wait = Citizen.Wait

function SetTimeout(ms, fn)
    Mock.timeouts[#Mock.timeouts + 1] = { at = Mock.now + ms, fn = fn }
end
Citizen.SetTimeout = SetTimeout

promise = {}
promise.__index = promise
function promise.new() return setmetatable({ resolved = false }, promise) end
function promise:resolve(v) if not self.resolved then self.resolved = true; self.value = v end end
function Citizen.Await(p)
    if p.resolved then return p.value end
    return coroutine.yield('await', p)
end

--- Runs everything that is due, repeatedly, without advancing time.
function Mock.settle()
    for _ = 1, 1000 do
        local progressed = false
        local due = {}
        for i = #Mock.timeouts, 1, -1 do
            if Mock.timeouts[i].at <= Mock.now then
                due[#due + 1] = Mock.timeouts[i]
                table.remove(Mock.timeouts, i)
            end
        end
        table.sort(due, function(a, b) return a.at < b.at end)
        for _, t in ipairs(due) do progressed = true; t.fn() end
        for _, th in ipairs(Mock.threads) do
            if coroutine.status(th.co) ~= 'dead' then
                if th.promise and th.promise.resolved then
                    th.resumeValue = th.promise.value
                    th.promise = nil
                    th.wake = Mock.now
                    Mock.resume(th)
                    progressed = true
                elseif th.wake and th.wake <= Mock.now and not th.promise then
                    th.wake = nil
                    Mock.resume(th)
                    progressed = true
                end
            end
        end
        local alive = {}
        for _, th in ipairs(Mock.threads) do if coroutine.status(th.co) ~= 'dead' then alive[#alive + 1] = th end end
        Mock.threads = alive
        if not progressed then return end
    end
end

--- Advances the clock in steps, running due threads/timeouts.
function Mock.advance(ms, step)
    step = step or 100
    local target = Mock.now + ms
    Mock.settle()
    while Mock.now < target do
        Mock.now = math.min(target, Mock.now + step)
        Mock.settle()
    end
end

-- --------------------------------------------------------------- events
function AddEventHandler(name, fn)
    Mock.handlers[name] = Mock.handlers[name] or {}
    table.insert(Mock.handlers[name], fn)
    return { name = name, fn = fn }
end
function RegisterNetEvent(name, fn) if fn then return AddEventHandler(name, fn) end end
RegisterServerEvent = RegisterNetEvent
function CancelEvent() Mock.cancelled = true end
function WasEventCanceled() return Mock.cancelled end

--- Triggers a server event as if sent by `src`. Returns true when a handler cancelled it.
function Mock.trigger(name, src, ...)
    Mock.cancelled = false
    local args = table.pack(...)
    for _, fn in ipairs(Mock.handlers[name] or {}) do
        local prev = _G.source
        _G.source = src
        spawn(function() fn(table.unpack(args, 1, args.n)) end)
        _G.source = prev
    end
    Mock.settle()
    return Mock.cancelled
end

function TriggerEvent(name, ...) Mock.trigger(name, nil, ...) end
function TriggerClientEvent(name, target, ...)
    Mock.clientEvents[#Mock.clientEvents + 1] = { name = name, target = target, args = table.pack(...) }
end
function Mock.clientEventsNamed(name, target)
    local out = {}
    for _, e in ipairs(Mock.clientEvents) do
        if e.name == name and (target == nil or e.target == target) then out[#out + 1] = e end
    end
    return out
end

function RegisterCommand(name, fn) Mock.commands[name] = fn end
function GetInvokingResource() return Mock.invoking end

exports = setmetatable({}, {
    __call = function(_, name, fn) Mock.exportsTable[name] = fn end,
    __index = function(_, res)
        return setmetatable({}, { __index = function(_, fnName)
            return function(_, ...)
                local f = Mock.foreignExports[res] and Mock.foreignExports[res][fnName]
                if not f then error(('export %s:%s not mocked'):format(res, fnName)) end
                return f(...)
            end
        end })
    end,
})
Mock.foreignExports = {}

-- --------------------------------------------------------------- convars / resources
function GetConvar(k, d) local v = Mock.convars[k]; if v == nil then return d end; return v end
function GetCurrentResourceName() return 'milcsoguard' end
function GetResourceState(name)
    if name == 'milcsoguard' then return 'started' end
    return Mock.resources[name] or 'missing'
end
function GetResourceMetadata(res, key) if res == 'milcsoguard' and key == 'version' then return '1.0.0' end; return '1.0' end
function LoadResourceFile(_, path) return Mock.files and Mock.files[path] or '-- config' end

-- --------------------------------------------------------------- KVP
function SetResourceKvp(k, v) Mock.kvp[k] = v end
SetResourceKvpNoSync = SetResourceKvp
function GetResourceKvpString(k) return Mock.kvp[k] end
function DeleteResourceKvp(k) Mock.kvp[k] = nil end
local finds = {}
function StartFindKvp(prefix)
    local keys = {}
    for k in pairs(Mock.kvp) do if k:sub(1, #prefix) == prefix then keys[#keys + 1] = k end end
    table.sort(keys)
    finds[#finds + 1] = { keys = keys, i = 0 }
    return #finds
end
function FindKvp(h) local f = finds[h]; f.i = f.i + 1; return f.keys[f.i] end
function EndFindKvp(h) finds[h] = nil end

-- --------------------------------------------------------------- HTTP (fake backend)
--- Mock.http = function(method, path, body) return status, responseTable end
function PerformHttpRequest(url, cb, method, data, headers)
    local path = url:gsub('^https?://[^/]+', '')
    local body = (data and data ~= '') and json.decode(data) or nil
    Mock.httpLog[#Mock.httpLog + 1] = { method = method, path = path, body = body, headers = headers }
    if not Mock.http then return end -- never answers (timeout)
    local status, resp = Mock.http(method, path, body, headers)
    if status == nil then return end
    SetTimeout(5, function() cb(status, resp ~= nil and json.encode(resp) or '', {}) end)
end
function Mock.requests(pathPattern)
    local out = {}
    for _, r in ipairs(Mock.httpLog) do if r.path:match(pathPattern) then out[#out + 1] = r end end
    return out
end

-- --------------------------------------------------------------- players & world
function Mock.vec(x, y, z)
    return setmetatable({ x = x, y = y, z = z }, { __sub = function(a, b) return Mock.vec(a.x - b.x, a.y - b.y, a.z - b.z) end, __len = function(v) return math.sqrt(v.x ^ 2 + v.y ^ 2 + v.z ^ 2) end })
end

--- Adds a connected player with a ped. opts: identifiers, name, pos
function Mock.addPlayer(src, opts)
    opts = opts or {}
    local ped = 1000 + src
    Mock.players[src] = {
        name = opts.name or ('Player' .. src),
        identifiers = opts.identifiers or { 'license:' .. string.rep(string.format('%x', src % 16), 40), 'discord:1000000000000000' .. src, 'ip:10.0.0.' .. src },
        tokens = opts.tokens or {}, ped = ped, ping = 30, bucket = 0, invincible = false, superJump = false,
        weaponMod = 1.0, meleeMod = 1.0, maxArmour = 100,
    }
    Mock.entities[ped] = { type = 1, pos = opts.pos or Mock.vec(0, 0, 70), vel = Mock.vec(0, 0, 0), health = 200, maxHealth = 200, armour = 0,
        visible = true, vehicle = 0, attached = 0, collisionDisabled = false, weapon = 2725352035, owner = src, isPlayer = true, model = 1885233650, netId = ped }
    return Mock.players[src]
end
function Mock.removePlayer(src)
    local p = Mock.players[src]
    if p then Mock.entities[p.ped] = nil end
    Mock.players[src] = nil
end
function Mock.ped(src) return Mock.entities[Mock.players[src].ped] end

local function P(src) return Mock.players[tonumber(src)] end
local function E(h) return Mock.entities[h] end

function GetPlayers() local out = {}; for s in pairs(Mock.players) do out[#out + 1] = tostring(s) end; table.sort(out); return out end
function GetPlayerName(src) local p = P(src); return p and p.name end
function GetNumPlayerIdentifiers(src) local p = P(src); return p and #p.identifiers or 0 end
function GetPlayerIdentifier(src, i) local p = P(src); return p and p.identifiers[i + 1] end
function GetNumPlayerTokens(src) local p = P(src); return p and #p.tokens or 0 end
function GetPlayerToken(src, i) local p = P(src); return p and p.tokens[i + 1] end
function GetPlayerPing(src) local p = P(src); return p and p.ping or 0 end
function GetPlayerPed(src) local p = P(src); return p and p.ped or 0 end
function GetPlayerRoutingBucket(src) local p = P(src); return p and p.bucket or 0 end
function GetPlayerInvincible(src) local p = P(src); return p and p.invincible or false end
function IsPlayerUsingSuperJump(src) local p = P(src); return p and p.superJump or false end
function GetPlayerWeaponDamageModifier(src) local p = P(src); return p and p.weaponMod or 1.0 end
function GetPlayerMeleeWeaponDamageModifier(src) local p = P(src); return p and p.meleeMod or 1.0 end
function GetPlayerMaxArmour(src) local p = P(src); return p and p.maxArmour or 100 end
function IsPlayerAceAllowed(src, ace) return Mock.ace[tostring(src) .. '|' .. ace] == true end
function DropPlayer(src, reason)
    Mock.dropped[#Mock.dropped + 1] = { src = tonumber(src), reason = reason }
end

function DoesEntityExist(h) return E(h) ~= nil end
function GetEntityCoords(h) local e = E(h); return e and e.pos or Mock.vec(0, 0, 0) end
function GetEntityVelocity(h) local e = E(h); return e and e.vel or Mock.vec(0, 0, 0) end
function GetEntitySpeed(h) local e = E(h); return e and #e.vel or 0 end
function GetEntityHealth(h) local e = E(h); return e and e.health or 0 end
function GetEntityMaxHealth(h) local e = E(h); return e and e.maxHealth or 0 end
function GetPedArmour(h) local e = E(h); return e and e.armour or 0 end
function IsEntityVisible(h) local e = E(h); return e and e.visible end
function GetVehiclePedIsIn(h) local e = E(h); return e and e.vehicle or 0 end
function GetEntityAttachedTo(h) local e = E(h); return e and e.attached or 0 end
function GetEntityCollisionDisabled(h) local e = E(h); return e and e.collisionDisabled or false end
function GetSelectedPedWeapon(h) local e = E(h); return e and e.weapon or 0 end
function GetVehicleType(h) local e = E(h); return e and e.vehType end
function GetPedInVehicleSeat(veh, seat) local e = E(veh); return e and e.driver or 0 end
function GetEntityModel(h) local e = E(h); return e and e.model or 0 end
function GetEntityType(h) local e = E(h); return e and e.type or 0 end
function GetEntityPopulationType(h) local e = E(h); return e and e.pop or 0 end
function GetEntityScript(h) local e = E(h); return e and e.script end
function NetworkGetEntityOwner(h) local e = E(h); return e and e.owner end
function NetworkGetEntityFromNetworkId(id) for h, e in pairs(Mock.entities) do if e.netId == id then return h end end; return 0 end
function IsPedAPlayer(h) local e = E(h); return e and e.isPlayer or false end
function RemoveWeaponFromPed(h, w) local e = E(h); if e and e.weapon == w then e.weapon = 2725352035 end; Mock.removedWeapons = (Mock.removedWeapons or 0) + 1 end

return Mock
