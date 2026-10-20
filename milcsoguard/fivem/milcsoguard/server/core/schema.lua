-- Single source of truth for detection modules and their tunable settings.
-- The schema is reported to the backend on handshake; the web settings page is rendered from it.
MG = MG or {}
local U = MG.Util
local Schema = { version = 1 }
MG.Schema = Schema

local function num(label, min, max, default, unit) return { type = 'number', label = label, min = min, max = max, default = default, unit = unit } end
local function int(label, min, max, default, unit) return { type = 'integer', label = label, min = min, max = max, default = default, unit = unit } end
local function bool(label, default) return { type = 'boolean', label = label, default = default } end
local function list(label, maxItems, default) return { type = 'list', label = label, maxItems = maxItems, default = default } end

Schema.modules = {
    -- ------------------------------------------------------------------ movement
    ['movement.teleport'] = {
        label = 'Teleport anomália', category = 'movement', source = 'server',
        description = 'Két szerveroldali pozícióminta közötti, fizikailag lehetetlen elmozdulás.',
        limitations = 'Kliensoldali scriptek (interior bejáratok, liftek) SetEntityCoords-szal legálisan teleportálhatnak; ezeket a szerver nem tudja megkülönböztetni. Ezért alapból csak figyelmeztet; használd a teleportZones listát és az AllowMovement exportot.',
        defaults = { enabled = true, action = 'warn', severity = 'MEDIUM' },
        params = {
            maxDistanceOnFoot = num('Max. elmozdulás gyalog / minta', 30, 2000, 120, 'm'),
            maxDistanceInVehicle = num('Max. elmozdulás járműben / minta', 50, 5000, 400, 'm'),
            highSeverityDistance = num('E felett HIGH súlyosság', 200, 20000, 1500, 'm'),
            ignoreZones = bool('teleportZones figyelembevétele', true),
        },
    },
    ['movement.speed'] = {
        label = 'Speedhack (gyalog)', category = 'movement', source = 'server',
        description = 'Tartósan a sprint sebesség feletti vízszintes haladás gyalogosan.',
        limitations = 'Esés, ragdoll és ejtőernyő magas vízszintes sebességet adhat; a modul a gyors süllyedést kiszűri, és több egymást követő mintát vár.',
        defaults = { enabled = true, action = 'warn', severity = 'MEDIUM' },
        params = {
            maxOnFootSpeed = num('Max. gyalogos sebesség', 8, 60, 14, 'm/s'),
            consecutive = int('Egymást követő minták', 1, 20, 3),
            fallingSpeedIgnore = num('Süllyedés, ami felett nem vizsgál', 1, 50, 3.5, 'm/s'),
        },
    },
    ['movement.noclip'] = {
        label = 'Noclip / fly', category = 'movement', source = 'server',
        description = 'Gyalogos elmozdulás, miközben a szinkronizált sebességvektor közel nulla, vagy a ped ütközése ki van kapcsolva.',
        limitations = 'Heurisztika: a szinkronizált sebesség hálózati késéssel frissül, attach-olt (pl. hordozott) pedeknél hamis pozitív lehet – ezeket kiszűri.',
        defaults = { enabled = true, action = 'warn', severity = 'HIGH' },
        params = {
            minDisplacementSpeed = num('Min. elmozdulási sebesség', 2, 50, 6, 'm/s'),
            maxReportedVelocity = num('Max. jelentett sebesség', 0.1, 10, 1.0, 'm/s'),
            consecutive = int('Egymást követő minták', 1, 20, 3),
            flagCollisionDisabled = bool('Kikapcsolt ütközés jelzése', true),
        },
    },
    ['movement.vehicle_speed'] = {
        label = 'Jármű sebesség', category = 'movement', source = 'server',
        description = 'Járműtípusonkénti maximális sebesség túllépése (csak a sofőr).',
        limitations = 'Egyedi, felturbózott addon járműveknél emeld a küszöböt.',
        defaults = { enabled = true, action = 'warn', severity = 'MEDIUM' },
        params = {
            automobile = num('Autó', 30, 300, 95, 'm/s'),
            bike = num('Motor', 30, 300, 90, 'm/s'),
            boat = num('Hajó', 20, 300, 70, 'm/s'),
            heli = num('Helikopter', 30, 300, 95, 'm/s'),
            plane = num('Repülő', 50, 500, 220, 'm/s'),
            consecutive = int('Egymást követő minták', 1, 20, 2),
        },
    },
    ['movement.superjump'] = {
        label = 'Super jump', category = 'movement', source = 'server',
        description = 'A játék szuperugrás képessége aktív (IsPlayerUsingSuperJump).',
        limitations = 'Ha a szervered szándékosan engedi (pl. esemény), kapcsold ki vagy használd a SetExempt exportot.',
        defaults = { enabled = true, action = 'kick', severity = 'HIGH' },
        params = {},
    },
    -- ------------------------------------------------------------------ player state
    ['player.godmode'] = {
        label = 'Godmode (invincible flag)', category = 'player', source = 'server',
        description = 'A szinkronizált játékos-invincible jelző aktív (GetPlayerInvincible).',
        limitations = 'Csak a hálózaton szinkronizált invincible állapotot látja; a SetEntityProofs vagy memóriamódosítás alapú godmode-ot nem. Karakterkészítő / cutscene scriptek legálisan bekapcsolhatják – ezekhez SetExempt.',
        defaults = { enabled = true, action = 'warn', severity = 'HIGH' },
        params = { consecutive = int('Egymást követő minták', 1, 20, 2) },
    },
    ['player.health'] = {
        label = 'Életerő / páncél a maximum felett', category = 'player', source = 'server',
        description = 'Életerő a ped maximuma felett, vagy páncél a játékos maximuma felett.',
        limitations = 'Ha egy script a max. életerőt is átállítja, az nem jelez (a maximumhoz viszonyít).',
        defaults = { enabled = true, action = 'kick', severity = 'HIGH' },
        params = { tolerance = int('Tűréshatár', 0, 100, 5, 'HP'), consecutive = int('Egymást követő minták', 1, 20, 2) },
    },
    ['player.invisible'] = {
        label = 'Láthatatlanság', category = 'player', source = 'server',
        description = 'A játékos pedje nem látható (IsEntityVisible = false), miközben él.',
        limitations = 'Admin és spawn scriptek láthatatlanná tehetik a pedet; join/respawn után türelmi idő van.',
        defaults = { enabled = true, action = 'warn', severity = 'MEDIUM' },
        params = { consecutive = int('Egymást követő minták', 1, 30, 3) },
    },
    ['player.damage_modifier'] = {
        label = 'Sebzésszorzó', category = 'player', source = 'server',
        description = 'A játékos fegyver- vagy közelharci sebzésszorzója a megengedett felett.',
        limitations = 'Csak a hálózaton szinkronizált szorzót látja.',
        defaults = { enabled = true, action = 'kick', severity = 'HIGH' },
        params = { maxWeaponModifier = num('Max. fegyver szorzó', 1, 10, 1.05), maxMeleeModifier = num('Max. közelharci szorzó', 1, 10, 1.05) },
    },
    -- ------------------------------------------------------------------ weapons
    ['weapons.blacklist'] = {
        label = 'Tiltott fegyver', category = 'weapons', source = 'server',
        description = 'A játékos kezében tiltólistás fegyver van; a szerver el is veszi.',
        limitations = 'A kiválasztott fegyvert mintavételezi, nem minden lövést.',
        defaults = { enabled = true, action = 'kick', severity = 'HIGH' },
        params = {
            weapons = list('Tiltott fegyverek', 200, { 'WEAPON_RAILGUN', 'WEAPON_RAILGUNXM3', 'WEAPON_MINIGUN', 'WEAPON_RAYMINIGUN', 'WEAPON_RAYPISTOL', 'WEAPON_RAYCARBINE', 'WEAPON_STUNGUN_MP', 'WEAPON_HOMINGLAUNCHER', 'WEAPON_EMPLAUNCHER', 'WEAPON_COMPACTLAUNCHER' }),
            removeWeapon = bool('Fegyver elvétele', true),
        },
    },
    ['weapons.inventory_mismatch'] = {
        label = 'Fegyver az inventoryn kívül', category = 'weapons', source = 'server',
        description = 'Kézben lévő fegyver, ami nincs a framework inventoryjában (ox_inventory / ESX loadout / QBCore item).',
        limitations = 'Csak telepített ESX/QBCore/ox_inventory esetén aktív. Inventory szinkron késése miatt több mintát vár; standalone módban nem fut.',
        defaults = { enabled = true, action = 'warn', severity = 'HIGH' },
        params = {
            consecutive = int('Egymást követő minták', 1, 20, 2),
            ignore = list('Figyelmen kívül hagyott fegyverek', 100, { 'WEAPON_UNARMED', 'GADGET_PARACHUTE', 'WEAPON_FIREEXTINGUISHER', 'WEAPON_PETROLCAN' }),
            removeWeapon = bool('Fegyver elvétele', false),
        },
    },
    ['weapons.give_event'] = {
        label = 'Fegyveradás más pednek', category = 'weapons', source = 'event',
        description = 'Kliens hálózati eventtel fegyvert ad egy másik játékos pedjének (giveWeaponEvent). Az eventet blokkolja.',
        limitations = 'Legitim kliensoldali fegyveradás más játékosnak ritka; ha egy scripted ilyet csinál, tedd a resource-ot whitelistre.',
        defaults = { enabled = true, action = 'kick', severity = 'HIGH' },
        params = {},
    },
    ['weapons.remove_event'] = {
        label = 'Fegyver elvétele mástól', category = 'weapons', source = 'event',
        description = 'Kliens másik játékos fegyvereit veszi el (removeWeaponEvent / removeAllWeaponsEvent). Blokkolja.',
        limitations = '',
        defaults = { enabled = true, action = 'kick', severity = 'HIGH' },
        params = {},
    },
    ['weapons.damage'] = {
        label = 'Sebzés anomália', category = 'weapons', source = 'event',
        description = 'Túl nagy sebzésérték, a kézben lévőtől eltérő fegyverrel okozott sebzés, közelharci sebzés nagy távolságból, vagy túl sűrű találat.',
        limitations = 'A kiválasztott fegyver szerveroldali értéke késhet egy fegyverváltásnál; ezért a fegyvereltérés több előfordulást vár.',
        defaults = { enabled = true, action = 'warn', severity = 'HIGH' },
        params = {
            maxDamage = int('Max. sebzés / találat', 50, 5000, 400),
            maxHitsPerSecond = int('Max. találat / mp', 3, 100, 20),
            meleeMaxDistance = num('Közelharci max. távolság', 2, 50, 8, 'm'),
            weaponMismatchCount = int('Fegyvereltérés jelzési küszöb', 1, 50, 3),
            cancelViolations = bool('Szabálysértő sebzés blokkolása', true),
        },
    },
    -- ------------------------------------------------------------------ entities / explosions
    ['explosions.filter'] = {
        label = 'Robbanásszűrő', category = 'entities', source = 'event',
        description = 'Tiltott típusú, láthatatlan-néma, felnagyított vagy túl sűrű robbanások blokkolása.',
        limitations = 'A járműrobbanások tulajdonosa lehet a jármű, nem a játékos – ezért a tulajdonos-egyezést nem vizsgálja.',
        defaults = { enabled = true, action = 'kick', severity = 'HIGH' },
        params = {
            blacklistedTypes = list('Tiltott robbanástípusok (ID)', 100, { '29', '37', '59', '70' }),
            maxPerWindow = int('Max. robbanás / ablak', 1, 200, 6),
            windowSeconds = int('Ablak', 1, 120, 10, 's'),
            maxDamageScale = num('Max. damageScale', 1, 10, 1.5),
            flagInvisibleSilent = bool('Láthatatlan + néma robbanás jelzése', true),
        },
    },
    ['entities.spawn'] = {
        label = 'Entity spawn védelem', category = 'entities', source = 'event',
        description = 'Kliens által létrehozott script entitások: tiltólistás modellek és entity flood blokkolása. Megbízható resource-ok, modellek és várt spawnok (ExpectEntity) engedélyezettek.',
        limitations = 'A spawnoló kliens resource-ot a GetEntityScript adja vissza, de ez nem mindig ismert. A legerősebb védelem a sv_entityLockdown convar (lásd dokumentáció).',
        defaults = { enabled = true, action = 'kick', severity = 'HIGH' },
        params = {
            blacklistedModels = list('Tiltott modellek', 500, { 'prop_beach_fire', 'prop_gas_tank_01a', 'prop_fnclink_05crnr1', 'p_crahsed_heli_s', 'prop_rock_4_big2', 'prop_fire_hydrant_1', 'stt_prop_stunt_soccer_ball', 'hei_prop_carrier_jet', 'apa_mp_apa_yacht', 'p_spinning_anus_s', 'blimp', 'blimp2', 'blimp3', 'cargoplane', 'jet', 'titan', 'avenger', 'khanjali', 'rhino', 'hydra', 'lazer', 'oppressor2' }),
            maxVehiclesPerWindow = int('Max. jármű / ablak', 1, 200, 6),
            maxPedsPerWindow = int('Max. ped / ablak', 1, 200, 10),
            maxObjectsPerWindow = int('Max. objektum / ablak', 1, 500, 40),
            windowSeconds = int('Ablak', 1, 120, 10, 's'),
        },
    },
    ['entities.clear_tasks'] = {
        label = 'Más ped feladatainak törlése', category = 'entities', source = 'event',
        description = 'Kliens más játékos pedjének feladatait törli (kidobás járműből, "kick from vehicle" cheat). Blokkolja.',
        limitations = 'Ha egy script legálisan használ ClearPedTasksImmediately-t más játékoson (pl. rendőr), állítsd log-ra.',
        defaults = { enabled = true, action = 'warn', severity = 'MEDIUM' },
        params = {},
    },
    ['entities.ptfx'] = {
        label = 'Részecskeeffekt flood', category = 'entities', source = 'event',
        description = 'Túl sok hálózati részecskeeffekt (ptFxEvent) rövid idő alatt.',
        limitations = '',
        defaults = { enabled = true, action = 'warn', severity = 'MEDIUM' },
        params = { maxPerWindow = int('Max. effekt / ablak', 5, 1000, 30), windowSeconds = int('Ablak', 1, 120, 10, 's'), maxScale = num('Max. méretarány', 1, 100, 5) },
    },
    ['entities.projectile'] = {
        label = 'Lövedék flood', category = 'entities', source = 'event',
        description = 'Túl sok indított lövedék (startProjectileEvent) vagy tiltott fegyverből indított lövedék.',
        limitations = '',
        defaults = { enabled = true, action = 'warn', severity = 'MEDIUM' },
        params = { maxPerWindow = int('Max. lövedék / ablak', 5, 1000, 25), windowSeconds = int('Ablak', 1, 120, 5, 's') },
    },
    -- ------------------------------------------------------------------ events / economy
    ['events.honeypot'] = {
        label = 'Csapda eventek', category = 'events', source = 'event',
        description = 'Olyan szerver eventek, amelyeket egyetlen legitim kliens sem hív (pl. a szervereden NEM telepített, ismert sérülékeny scriptek event nevei).',
        limitations = 'Csak olyan eventnevet adj meg, ami biztosan nem létezik a szervereden – különben a valódi játékosokat is jelezné. Indításkor a futó resource-okkal ütköző nevek kimaradnak.',
        defaults = { enabled = true, action = 'ban', severity = 'CRITICAL' },
        params = { events = list('Csapda eventnevek', 200, {}) },
    },
    ['events.spam'] = {
        label = 'Event spam', category = 'events', source = 'event',
        description = 'Saját (MilcsoGuard) és a CheckEvent exporttal védett eventek rate limit túllépése.',
        limitations = 'A FiveM nem ad globális hookot más resource-ok net eventjeire; csak a CheckEvent-tel bekötött eventeket látja.',
        defaults = { enabled = true, action = 'kick', severity = 'MEDIUM' },
        params = { defaultLimit = int('Alap limit / ablak', 1, 1000, 20), windowSeconds = int('Ablak', 1, 120, 10, 's') },
    },
    ['events.reported'] = {
        label = 'Más resource által jelentett gyanú', category = 'events', source = 'event',
        description = 'Más szerver scriptek a ReportSuspicious exporttal jelezhetnek (pl. validálatlan vásárlás).',
        limitations = 'A jelzés minősége a jelentő scripten múlik.',
        defaults = { enabled = true, action = 'warn', severity = 'MEDIUM' },
        params = {},
    },
    ['economy.transactions'] = {
        label = 'Gyanús tranzakciók', category = 'events', source = 'event',
        description = 'Nagy összegű pénzjóváírás vagy rövid idő alatti összesített pénzbeáramlás (ESX/QBCore), nagy mennyiségű item létrehozása (ox_inventory) naplózása.',
        limitations = 'A pénzeventek nem mondják meg, melyik script adta a pénzt; ox_inventory createItem-nél a hívó resource ismert.',
        defaults = { enabled = true, action = 'log', severity = 'MEDIUM' },
        params = {
            singleAmount = int('Egyszeri jóváírás küszöb', 1000, 1000000000, 500000),
            windowAmount = int('Ablakban összesített küszöb', 1000, 1000000000, 2000000),
            windowMinutes = int('Ablak', 1, 240, 10, 'perc'),
            itemCount = int('Item darabszám küszöb (ox)', 10, 1000000, 500),
        },
    },
    -- ------------------------------------------------------------------ resources
    ['resources.monitor'] = {
        label = 'Resource felügyelet', category = 'resources', source = 'resource',
        description = 'Kritikus resource-ok leállása, a MilcsoGuard konfigurációs fájl futás közbeni megváltozása.',
        limitations = 'Szerveroldali felügyelet; a kliensen futó resource-ok állapotát a kliens jelzései adják.',
        defaults = { enabled = true, action = 'log', severity = 'HIGH' },
        params = { critical = list('Kritikus resource-ok', 50, {}) },
    },
    -- ------------------------------------------------------------------ client signals (never ban)
    ['client.heartbeat'] = {
        label = 'Kliens heartbeat', category = 'client', source = 'client',
        description = 'A kliensoldali MilcsoGuard script nem válaszol a szerver kihívására (leállították vagy blokkolják).',
        limitations = 'Kliensoldali jel: egy cheat hamis választ is küldhet. Automatikus banhoz soha nem elég.',
        defaults = { enabled = true, action = 'kick', severity = 'MEDIUM' },
        params = { intervalSeconds = int('Kihívás gyakorisága', 10, 300, 30, 's'), maxMisses = int('Max. kihagyás', 1, 20, 3), readyTimeoutSeconds = int('Indulási türelmi idő', 30, 900, 240, 's') },
    },
    ['client.resource_injection'] = {
        label = 'Ismeretlen kliens resource', category = 'client', source = 'client',
        description = 'A kliens olyan resource indulását jelenti, ami a szerveren nem létezik, vagy szerver resource leállását.',
        limitations = 'Kliensoldali jel; a cheatek nem mindig regisztrálnak resource-ot.',
        defaults = { enabled = true, action = 'kick', severity = 'HIGH' },
        params = { allow = list('Engedélyezett kliens resource nevek', 50, {}) },
    },
    ['client.spectate'] = {
        label = 'Jogosulatlan spectate', category = 'client', source = 'client',
        description = 'A kliens spectator módban van, miközben nem admin.',
        limitations = 'Kliensoldali jel.',
        defaults = { enabled = true, action = 'warn', severity = 'MEDIUM' },
        params = {},
    },
}

Schema.risk = {
    halfLifeMinutes = num('Kockázat felezési idő', 1, 1440, 30, 'perc'),
    warnThreshold = int('Figyelmeztetés küszöb', 1, 10000, 25),
    monitorThreshold = int('Megfigyelés küszöb', 1, 10000, 45),
    kickThreshold = int('Kick küszöb', 1, 10000, 80),
    banThreshold = int('Ban küszöb', 1, 10000, 140),
    minDistinctServerTypesForBan = int('Ban-hoz szükséges független szerveroldali jelzéstípus', 1, 10, 2),
    autoBanEnabled = bool('Automatikus ban engedélyezve', true),
    autoBanDurationHours = int('Automatikus ban hossza (0 = végleges)', 0, 87600, 720, 'óra'),
    breakerMaxBans = int('Circuit breaker: max. auto-ban', 1, 1000, 5),
    breakerWindowMinutes = int('Circuit breaker ablak', 1, 1440, 10, 'perc'),
    monitorMinutes = int('Megfigyelés hossza', 1, 1440, 30, 'perc'),
}

local VALID_SEVERITY = U.toSet(MG.SEVERITIES)
local VALID_ACTION = U.toSet(MG.ACTIONS)
local LIST_ITEM = '^[%w_:%.%-]+$'

local function checkParam(spec, value, path, issues)
    local t = spec.type
    if t == 'number' or t == 'integer' then
        if type(value) ~= 'number' or value ~= value then
            issues[#issues + 1] = { path = path, message = 'must be a number' }
        elseif t == 'integer' and math.floor(value) ~= value then
            issues[#issues + 1] = { path = path, message = 'must be an integer' }
        elseif value < spec.min or value > spec.max then
            issues[#issues + 1] = { path = path, message = ('must be between %s and %s'):format(spec.min, spec.max) }
        else
            return true
        end
    elseif t == 'boolean' then
        if type(value) == 'boolean' then return true end
        issues[#issues + 1] = { path = path, message = 'must be true or false' }
    elseif t == 'list' then
        if type(value) ~= 'table' or not U.isList(value) then
            issues[#issues + 1] = { path = path, message = 'must be a list' }
        elseif #value > spec.maxItems then
            issues[#issues + 1] = { path = path, message = ('at most %d items'):format(spec.maxItems) }
        else
            for i, item in ipairs(value) do
                if type(item) ~= 'string' or #item > 128 or not item:match(LIST_ITEM) then
                    issues[#issues + 1] = { path = ('%s[%d]'):format(path, i), message = 'invalid list item' }
                    return false
                end
            end
            return true
        end
    end
    return false
end

--- Validates an overrides table ({ modules = {...}, risk = {...} }). Returns clean, issues.
--- Invalid entries are dropped (never half-applied) and reported with their path.
function Schema.validate(overrides)
    local issues, clean = {}, { modules = {}, risk = {} }
    if overrides == nil then return clean, issues end
    if type(overrides) ~= 'table' then
        return clean, { { path = '', message = 'must be an object' } }
    end
    for k in pairs(overrides) do
        if k ~= 'modules' and k ~= 'risk' then issues[#issues + 1] = { path = tostring(k), message = 'unknown key' } end
    end
    for key, ov in pairs(overrides.modules or {}) do
        local spec = Schema.modules[key]
        local base = 'modules.' .. tostring(key)
        if not spec then
            issues[#issues + 1] = { path = base, message = 'unknown module' }
        elseif type(ov) ~= 'table' then
            issues[#issues + 1] = { path = base, message = 'must be an object' }
        else
            local c = {}
            for k in pairs(ov) do
                if k ~= 'enabled' and k ~= 'action' and k ~= 'severity' and k ~= 'params' then
                    issues[#issues + 1] = { path = base .. '.' .. tostring(k), message = 'unknown key' }
                end
            end
            if ov.enabled ~= nil then
                if type(ov.enabled) == 'boolean' then c.enabled = ov.enabled else issues[#issues + 1] = { path = base .. '.enabled', message = 'must be true or false' } end
            end
            if ov.action ~= nil then
                if not VALID_ACTION[ov.action] then
                    issues[#issues + 1] = { path = base .. '.action', message = 'invalid action' }
                elseif ov.action == 'ban' and spec.source == 'client' then
                    issues[#issues + 1] = { path = base .. '.action', message = 'client-side signals cannot trigger automatic bans' }
                else
                    c.action = ov.action
                end
            end
            if ov.severity ~= nil then
                if VALID_SEVERITY[ov.severity] then c.severity = ov.severity else issues[#issues + 1] = { path = base .. '.severity', message = 'invalid severity' } end
            end
            if ov.params ~= nil then
                if type(ov.params) ~= 'table' then
                    issues[#issues + 1] = { path = base .. '.params', message = 'must be an object' }
                else
                    c.params = {}
                    for pk, pv in pairs(ov.params) do
                        local ps = spec.params[pk]
                        if not ps then
                            issues[#issues + 1] = { path = base .. '.params.' .. tostring(pk), message = 'unknown parameter' }
                        elseif checkParam(ps, pv, base .. '.params.' .. pk, issues) then
                            c.params[pk] = pv
                        end
                    end
                end
            end
            clean.modules[key] = c
        end
    end
    for rk, rv in pairs(overrides.risk or {}) do
        local ps = Schema.risk[rk]
        if not ps then
            issues[#issues + 1] = { path = 'risk.' .. tostring(rk), message = 'unknown parameter' }
        elseif checkParam(ps, rv, 'risk.' .. rk, issues) then
            clean.risk[rk] = rv
        end
    end
    return clean, issues
end

--- Effective settings = schema defaults <- local file overrides <- remote overrides.
function Schema.build(localOverrides, remoteOverrides)
    local modules = {}
    for key, spec in pairs(Schema.modules) do
        local m = { enabled = spec.defaults.enabled, action = spec.defaults.action, severity = spec.defaults.severity, params = {} }
        for pk, ps in pairs(spec.params) do m.params[pk] = U.deepCopy(ps.default) end
        for _, layer in ipairs({ localOverrides or {}, remoteOverrides or {} }) do
            local ov = layer.modules and layer.modules[key]
            if ov then
                if ov.enabled ~= nil then m.enabled = ov.enabled end
                if ov.action then m.action = ov.action end
                if ov.severity then m.severity = ov.severity end
                for pk, pv in pairs(ov.params or {}) do m.params[pk] = U.deepCopy(pv) end
            end
        end
        modules[key] = m
    end
    local risk = {}
    for rk, ps in pairs(Schema.risk) do risk[rk] = ps.default end
    for _, layer in ipairs({ localOverrides or {}, remoteOverrides or {} }) do
        for rk, rv in pairs(layer.risk or {}) do risk[rk] = rv end
    end
    return modules, risk
end

--- Cross-field rules that single-field validation cannot express.
function Schema.checkRisk(risk)
    local issues = {}
    if not (risk.warnThreshold <= risk.monitorThreshold and risk.monitorThreshold <= risk.kickThreshold and risk.kickThreshold <= risk.banThreshold) then
        issues[#issues + 1] = { path = 'risk', message = 'thresholds must satisfy warn <= monitor <= kick <= ban' }
    end
    return issues
end

--- JSON-friendly descriptor for the backend.
function Schema.descriptor()
    local mods = {}
    for key, spec in pairs(Schema.modules) do
        mods[key] = {
            label = spec.label, category = spec.category, description = spec.description, limitations = spec.limitations,
            source = spec.source, defaults = spec.defaults, params = U.obj(U.deepCopy(spec.params)),
        }
    end
    return U.obj({ version = Schema.version, actions = MG.ACTIONS, severities = MG.SEVERITIES, modules = U.obj(mods), risk = U.obj(U.deepCopy(Schema.risk)) })
end

return Schema
