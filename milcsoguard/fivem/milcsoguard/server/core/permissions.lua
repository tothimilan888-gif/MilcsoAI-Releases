-- In-game admin permission resolution. The client never decides whether it is an admin:
-- every admin action is re-checked here, on the server, right before it runs.
MG = MG or {}
local U = MG.Util
local Perm = {}
MG.Permissions = Perm

Perm.ALL = {
    'players.view', 'players.identifiers', 'players.kick', 'detections.view', 'detections.review',
    'bans.view', 'bans.create', 'bans.permanent', 'bans.remove', 'whitelist.view', 'whitelist.manage',
    'admins.view', 'admins.manage', 'roles.manage', 'settings.view', 'settings.manage', 'audit.view',
    'analytics.view', 'system.view', 'apikeys.manage', 'integrations.manage', 'servers.manage',
}
local ALL_SET = U.toSet(Perm.ALL)

--- Expands a role definition ('*' = all, '-perm' = remove) into a permission set.
function Perm.expandRole(roleKey)
    local role = Config.Roles[roleKey]
    if not role then return {} end
    local set = {}
    for _, p in ipairs(role.permissions) do
        if p == '*' then
            for _, a in ipairs(Perm.ALL) do set[a] = true end
        elseif p:sub(1, 1) == '-' then
            set[p:sub(2)] = nil
        elseif ALL_SET[p] then
            set[p] = true
        end
    end
    return set
end

local function roleKeysByLevel()
    local keys = {}
    for k in pairs(Config.Roles) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return Config.Roles[a].level > Config.Roles[b].level end)
    return keys
end

local function candidate(roleKey, source)
    local role = Config.Roles[roleKey]
    if not role then return nil end
    return { role = roleKey, label = role.label, level = role.level, perms = Perm.expandRole(roleKey), source = source }
end

--- Resolves the strongest admin grant for a player from all configured sources.
--- Returns nil for non-admins.
function Perm.resolve(src, p)
    src = tonumber(src)
    p = p or MG.State.get(src)
    local best = nil
    local prefix = Config.Permissions.acePrefix
    local function consider(c)
        if c and (not best or c.level > best.level) then best = c end
    end
    for _, source in ipairs(Config.Permissions.sources) do
        if source == 'ace' then
            for _, key in ipairs(roleKeysByLevel()) do
                if IsPlayerAceAllowed(src, ('%s.role.%s'):format(prefix, key)) then
                    consider(candidate(key, 'ace'))
                    break
                end
            end
        elseif source == 'framework' then
            local fw = MG.Bridge and MG.Bridge.name or 'standalone'
            local map = Config.Permissions.framework[fw]
            if map and MG.Bridge then
                for group, roleKey in pairs(map) do
                    if MG.Bridge.hasGroup(src, group) then consider(candidate(roleKey, 'framework')) end
                end
            end
        elseif source == 'backend' and p and p.backendAdmin then
            local b = p.backendAdmin
            local perms = U.toSet(b.permissions or {})
            consider({ role = b.role, label = b.roleName or b.role, level = tonumber(b.level) or 0, perms = perms, source = 'backend' })
        end
    end
    -- Single permissions granted via ACE are added on top (milcsoguard.perm.<perm>).
    if Config.Permissions.sources and U.contains(Config.Permissions.sources, 'ace') then
        for _, perm in ipairs(Perm.ALL) do
            if IsPlayerAceAllowed(src, ('%s.perm.%s'):format(prefix, perm)) then
                best = best or { role = 'custom', label = 'ACE', level = 1, perms = {}, source = 'ace' }
                best.perms[perm] = true
            end
        end
    end
    return best
end

--- Re-resolves and caches. Call before every privileged action.
function Perm.refresh(src)
    local p = MG.State.get(src)
    local admin = Perm.resolve(src, p)
    if p then p.admin = admin end
    return admin
end

function Perm.has(src, perm)
    if tonumber(src) == 0 then return true end -- server console
    local admin = Perm.refresh(src)
    return admin ~= nil and admin.perms[perm] == true
end

function Perm.isAdmin(src)
    return Perm.refresh(src) ~= nil
end

--- Permission list for the NUI (display only; the server still checks every action).
function Perm.list(admin)
    local out = {}
    if not admin then return out end
    for _, p in ipairs(Perm.ALL) do
        if admin.perms[p] then out[#out + 1] = p end
    end
    return out
end

--- Actor descriptor sent to the backend for audit.
function Perm.actor(src)
    if tonumber(src) == 0 then return { name = 'console', identifiers = {}, source = 'console' } end
    local p = MG.State.get(src)
    return {
        name = p and p.name or U.sanitize(GetPlayerName(src) or '?'),
        identifiers = p and U.filterIdentifiers(p.identifiers, { ip = true, token = true }) or {},
        source = p and p.admin and p.admin.source or 'ace',
    }
end

return Perm
