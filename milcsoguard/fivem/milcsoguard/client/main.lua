-- Client side of MilcsoGuard. Everything here is UNTRUSTED by design: it only answers the server's
-- heartbeat challenge and reports a few local signals. The server never bans on these alone.
local cfg = nil
local readySent = false
local lastSpectateReport = 0

local function notify(msg)
    BeginTextCommandThefeedPost('STRING')
    AddTextComponentSubstringPlayerName(msg)
    EndTextCommandThefeedPostTicker(false, true)
end
MG_notify = notify

local function sendReady()
    readySent = true
    TriggerServerEvent('milcsoguard:ready')
end

CreateThread(function()
    while not NetworkIsPlayerActive(PlayerId()) do Wait(500) end
    Wait(2000)
    sendReady()
end)

RegisterNetEvent('milcsoguard:resync', function()
    sendReady()
end)

RegisterNetEvent('milcsoguard:clientConfig', function(c)
    if type(c) ~= 'table' then return end
    local first = cfg == nil
    cfg = c
    if first and type(c.command) == 'string' and c.command ~= '' then
        if type(c.keybind) == 'string' and c.keybind ~= '' then
            RegisterKeyMapping(c.command, (c.brand or 'Anticheat') .. ' admin panel', 'keyboard', c.keybind)
        end
        TriggerEvent('chat:addSuggestion', '/' .. c.command, (c.brand or 'Anticheat') .. ' admin panel')
    end
end)

RegisterNetEvent('milcsoguard:hb', function(nonce)
    if type(nonce) == 'string' then TriggerServerEvent('milcsoguard:hb', nonce) end
end)

RegisterNetEvent('milcsoguard:notice', function(msg)
    if type(msg) == 'string' then notify(msg) end
end)

local reported = {}
local function reportResource(action, name)
    if not cfg or not cfg.resourceReports or name == GetCurrentResourceName() then return end
    local key = action .. name
    if reported[key] then return end
    reported[key] = true
    TriggerServerEvent('milcsoguard:clientResource', action, name)
end

AddEventHandler('onClientResourceStart', function(name)
    if readySent then reportResource('start', name) end
end)

AddEventHandler('onClientResourceStop', function(name)
    if readySent then reportResource('stop', name) end
end)

CreateThread(function()
    while true do
        Wait(5000)
        if cfg and cfg.spectateCheck and NetworkIsInSpectatorMode() then
            local now = GetGameTimer()
            if now - lastSpectateReport > 60000 then
                lastSpectateReport = now
                TriggerServerEvent('milcsoguard:signal', 'spectate')
            end
        end
    end
end)
