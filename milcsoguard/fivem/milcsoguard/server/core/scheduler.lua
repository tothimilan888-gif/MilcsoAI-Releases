-- Spreads periodic per-player checks over time: every player is visited once per interval, in
-- batches, so a full server never runs all checks in the same frame.
MG = MG or {}
local Log = MG.Log
local S = { jobs = {} }
MG.Scheduler = S

function S.every(intervalMs, fn)
    S.jobs[#S.jobs + 1] = fn
    Citizen.CreateThread(function()
        while true do
            local players = MG.State.list()
            if #players == 0 then
                Wait(intervalMs)
            else
                local batch = math.max(1, Config.Performance.batchSize)
                local batches = math.ceil(#players / batch)
                local pause = math.max(0, math.floor(intervalMs / batches))
                for b = 1, batches do
                    local now = GetGameTimer()
                    for i = (b - 1) * batch + 1, math.min(#players, b * batch) do
                        local p = players[i]
                        if MG.State.players[p.src] == p then
                            local ok, err = pcall(fn, p, now)
                            if not ok then Log.error('check failed for #%d: %s', p.src, tostring(err)) end
                        end
                    end
                    Wait(pause)
                end
            end
        end
    end)
end

return S
