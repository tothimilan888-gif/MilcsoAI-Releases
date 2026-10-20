# Detektálási modulok

> Ez a fejezet őszintén leírja, **mit tud megbízhatóan megállapítani** a rendszer és **mit nem**. Egyetlen FiveM anticheat sem „feltörhetetlen”: a kliensen futó kód (a MilcsoGuard kliensoldali része is) módosítható, ezért a döntések a szerveren születnek.

## Megbízhatósági szintek

| Szint | Mi tartozik ide | Mire használható |
|---|---|---|
| **Szerveroldali állapot** (`source = server`) | OneSync által szinkronizált pozíció, sebesség, életerő, páncél, invincible / super jump flag, kiválasztott fegyver, sebzésszorzó | Erős jel, de **heurisztika**: hálózati késés, scriptek legális beavatkozása hamis pozitívot adhat → küszöb + több minta + türelmi idő |
| **Szerveroldali game event** (`source = event`) | `explosionEvent`, `weaponDamageEvent`, `giveWeaponEvent`, `entityCreating`, `clearPedTasksEvent`, `ptFxEvent`, `startProjectileEvent`, csapda eventek | A kliens *kérése*, amit a szerver **blokkolni tud** (`CancelEvent`). A blokkolás megbízható; a „ki küldte” megbízható; a szándék nem mindig |
| **Kliensoldali jel** (`source = client`) | heartbeat, ismeretlen kliens resource, spectate | **Nem megbízható** (hamisítható, elnyomható). Kisebb súllyal (0.5×) számít, és **kódszinten tiltott**, hogy önmagában bant okozzon |

## Mit NEM tud a rendszer (szándékosan vagy technikai okból)

* **Memória / injektor alapú cheatek közvetlen felismerése** (pl. „menu” DLL-ek): ehhez a kliens gépén rendszerszintű vizsgálat kellene, ami adatvédelmi és biztonsági okból tilos (nincs fájlrendszer-, folyamat- vagy képernyő-hozzáférés a játékon kívül). A rendszer a cheatek **hatását** figyeli a szerveren.
* **Aimbot / triggerbot**: szerveroldalról csak közvetett jelek látszanak (fegyvereltérés, sebzés, találati sűrűség). Megbízható aimbot-detektálás statisztikai elemzést igényelne – nincs implementálva, nem állítjuk, hogy van.
* **Más resource-ok net eventjei**: a FiveM nem ad globális hookot, ezért a harmadik féltől származó scriptek eventjeit csak akkor védi, ha azok meghívják a `CheckEvent` exportot (lásd lent).
* **SetEntityProofs alapú godmode**: nem szinkronizált, a szerver nem látja; csak a szinkronizált invincible flag és a max. érték feletti életerő észlelhető.
* **Screenshot bizonyíték**: nincs implementálva (a screenshot-basic integráció a terv része volt, de a backend tárolása nélkül csak félkész lenne).

## Automatikus intézkedések és védőkorlátok

* Akciók: `log` → `warn` (admin riasztás + opcionális üzenet a játékosnak) → `monitor` (megjelölés X percre) → `kick` → `ban`.
* A végső akció = max(modul akciója, kockázati küszöb szerinti eszkaláció). A kockázat csillapodik (felezési idő, alapból 30 perc).
* **Ban csak akkor**, ha (a) a backend/konfiguráció engedi (`autoBanEnabled`), (b) legalább **2 független szerveroldali** detektálástípus támasztja alá a korrelációs ablakban, **vagy** a jel szerveroldali és perdöntő (pl. csapda event), (c) a circuit breaker zárt (alapból max. 5 auto-ban / 10 perc). Ha bármelyik nem teljesül, a ban **kickre** módosul, és ez a detektálás `actionResult` mezőjében olvasható.
* Kliensoldali modul akciója sem a backend, sem a resource validátorában nem állítható `ban`-ra.
* A backend kiesése **nem okoz bant**: a döntés helyi, a banok helyi gyorsítótárból érvényesülnek, a csatlakozás alapból *fail-open* (az ismeretlen játékos beengedhető, a gyorsítótárban lévő bannolt nem).

## Ajánlott FXServer beállítások

```cfg
set onesync on                       # kötelező a szerveroldali ellenőrzésekhez
set sv_entityLockdown relaxed        # kliensek nem hozhatnak létre hálózati entitást scriptből (strict: semmit)
set sv_filterRequestControl 2        # játékos által irányított entitás irányítása nem kérhető el (4 = semmi, scripteket törhet)
set sv_enableNetworkedSounds false   # hang-spam ellen
set sv_enableNetworkedPhoneExplosions false
```

A `sv_entityLockdown` a leghatékonyabb entity-spam elleni védelem; ha bekapcsolod, a kliensoldali spawnoló scripteket át kell írni szerveroldali `CreateVehicleServerSetter` stb. hívásra. Ezek a convarok a FiveM saját beállításai (létezésük a `citizen-server-impl` forrásában ellenőrizve) – a MilcsoGuard induláskor figyelmeztet, ha a `sv_entityLockdown` nincs beállítva.

## Integráció más scriptekkel (szerveroldali exportok)

```lua
-- Szerver által indított teleport előtt (pl. admin TP, belépés interiorba szerveroldalról):
exports.milcsoguard:AllowMovement(source, 5000)

-- Egy modul (vagy kategória) ideiglenes kikapcsolása egy játékosra:
exports.milcsoguard:SetExempt(source, 'player.godmode', 10000)   -- vagy 'movement.*' vagy '*'

-- Ha a szerver megkér egy klienst, hogy spawnoljon valamit (pl. jármű bolt kliensoldali spawnnal):
exports.milcsoguard:ExpectEntity(source, 'adder', 1, 10000)

-- Saját net eventek rate limitje:
RegisterNetEvent('shop:buy', function(item)
    if not exports.milcsoguard:CheckEvent(source, 'shop:buy', { limit = 5, windowMs = 10000 }) then return end
    -- ... saját validáció ...
end)

-- Saját scriptben észlelt visszaélés jelentése (pl. validálatlan összeg):
exports.milcsoguard:ReportSuspicious(source, 'negative price in shop:buy', { price = price })

exports.milcsoguard:GetPlayerRisk(source)          -- aktuális kockázati pontszám
exports.milcsoguard:IsAdmin(source, 'bans.create') -- jogosultság lekérdezése
```

**Ezek az exportok csak szerveroldalon léteznek.** Kliensoldali „teleport engedélyezés” szándékosan nincs: egy cheat ugyanazt az eventet elküldhetné. Kliensoldali, legitim teleportokhoz (interior ajtók, liftek) használd a `Config.TeleportZones` listát.

## Modulok

### `movement.noclip` – Noclip / fly

* **Forrás:** szerver (megbízható) · **Alapértelmezés:** bekapcsolva, warn, HIGH
* **Mit észlel:** Gyalogos elmozdulás, miközben a szinkronizált sebességvektor közel nulla, vagy a ped ütközése ki van kapcsolva.
* **Korlátok:** Heurisztika: a szinkronizált sebesség hálózati késéssel frissül, attach-olt (pl. hordozott) pedeknél hamis pozitív lehet – ezeket kiszűri.
* **Paraméterek:** `consecutive` = 3; `flagCollisionDisabled` = true; `maxReportedVelocity` = 1.0 m/s; `minDisplacementSpeed` = 6 m/s

### `movement.speed` – Speedhack (gyalog)

* **Forrás:** szerver (megbízható) · **Alapértelmezés:** bekapcsolva, warn, MEDIUM
* **Mit észlel:** Tartósan a sprint sebesség feletti vízszintes haladás gyalogosan.
* **Korlátok:** Esés, ragdoll és ejtőernyő magas vízszintes sebességet adhat; a modul a gyors süllyedést kiszűri, és több egymást követő mintát vár.
* **Paraméterek:** `consecutive` = 3; `fallingSpeedIgnore` = 3.5 m/s; `maxOnFootSpeed` = 14 m/s

### `movement.superjump` – Super jump

* **Forrás:** szerver (megbízható) · **Alapértelmezés:** bekapcsolva, kick, HIGH
* **Mit észlel:** A játék szuperugrás képessége aktív (IsPlayerUsingSuperJump).
* **Korlátok:** Ha a szervered szándékosan engedi (pl. esemény), kapcsold ki vagy használd a SetExempt exportot.

### `movement.teleport` – Teleport anomália

* **Forrás:** szerver (megbízható) · **Alapértelmezés:** bekapcsolva, warn, MEDIUM
* **Mit észlel:** Két szerveroldali pozícióminta közötti, fizikailag lehetetlen elmozdulás.
* **Korlátok:** Kliensoldali scriptek (interior bejáratok, liftek) SetEntityCoords-szal legálisan teleportálhatnak; ezeket a szerver nem tudja megkülönböztetni. Ezért alapból csak figyelmeztet; használd a teleportZones listát és az AllowMovement exportot.
* **Paraméterek:** `highSeverityDistance` = 1500 m; `ignoreZones` = true; `maxDistanceInVehicle` = 400 m; `maxDistanceOnFoot` = 120 m

### `movement.vehicle_speed` – Jármű sebesség

* **Forrás:** szerver (megbízható) · **Alapértelmezés:** bekapcsolva, warn, MEDIUM
* **Mit észlel:** Járműtípusonkénti maximális sebesség túllépése (csak a sofőr).
* **Korlátok:** Egyedi, felturbózott addon járműveknél emeld a küszöböt.
* **Paraméterek:** `automobile` = 95 m/s; `bike` = 90 m/s; `boat` = 70 m/s; `consecutive` = 2; `heli` = 95 m/s; `plane` = 220 m/s

### `player.damage_modifier` – Sebzésszorzó

* **Forrás:** szerver (megbízható) · **Alapértelmezés:** bekapcsolva, kick, HIGH
* **Mit észlel:** A játékos fegyver- vagy közelharci sebzésszorzója a megengedett felett.
* **Korlátok:** Csak a hálózaton szinkronizált szorzót látja.
* **Paraméterek:** `maxMeleeModifier` = 1.05; `maxWeaponModifier` = 1.05

### `player.godmode` – Godmode (invincible flag)

* **Forrás:** szerver (megbízható) · **Alapértelmezés:** bekapcsolva, warn, HIGH
* **Mit észlel:** A szinkronizált játékos-invincible jelző aktív (GetPlayerInvincible).
* **Korlátok:** Csak a hálózaton szinkronizált invincible állapotot látja; a SetEntityProofs vagy memóriamódosítás alapú godmode-ot nem. Karakterkészítő / cutscene scriptek legálisan bekapcsolhatják – ezekhez SetExempt.
* **Paraméterek:** `consecutive` = 2

### `player.health` – Életerő / páncél a maximum felett

* **Forrás:** szerver (megbízható) · **Alapértelmezés:** bekapcsolva, kick, HIGH
* **Mit észlel:** Életerő a ped maximuma felett, vagy páncél a játékos maximuma felett.
* **Korlátok:** Ha egy script a max. életerőt is átállítja, az nem jelez (a maximumhoz viszonyít).
* **Paraméterek:** `consecutive` = 2; `tolerance` = 5 HP

### `player.invisible` – Láthatatlanság

* **Forrás:** szerver (megbízható) · **Alapértelmezés:** bekapcsolva, warn, MEDIUM
* **Mit észlel:** A játékos pedje nem látható (IsEntityVisible = false), miközben él.
* **Korlátok:** Admin és spawn scriptek láthatatlanná tehetik a pedet; join/respawn után türelmi idő van.
* **Paraméterek:** `consecutive` = 3

### `weapons.blacklist` – Tiltott fegyver

* **Forrás:** szerver (megbízható) · **Alapértelmezés:** bekapcsolva, kick, HIGH
* **Mit észlel:** A játékos kezében tiltólistás fegyver van; a szerver el is veszi.
* **Korlátok:** A kiválasztott fegyvert mintavételezi, nem minden lövést.
* **Paraméterek:** `removeWeapon` = true; `weapons` = WEAPON_RAILGUN, WEAPON_RAILGUNXM3, WEAPON_MINIGUN, WEAPON_RAYMINIGUN, WEAPON_RAYPISTOL, WEAPON_RAYCARBINE, …

### `weapons.damage` – Sebzés anomália

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, warn, HIGH
* **Mit észlel:** Túl nagy sebzésérték, a kézben lévőtől eltérő fegyverrel okozott sebzés, közelharci sebzés nagy távolságból, vagy túl sűrű találat.
* **Korlátok:** A kiválasztott fegyver szerveroldali értéke késhet egy fegyverváltásnál; ezért a fegyvereltérés több előfordulást vár.
* **Paraméterek:** `cancelViolations` = true; `maxDamage` = 400; `maxHitsPerSecond` = 20; `meleeMaxDistance` = 8 m; `weaponMismatchCount` = 3

### `weapons.give_event` – Fegyveradás más pednek

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, kick, HIGH
* **Mit észlel:** Kliens hálózati eventtel fegyvert ad egy másik játékos pedjének (giveWeaponEvent). Az eventet blokkolja.
* **Korlátok:** Legitim kliensoldali fegyveradás más játékosnak ritka; ha egy scripted ilyet csinál, tedd a resource-ot whitelistre.

### `weapons.inventory_mismatch` – Fegyver az inventoryn kívül

* **Forrás:** szerver (megbízható) · **Alapértelmezés:** bekapcsolva, warn, HIGH
* **Mit észlel:** Kézben lévő fegyver, ami nincs a framework inventoryjában (ox_inventory / ESX loadout / QBCore item).
* **Korlátok:** Csak telepített ESX/QBCore/ox_inventory esetén aktív. Inventory szinkron késése miatt több mintát vár; standalone módban nem fut.
* **Paraméterek:** `consecutive` = 2; `ignore` = WEAPON_UNARMED, GADGET_PARACHUTE, WEAPON_FIREEXTINGUISHER, WEAPON_PETROLCAN; `removeWeapon` = false

### `weapons.remove_event` – Fegyver elvétele mástól

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, kick, HIGH
* **Mit észlel:** Kliens másik játékos fegyvereit veszi el (removeWeaponEvent / removeAllWeaponsEvent). Blokkolja.

### `explosions.filter` – Robbanásszűrő

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, kick, HIGH
* **Mit észlel:** Tiltott típusú, láthatatlan-néma, felnagyított vagy túl sűrű robbanások blokkolása.
* **Korlátok:** A járműrobbanások tulajdonosa lehet a jármű, nem a játékos – ezért a tulajdonos-egyezést nem vizsgálja.
* **Paraméterek:** `blacklistedTypes` = 29, 37, 59, 70; `flagInvisibleSilent` = true; `maxDamageScale` = 1.5; `maxPerWindow` = 6; `windowSeconds` = 10 s

### `entities.clear_tasks` – Más ped feladatainak törlése

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, warn, MEDIUM
* **Mit észlel:** Kliens más játékos pedjének feladatait törli (kidobás járműből, "kick from vehicle" cheat). Blokkolja.
* **Korlátok:** Ha egy script legálisan használ ClearPedTasksImmediately-t más játékoson (pl. rendőr), állítsd log-ra.

### `entities.projectile` – Lövedék flood

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, warn, MEDIUM
* **Mit észlel:** Túl sok indított lövedék (startProjectileEvent) vagy tiltott fegyverből indított lövedék.
* **Paraméterek:** `maxPerWindow` = 25; `windowSeconds` = 5 s

### `entities.ptfx` – Részecskeeffekt flood

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, warn, MEDIUM
* **Mit észlel:** Túl sok hálózati részecskeeffekt (ptFxEvent) rövid idő alatt.
* **Paraméterek:** `maxPerWindow` = 30; `maxScale` = 5; `windowSeconds` = 10 s

### `entities.spawn` – Entity spawn védelem

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, kick, HIGH
* **Mit észlel:** Kliens által létrehozott script entitások: tiltólistás modellek és entity flood blokkolása. Megbízható resource-ok, modellek és várt spawnok (ExpectEntity) engedélyezettek.
* **Korlátok:** A spawnoló kliens resource-ot a GetEntityScript adja vissza, de ez nem mindig ismert. A legerősebb védelem a sv_entityLockdown convar (lásd dokumentáció).
* **Paraméterek:** `blacklistedModels` = prop_beach_fire, prop_gas_tank_01a, prop_fnclink_05crnr1, p_crahsed_heli_s, prop_rock_4_big2, prop_fire_hydrant_1, …; `maxObjectsPerWindow` = 40; `maxPedsPerWindow` = 10; `maxVehiclesPerWindow` = 6; `windowSeconds` = 10 s

### `events.honeypot` – Csapda eventek

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, ban, CRITICAL
* **Mit észlel:** Olyan szerver eventek, amelyeket egyetlen legitim kliens sem hív (pl. a szervereden NEM telepített, ismert sérülékeny scriptek event nevei).
* **Korlátok:** Csak olyan eventnevet adj meg, ami biztosan nem létezik a szervereden – különben a valódi játékosokat is jelezné. Indításkor a futó resource-okkal ütköző nevek kimaradnak.
* **Paraméterek:** `events` = (üres)

### `events.reported` – Más resource által jelentett gyanú

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, warn, MEDIUM
* **Mit észlel:** Más szerver scriptek a ReportSuspicious exporttal jelezhetnek (pl. validálatlan vásárlás).
* **Korlátok:** A jelzés minősége a jelentő scripten múlik.

### `events.spam` – Event spam

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, kick, MEDIUM
* **Mit észlel:** Saját (MilcsoGuard) és a CheckEvent exporttal védett eventek rate limit túllépése.
* **Korlátok:** A FiveM nem ad globális hookot más resource-ok net eventjeire; csak a CheckEvent-tel bekötött eventeket látja.
* **Paraméterek:** `defaultLimit` = 20; `windowSeconds` = 10 s

### `economy.transactions` – Gyanús tranzakciók

* **Forrás:** szerver game event (megbízható) · **Alapértelmezés:** bekapcsolva, log, MEDIUM
* **Mit észlel:** Nagy összegű pénzjóváírás vagy rövid idő alatti összesített pénzbeáramlás (ESX/QBCore), nagy mennyiségű item létrehozása (ox_inventory) naplózása.
* **Korlátok:** A pénzeventek nem mondják meg, melyik script adta a pénzt; ox_inventory createItem-nél a hívó resource ismert.
* **Paraméterek:** `itemCount` = 500; `singleAmount` = 500000; `windowAmount` = 2000000; `windowMinutes` = 10 perc

### `resources.monitor` – Resource felügyelet

* **Forrás:** szerver · **Alapértelmezés:** bekapcsolva, log, HIGH
* **Mit észlel:** Kritikus resource-ok leállása, a MilcsoGuard konfigurációs fájl futás közbeni megváltozása.
* **Korlátok:** Szerveroldali felügyelet; a kliensen futó resource-ok állapotát a kliens jelzései adják.
* **Paraméterek:** `critical` = (üres)

### `client.heartbeat` – Kliens heartbeat

* **Forrás:** **kliens (nem megbízható)** · **Alapértelmezés:** bekapcsolva, kick, MEDIUM
* **Mit észlel:** A kliensoldali MilcsoGuard script nem válaszol a szerver kihívására (leállították vagy blokkolják).
* **Korlátok:** Kliensoldali jel: egy cheat hamis választ is küldhet. Automatikus banhoz soha nem elég.
* **Paraméterek:** `intervalSeconds` = 30 s; `maxMisses` = 3; `readyTimeoutSeconds` = 240 s

### `client.resource_injection` – Ismeretlen kliens resource

* **Forrás:** **kliens (nem megbízható)** · **Alapértelmezés:** bekapcsolva, kick, HIGH
* **Mit észlel:** A kliens olyan resource indulását jelenti, ami a szerveren nem létezik, vagy szerver resource leállását.
* **Korlátok:** Kliensoldali jel; a cheatek nem mindig regisztrálnak resource-ot.
* **Paraméterek:** `allow` = (üres)

### `client.spectate` – Jogosulatlan spectate

* **Forrás:** **kliens (nem megbízható)** · **Alapértelmezés:** bekapcsolva, warn, MEDIUM
* **Mit észlel:** A kliens spectator módban van, miközben nem admin.
* **Korlátok:** Kliensoldali jel.
