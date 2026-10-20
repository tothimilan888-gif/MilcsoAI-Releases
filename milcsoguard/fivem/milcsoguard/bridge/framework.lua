-- Framework bridge: ESX / QBCore / standalone, plus optional ox_inventory, ox_lib, oxmysql.
-- Every integration is optional and detected at runtime with GetResourceState. Only exports and
-- events verified in the framework sources are used (see docs/ARCHITECTURE.md, chapter 6).
MG = MG or {}
local U = MG.Util
local Log = MG.Log
local B = { name = 'standalone', inventory = nil, deps = {} }
MG.Bridge = B

local function started(res)
    return GetResourceState(res) == 'started'
end

local function version(res)
    local v = GetResourceMetadata(res, 'version', 0)
    return v or '?'
end

local OPTIONAL = { 'es_extended', 'qb-core', 'ox_inventory', 'ox_lib', 'oxmysql', 'screenshot-basic' }

function B.init()
    for _, res in ipairs(OPTIONAL) do
        local state = GetResourceState(res)
        if state ~= 'missing' then B.deps[res] = (state == 'started' and version(res) or state) end
    end

    local wanted = Config.Framework
    if wanted == 'auto' then
        if started('es_extended') then wanted = 'esx'
        elseif started('qb-core') then wanted = 'qbcore'
        else wanted = 'standalone' end
    end

    if wanted == 'esx' then
        if not started('es_extended') then
            Log.error("Config.Framework = 'esx' but es_extended is not started (ensure it starts BEFORE milcsoguard). Falling back to standalone.")
            wanted = 'standalone'
        else
            local ok, obj = pcall(function() return exports['es_extended']:getSharedObject() end)
            if ok and obj then B.ESX = obj else
                Log.error('es_extended:getSharedObject() failed: %s. Falling back to standalone.', tostring(obj))
                wanted = 'standalone'
            end
        end
    elseif wanted == 'qbcore' then
        if not started('qb-core') then
            Log.error("Config.Framework = 'qbcore' but qb-core is not started (ensure it starts BEFORE milcsoguard). Falling back to standalone.")
            wanted = 'standalone'
        else
            local ok, obj = pcall(function() return exports['qb-core']:GetCoreObject() end)
            if ok and obj then B.QB = obj else
                Log.error('qb-core:GetCoreObject() failed: %s. Falling back to standalone.', tostring(obj))
                wanted = 'standalone'
            end
        end
    end
    B.name = wanted
    if started('ox_inventory') then B.inventory = 'ox' end
    Log.info('framework: %s, inventory: %s', B.name, B.inventory or (B.name ~= 'standalone' and B.name or 'none'))
end

--- Framework group check for the 'framework' permission source.
function B.hasGroup(src, group)
    if B.name == 'esx' and B.ESX then
        local x = B.ESX.GetPlayerFromId(src)
        return x ~= nil and x.getGroup() == group
    elseif B.name == 'qbcore' then
        -- QBCore permissions are ACE based (QBCore.Functions.HasPermission -> IsPlayerAceAllowed)
        return IsPlayerAceAllowed(src, group)
    end
    return false
end

--- Does the player own this weapon according to the inventory system?
--- Returns true/false, or nil when it cannot be determined (standalone, unknown weapon, player not loaded).
function B.ownsWeapon(src, weaponHash)
    local name = MG.Weapons.name(weaponHash)
    if not name then return nil end
    if B.inventory == 'ox' then
        local ok, count = pcall(function() return exports.ox_inventory:GetItemCount(src, name) end)
        if not ok then return nil end
        return (tonumber(count) or 0) > 0
    elseif B.name == 'esx' and B.ESX then
        local x = B.ESX.GetPlayerFromId(src)
        if not x then return nil end
        return x.hasWeapon(name) == true
    elseif B.name == 'qbcore' and B.QB then
        if not B.QB.Functions.GetPlayer(src) then return nil end
        local ok, has = pcall(B.QB.Functions.HasItem, src, name:lower(), 1)
        if not ok then return nil end
        return has == true
    end
    return nil
end

function B.canCheckInventory()
    return B.inventory == 'ox' or B.name == 'esx' or B.name == 'qbcore'
end

--- Registers economy hooks. cb(src, kind, amount, info)
function B.onEconomy(cb)
    if B.name == 'esx' then
        -- es_extended: TriggerEvent('esx:addAccountMoney', source, accountName, money, reason)
        AddEventHandler('esx:addAccountMoney', function(src, account, money, reason)
            cb(tonumber(src), 'money', tonumber(money) or 0, { account = account, reason = reason })
        end)
    elseif B.name == 'qbcore' then
        -- qb-core: TriggerEvent('QBCore:Server:OnMoneyChange', source, moneytype, amount, 'add'|'remove', reason)
        AddEventHandler('QBCore:Server:OnMoneyChange', function(src, moneytype, amount, op, reason)
            if op == 'add' then cb(tonumber(src), 'money', tonumber(amount) or 0, { account = moneytype, reason = reason }) end
        end)
    end
    if B.inventory == 'ox' then
        local ok, err = pcall(function()
            exports.ox_inventory:registerHook('createItem', function(payload)
                local inv = payload.inventoryId
                local src = type(inv) == 'number' and inv or nil
                if src then
                    cb(src, 'item', tonumber(payload.count) or 0, {
                        item = payload.item and payload.item.name or '?', resource = payload.resource,
                    })
                end
                -- returning nil keeps the item's metadata unchanged
            end, {})
        end)
        if not ok then Log.warn('ox_inventory createItem hook failed: %s', tostring(err)) end
    end
end

return B
