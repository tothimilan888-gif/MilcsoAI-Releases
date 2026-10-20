-- Bridge between the NUI replay recorder and the server. The server decides when a replay is
-- captured; this script only forwards. Large data goes through latent events (bandwidth limited,
-- so the upload cannot stall the player's connection).
local cfg = nil

local function sendConfig()
    if cfg then SendNUIMessage({ type = 'replay:config', config = cfg }) end
end

RegisterNetEvent('milcsoguard:clientConfig', function(c)
    if type(c) ~= 'table' or type(c.replay) ~= 'table' then return end
    local first = cfg == nil
    cfg = c.replay
    if first then sendConfig() end
end)

RegisterNUICallback('replayHello', function(_, cb)
    cb({})
    sendConfig()
end)

RegisterNUICallback('replayStatus', function(data, cb)
    cb({})
    if type(data) == 'table' and type(data.state) == 'string' then
        TriggerServerEvent('milcsoguard:replay:status', data.state, type(data.detail) == 'string' and data.detail or '')
    end
end)

RegisterNetEvent('milcsoguard:replay:capture', function(id)
    if type(id) == 'string' then SendNUIMessage({ type = 'replay:capture', id = id }) end
end)

RegisterNUICallback('replayChunk', function(data, cb)
    cb({})
    if not cfg or type(data) ~= 'table' or type(data.data) ~= 'string' then return end
    TriggerLatentServerEvent('milcsoguard:replay:chunk', cfg.uploadBps, data.id, data.part, data.seq, data.data)
end)

RegisterNUICallback('replayDone', function(data, cb)
    cb({})
    if type(data) ~= 'table' then return end
    TriggerLatentServerEvent('milcsoguard:replay:done', cfg and cfg.uploadBps or 200000, data.id, data.manifest)
end)
