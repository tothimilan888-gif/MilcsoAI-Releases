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
