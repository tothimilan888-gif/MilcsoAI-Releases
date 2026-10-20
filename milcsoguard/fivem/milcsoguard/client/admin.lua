-- NUI bridge for the admin panel. The panel is opened only on the server's instruction (after the
-- server checked the permission) and every action is a request the server checks again.
local open = false
local notifyMinRank = 3
local RANK = { INFO = 1, LOW = 2, MEDIUM = 3, HIGH = 4, CRITICAL = 5 }

RegisterNetEvent('milcsoguard:admin:open', function(info)
    open = true
    notifyMinRank = RANK[info and info.notifyMin] or 3
    SetNuiFocus(true, true)
    SendNUIMessage({ type = 'open', info = info })
end)

RegisterNUICallback('close', function(_, cb)
    open = false
    SetNuiFocus(false, false)
    TriggerServerEvent('milcsoguard:admin:closed')
    cb({})
end)

RegisterNUICallback('request', function(data, cb)
    cb({})
    if type(data) ~= 'table' or type(data.reqId) ~= 'number' or type(data.action) ~= 'string' then return end
    TriggerServerEvent('milcsoguard:admin:request', data.reqId, data.action, type(data.payload) == 'table' and data.payload or {})
end)

RegisterNetEvent('milcsoguard:admin:response', function(reqId, result)
    SendNUIMessage({ type = 'response', reqId = reqId, result = result })
end)

RegisterNetEvent('milcsoguard:admin:detection', function(d)
    if open then
        SendNUIMessage({ type = 'detection', detection = d })
    elseif RANK[d.severity] and RANK[d.severity] >= notifyMinRank and MG_notify then
        MG_notify(('~r~[AC]~s~ %s: %s (#%s) → %s'):format(d.severity, d.type, tostring(d.netId), d.action))
    end
end)

RegisterNetEvent('milcsoguard:admin:system', function(e)
    if open then
        SendNUIMessage({ type = 'system', event = e })
    elseif MG_notify then
        MG_notify('~o~[AC]~s~ ' .. tostring(e.message))
    end
end)

AddEventHandler('onResourceStop', function(name)
    if name == GetCurrentResourceName() and open then SetNuiFocus(false, false) end
end)

-- ------------------------------------------------------------------ replay playback relay
RegisterNetEvent('milcsoguard:admin:replayPart', function(part)
    if type(part) == 'table' then SendNUIMessage({ type = 'replayPart', part = part }) end
end)

-- ------------------------------------------------------------------ spectate (admin tool)
-- The server checked players.moderate, moved us into the target's routing bucket and exempted us
-- from the movement/visibility checks. Our own ped is hidden and parked under the target so that
-- the target stays in scope; the camera follows the target's ped.
local spec = nil
local STOP_CONTROL = 177 -- INPUT_CELLPHONE_CANCEL (Backspace / Esc / right mouse)

local function attach(targetSrc)
    local deadline = GetGameTimer() + 5000
    while spec and spec.target == targetSrc and GetGameTimer() < deadline do
        local pl = GetPlayerFromServerId(targetSrc)
        local tp = pl ~= -1 and GetPlayerPed(pl) or 0
        if tp ~= 0 and DoesEntityExist(tp) then
            NetworkSetInSpectatorMode(true, tp)
            spec.attached = true
            return
        end
        Wait(100)
    end
end

RegisterNetEvent('milcsoguard:admin:spectate', function(d)
    if type(d) ~= 'table' then return end
    local ped = PlayerPedId()
    if d.stop then
        spec = nil
        NetworkSetInSpectatorMode(false, ped)
        SetEntityCoords(ped, d.x + 0.0, d.y + 0.0, d.z + 0.0, false, false, false, false)
        FreezeEntityPosition(ped, false)
        SetEntityCollision(ped, true, true)
        SetEntityVisible(ped, true, false)
        SetEntityInvincible(ped, false)
        SendNUIMessage({ type = 'spectate', active = false })
        return
    end
    if d.update and (not spec or spec.target ~= d.target) then return end
    if not spec or spec.target ~= d.target then
        if not spec then
            SetEntityVisible(ped, false, false)
            SetEntityCollision(ped, false, false)
            FreezeEntityPosition(ped, true)
            SetEntityInvincible(ped, true)
        end
        spec = { target = d.target, name = d.name, attached = false }
        SendNUIMessage({ type = 'spectate', active = true, target = d.target, name = d.name })
    end
    SetEntityCoords(ped, d.x + 0.0, d.y + 0.0, d.z - 10.0, false, false, false, false)
    if not spec.attached then CreateThread(function() attach(d.target) end) end
end)

CreateThread(function()
    while true do
        if spec then
            BeginTextCommandDisplayHelp('STRING')
            AddTextComponentSubstringPlayerName(('Spectate: %s – ~INPUT_CELLPHONE_CANCEL~ kilépés'):format(spec.name or '?'))
            EndTextCommandDisplayHelp(0, false, false, -1)
            if IsControlJustPressed(0, STOP_CONTROL) and not open then
                TriggerServerEvent('milcsoguard:admin:request', -1, 'player.spectate.stop', {})
            end
            Wait(0)
        else
            Wait(500)
        end
    end
end)
