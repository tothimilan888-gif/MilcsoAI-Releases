# MilcsoGuard – architektúra

> A „MilcsoGuard” munkanév; a terméknév, a logó és a színek a `web/src/brand.ts`, a `fivem/milcsoguard/nui/brand.js` és a `config/config.lua` fájlokban egy helyen módosíthatók.

## 1. Projektfelmérés eredménye (2026-10-20)

| Kérdés | Megállapítás |
|---|---|
| Meglévő FiveM projekt | **Nincs.** A repó (`MilcsoAI-Releases`) a fejlesztés kezdetekor egyetlen `README.md`-t tartalmazott. Nincs `fxmanifest.lua`, resource, adatbázis vagy framework. |
| Framework | Nem azonosítható → a rendszer **futásidőben detektál** (`GetResourceState`), és ESX / QBCore / standalone módban is fut. |
| FiveM artifact verzió | Nem elérhető (nincs szerver). A resource indításkor kiírja a `GetConvar('version')` értékét, és a backend felé is jelenti. |
| Ellenőrzött API-k | A natívokat a `citizenfx/fivem` repó `ext/native-decls` deklarációiból, a szerveroldali game eventek mezőit a `ServerGameState.cpp` forrásából ellenőriztük (lásd 6. fejezet). |
| Ellenőrzött framework verziók | es_extended **1.16.3**, qb-core **1.3.0**, ox_inventory **2.48.0**, ox_lib **3.40.3**, oxmysql **2.14.3**, screenshot-basic (2022-01). |

A meglévő `README.md`-hez nem nyúltunk; minden új fájl a `milcsoguard/` könyvtárban van.

## 2. Komponensek

```
milcsoguard/
├── fivem/milcsoguard/   FiveM resource (Lua 5.4) – szerver + kliens + NUI adminpanel
│   ├── config/          csak szerveroldali konfiguráció (a kliens soha nem kapja meg)
│   ├── shared/          tiszta, natív-független segédmodulok (risk engine, rate limiter, validátor)
│   ├── bridge/          ESX / QBCore / standalone / ox_inventory réteg
│   ├── server/core/     állapot, jogosultság, detektálási pipeline, ban store, API kliens
│   ├── server/modules/  kapcsolható detektálási modulok
│   ├── server/admin/    játékon belüli adminpanel szerveroldala
│   ├── client/          kliensoldali jelzések + NUI híd
│   └── nui/             adminpanel (HTML/CSS/JS, build lépés nélkül)
├── backend/             Node.js 22 + TypeScript + Fastify 5 + PostgreSQL
├── web/                 React 19 + TypeScript + Vite webes dashboard
├── tests/lua/           Lua unit tesztek natív-mockokkal
└── docs/                dokumentáció
```

### Miért egy FiveM resource és nem kilenc?

A javasolt `ac_core / ac_server / ac_client / ac_admin / ac_bridge` felosztást **egy resource-on belüli mappákként** valósítottuk meg. Indok:

* Külön resource-ok között minden hívás export → lassabb, és indítási sorrendfüggést okoz.
* Egy cheat vagy egy rossz `stop` parancs egy-egy alresource-ot külön le tudna állítani; egy resource-nál a leállás egyetlen, jól detektálható esemény.
* Az üres, csak a struktúra kedvéért létező resource-okat a specifikáció is kerülendőnek tartja.

A `ac_web`, `ac_api`, `ac_database`, `ac_tests` megfelelője a `web/`, `backend/`, `backend/migrations/`, `tests/` + `backend/tests/`.

## 3. Bizalmi modell

```
 [Játékos kliens]  ──(net event, rate limitelt, validált)──►  [FXServer + milcsoguard]  ──HTTPS + API kulcs──►  [Backend API]  ◄──HTTPS + session cookie + CSRF──  [Web dashboard]
   NEM megbízható                                            döntéshozó (offline is)                          igazság forrása (DB)
```

* **A kliens nem megbízható.** Kliensoldali jelzés `source = client` címkét kap; a pipeline **kódszinten** (nem konfigurálhatóan) megakadályozza, hogy kizárólag kliensforrású jelzés automatikus bant okozzon – legfeljebb kick.
* **Az FXServer a döntéshozó.** Az automatikus intézkedések (kick/ban) a szerveren születnek, így a backend kiesése nem gyengíti a védelmet és **nem okoz tömeges bant**: a banok helyi KVP gyorsítótárban is megvannak, a detektálások helyi sorba kerülnek és később szinkronizálódnak.
* **A backend az igazság forrása** a banokra, a felülvizsgálatokra, az auditra és a konfigurációra. A web soha nem ír közvetlenül az adatbázisba; minden módosítás validált, jogosultság-ellenőrzött API-végponton és tranzakcióban történik.
* **Titkok:** az API kulcs kizárólag szerver-convarban (`set milcsoguard_api_key`, nem `setr`!) él. A konfigurációs fájlok csak `server_scripts`-ként töltődnek be, a kliens nem kapja meg őket. A webes frontend nem tárol tokent – httpOnly session cookie-t használ.
* **Távoli konfiguráció:** a webről csak a detektálási modulok paraméterei, akciói és a kockázati küszöbök írhatók felül. Jogosultsági forrás, API URL, kulcs **nem** állítható távolról (így egy kompromittált webes fiók sem tud adminjogot adni a játékban).

## 4. Detektálási pipeline (FiveM szerver)

```
modul ─► MG.Detections.report(src, typeKey, evidence, opts)
          │  1. modul engedélyezve? játékos whitelistelt erre a modulra? szankcionált állapot (pl. AllowTeleport)?
          │  2. dedup / rate limit (ugyanaz a típus ugyanattól a játékostól N mp-en belül → összevonás)
          │  3. kockázati pontszám: alap pont × forrás-szorzó, csillapodó (half-life) összegzés játékosonként
          │  4. akció = max(modul akciója, kockázati küszöb szerinti eszkaláció)
          │  5. védőkorlátok: client-only ≠ ban; ban csak ≥2 független szerveroldali jelzéstípus esetén
          │     (vagy „conclusive” jelzésnél); auto-ban circuit breaker (pl. max 5 / 10 perc)
          │  6. végrehajtás: log / warn / monitor / kick / ban
          ▼
     helyi gyűrűpuffer (adminpanel) + kimenő sor (KVP-ben perzisztálva) ─► backend /detections (batch, idempotens localId)
```

Súlyosságok: `INFO, LOW, MEDIUM, HIGH, CRITICAL`. Akciók: `log, warn, monitor, kick, ban`.

## 5. Adatbázis (PostgreSQL)

Lásd `backend/migrations/001_init.up.sql`. Fő táblák:

| Tábla | Szerep |
|---|---|
| `servers` | szerverek (tenantok), állapot, utolsó heartbeat, adatmegőrzési beállítás |
| `users`, `user_identifiers` | webes fiókok; opcionálisan FiveM azonosítóhoz kötve (játékon belüli jogosultsághoz) |
| `roles`, `role_permissions`, `server_members` | szerepkörök (rendszer + szerverenkénti egyedi), tagság szerverenként |
| `sessions` | szerveroldali munkamenetek (csak a token SHA-256 hash-e tárolódik) |
| `api_keys` | játékszerver-kulcsok metaadatai (prefix + hash, visszavonás, rotáció) |
| `players`, `player_identifiers`, `player_sessions` | játékosok szerverenként; az azonosítók **opcionálisak**, a net ID nem azonosító |
| `detections` | detektálások bizonyítékkal (JSONB), felülvizsgálati állapottal |
| `bans`, `ban_identifiers`, `ban_detections` | banok; az egyezés konfigurálható azonosítótípusokon alapul |
| `whitelist_entries` | játékos / resource / modell kivételek modulonként |
| `audit_logs` | változtathatatlan auditnapló (API-n nincs módosító végpont) |
| `server_configs`, `server_config_history` | távoli konfiguráció + verziótörténet (rollback) |
| `server_commands` | web → játékszerver parancssor (kick, ban-szinkron, config reload) |
| `system_events` | resource leállás, heartbeat kiesés, konfigurációváltozás |
| `server_integrations` | Discord webhook (titkosítva, AES-256-GCM) |

## 6. Ellenőrzött FiveM API-k

Szerver natívok (mind `apiset: server` vagy `shared` a `citizenfx/fivem` deklarációk szerint):
`GetPlayerPed, GetEntityCoords, GetEntityVelocity, GetEntitySpeed, GetEntityHealth, GetEntityMaxHealth, GetPedArmour, GetPlayerMaxArmour, GetPlayerInvincible, IsEntityVisible, IsPlayerUsingSuperJump, GetPlayerWeaponDamageModifier, GetPlayerMeleeWeaponDamageModifier, GetSelectedPedWeapon, GetVehiclePedIsIn, GetVehicleType, GetEntityPopulationType, GetEntityScript, NetworkGetEntityOwner, NetworkGetEntityFromNetworkId, GetEntityModel, GetEntityType, GetPlayerRoutingBucket, GetPlayerIdentifierByType, GetPlayerToken, GetNumPlayerTokens, GetPlayerPing, IsPlayerAceAllowed, GetResourceState, GetConvar, SetResourceKvp*/GetResourceKvp*/StartFindKvp/FindKvp/EndFindKvp, GetEntityAttachedTo, GetEntityCollisionDisabled`.

Szerver eventek és mezők (forrás: `ServerGameState.cpp`):

| Event | Használt mezők | Megszakítható |
|---|---|---|
| `entityCreating(handle)` | – | igen (`CancelEvent`) |
| `explosionEvent(sender, ev)` | `explosionType, damageScale, posX/Y/Z, isAudible, isInvisible, ownerNetId` | igen |
| `weaponDamageEvent(sender, ev)` | `weaponType, weaponDamage, overrideDefaultDamage, willKill, hitGlobalId(s), damageType` | igen |
| `giveWeaponEvent(sender, ev)` | `pedId, weaponType, ammo, givenAsPickup` | igen |
| `removeWeaponEvent / removeAllWeaponsEvent` | `pedId, weaponType` | igen |
| `clearPedTasksEvent(sender, ev)` | `pedId, immediately` | igen |
| `startProjectileEvent(sender, ev)` | `ownerId, weaponHash, projectileHash` | igen |
| `ptFxEvent(sender, ev)` | `effectHash, assetHash, isOnEntity, entityNetId` | igen |

Framework API-k:

* ESX: `exports.es_extended:getSharedObject()`, `ESX.GetPlayerFromId`, `xPlayer.getGroup()`, `xPlayer.hasWeapon()`, szerver eventek `esx:addAccountMoney(src, account, money, reason)`, `esx:removeAccountMoney`, `esx:setAccountMoney`.
* QBCore: `exports['qb-core']:GetCoreObject()`, `QBCore.Functions.GetPlayer`, `QBCore.Functions.HasItem(source, items, amount)`, `QBCore.Functions.HasPermission` (ACE alapú), `QBCore:Server:OnMoneyChange(src, moneytype, amount, 'add'|'remove', reason)`.
* ox_inventory: `GetCurrentWeapon(inv)`, `GetItemCount(inv, item)`, `registerHook(event, fn, options)` (`swapItems`, `buyItem`, `craftItem`, `createItem`…).
* screenshot-basic: `requestClientScreenshot(player, options, cb)` – ellenőrizve, de **jelenleg nincs integrálva** (lásd DETECTIONS.md).

## 7. Jogosultságok

Lásd [PERMISSIONS.md](PERMISSIONS.md). A backend (`requirePermission`) és a FiveM szerver (`MG.Permissions.has`) is ellenőriz; a frontendben elrejtett gomb csak kényelmi funkció.

## 8. Kommunikáció

* FiveM → backend: `PerformHttpRequest`, HTTPS kötelező (kivéve `localhost` fejlesztői módban), `Authorization: Bearer <api key>`, timeout, exponenciális backoff, circuit breaker.
* Web → FiveM: `server_commands` sor; a játékszerver 5 mp-enként lekérdezi (egy kérés / szerver – elhanyagolható terhelés), majd nyugtáz.
* Valós idő a weben: Server-Sent Events, PostgreSQL `LISTEN/NOTIFY` alapon (több backend példány esetén is működik).
