# Konfigurációs útmutató

## Rétegek (melyik érték érvényes?)

```
schema.lua alapértékek  <  config/config.lua (Config.Modules / Config.RiskOverrides)  <  dashboard (távoli felülírás)
```

* A **modulok paraméterei, akciói, súlyossága és a kockázati beállítások** írhatók felül a dashboardról (vagy a játékon belüli Beállítások oldalról).
* **Nem** írható felül távolról: API URL/kulcs, jogosultsági források, szerepkör-leképezések, megbízható resource-ok fájlbeli listája, teljesítménybeállítások. Így egy kompromittált webes fiók sem tud a játékban admin jogot szerezni.
* A dashboard csak az alapértéktől **eltérő** értékeket menti. Ha a `config.lua`-ban felülírtál egy paramétert, és a dashboardon az alapértéken hagyod, a helyi érték marad érvényben.

## Validáció

* Induláskor a `config_check.lua` ellenőrzi a statikus beállításokat. Hiba esetén **részletes üzenet** + biztonságos viselkedés (pl. érvénytelen API URL → API kikapcsolva; ismeretlen framework → standalone; érvénytelen teleport zóna → kihagyva). Soha nem vált engedékenyebb módra.
* A `Config.Modules` és a távoli felülírások a sémán mennek át: típus, tartomány, enum, lista elemformátum (`[A-Za-z0-9_:.-]`), ismeretlen kulcsok tiltva, kliensoldali modul nem állítható `ban`-ra, a küszöbök sorrendje (`warn ≤ monitor ≤ kick ≤ ban`) kötelező.
* Hibás **távoli** konfigurációt a resource **egészében** elutasít (nem alkalmaz félig), megtartja az előzőt, és `config_rejected` rendszereseményt küld. A backend ugyanezt a validációt már mentéskor elvégzi (422 + mezőnkénti hiba).
* Konfigurációs változás optimista zárolással (`expectedVersion`) történik; minden verzió visszaállítható (*Anticheat beállítások → Verziótörténet*).

## `config/config.lua` főbb kulcsai

| Kulcs | Alapérték | Leírás |
|---|---|---|
| `Config.Framework` | `'auto'` | `auto` / `esx` / `qbcore` / `standalone` |
| `Config.Debug` | convar `milcsoguard_debug` | Részletes naplózás (pl. kihagyott ellenőrzések oka) |
| `Config.Api.url` | convar `milcsoguard_api_url` | HTTPS kötelező (kivéve localhost fejlesztéshez) |
| `Config.Api.timeoutMs` | 8000 | Kérés időtúllépés |
| `Config.Api.heartbeatSeconds` | 30 | Online lista + statisztika |
| `Config.Api.commandPollSeconds` | 5 | Web → játék parancsok lekérdezése (min. 2) |
| `Config.Api.banSyncSeconds` | 60 | Delta ban-szinkron |
| `Config.Api.maxQueue` | 2000 | Kimenő sor mérete (KVP-ben perzisztálva); teli sornál a legrégebbi detektálás esik ki, ban soha |
| `Config.Api.excludeIdentifierTypes` | `{'ip'}` | Ezek az azonosítók nem hagyják el a szervert |
| `Config.Permissions.sources` | `ace, framework, backend` | Admin jog forrásai |
| `Config.Permissions.framework` | ESX / QB leképezés | csoport → szerepkör |
| `Config.Permissions.bypass` | szint ≥ 60, mozgás/godmode/láthatatlanság/spectate | Admin eszközök miatti kivétel |
| `Config.Permissions.command` / `keybind` | `anticheat` / `''` | Panel megnyitása |
| `Config.Bans.requireIdentifiers` | `{'license'}` | Ezek nélkül nem lehet csatlakozni (különben a ban nem tapadna) |
| `Config.Bans.failOpen` | `true` | Backend kiesésekor az ismeretlen játékos beléphet (a gyorsítótárazott bannolt nem) |
| `Config.Bans.useTokens` | `true` | Hardver tokenek gyűjtése (egyezéshez a szerveren külön engedélyezni kell) |
| `Config.Risk.severityPoints` | 0/5/15/35/60 | Pont súlyosságonként |
| `Config.Risk.sourceMultiplier` | kliens 0.5 | Forrás szerinti súly |
| `Config.Detections.dedupSeconds` | 10 | Ugyanaz a detektálás ugyanattól a játékostól összevonva |
| `Config.Detections.notifyAdminsMinSeverity` | `MEDIUM` | In-game admin értesítés küszöbe |
| `Config.Grace.*` | join 25 s, respawn 8 s, modellváltás 6 s, bucket 6 s | Türelmi idő a mozgás/állapot ellenőrzésekhez |
| `Config.TeleportZones` | üres | `{x, y, z, radius}` – itt induló/végződő teleport nem jelez |
| `Config.Performance.*` | mozgás 1000 ms, állapot 2500 ms, fegyver 3000 ms, batch 24 | Ütemezés; a játékosok kötegekben, időben elosztva |
| `Config.TrustedResources` | üres | Entitást spawnolhat (a dashboard whitelistjével egyesítve) |
| `Config.Modules` / `Config.RiskOverrides` | üres | Helyi felülírások (validálva) |

A modulok teljes listája paraméterekkel: [DETECTIONS.md](DETECTIONS.md).

## Kockázati beállítások (dashboardról is)

| Kulcs | Alap | Leírás |
|---|---|---|
| `halfLifeMinutes` | 30 | Kockázat felezési ideje |
| `warn/monitor/kick/banThreshold` | 25 / 45 / 80 / 140 | Eszkalációs küszöbök |
| `minDistinctServerTypesForBan` | 2 | Ennyi független szerveroldali jelzéstípus kell auto-banhoz |
| `autoBanEnabled` | true | Globális kapcsoló – kikapcsolva minden ban kickre módosul |
| `autoBanDurationHours` | 720 | Automatikus ban hossza (0 = végleges) |
| `breakerMaxBans` / `breakerWindowMinutes` | 5 / 10 | Circuit breaker |
| `monitorMinutes` | 30 | Megfigyelés hossza |

**Javaslat éles indításhoz:** az első 1-2 hétben állítsd `autoBanEnabled = false`-ra, figyeld a *Statisztika → téves riasztási arány* mutatót, hangold a küszöböket, és csak utána kapcsold vissza.

## Backend környezeti változók

Lásd `backend/.env.example` (minden változó induláskor validálva; hiányzó/hibás érték esetén a backend el sem indul, a hibát mezőnként kiírja).

| Változó | Megjegyzés |
|---|---|
| `DATABASE_URL` | PostgreSQL kapcsolat |
| `APP_ENCRYPTION_KEY` | 32 bájt base64. A TOTP titkok és a Discord webhook titkosítása. **Elvesztése = a 2FA-t újra kell állítani, a webhookot újra megadni.** |
| `WEB_DIST_DIR` | A dashboard build könyvtára (azonos origin → nincs szükség CORS-ra) |
| `CORS_ORIGINS` | Csak ha a dashboard másik originen fut |
| `TRUST_PROXY`, `COOKIE_SECURE` | Reverse proxy mögött `true` |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | Munkamenet lejárat |
| `RATE_LIMIT_PER_MINUTE`, `LOGIN_RATE_LIMIT`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES` | Rate limit és zárolás |
| `RETENTION_JOB_MINUTES` | Karbantartó job gyakorisága |
| `GAME_HEARTBEAT_STALE_SECONDS` | Ennyi heartbeat nélkül a szerver offline |
| `ALLOW_INSECURE_GAME_HTTP` | Csak fejlesztéshez; produkcióban tiltott (a backend nem indul) |

## Adatmegőrzés

Szerverenként (*Szerver* oldal): detektálások, audit, rendszeresemények, munkamenetek napokban. Banhoz csatolt detektálás és maguk a banok nem törlődnek automatikusan. Lásd [BACKUP.md](BACKUP.md).
