# Tesztelési útmutató

> **Csak saját tesztkörnyezetben tesztelj.** Ne futtass detektálási vagy terheléses teszteket mások szerverén, és ne használd a rendszert mások játékosainak megfigyelésére.

## Automatikus tesztek

| Csomag | Parancs | Mit fed le |
|---|---|---|
| Backend (Vitest + valódi PostgreSQL) | `cd backend && npm test` | auth, CSRF, munkamenet-lejárat, 2FA, jelszócsere, lockout, rate limit, RBAC, eszkalációvédelem, több szerver adatszétválasztása, API-kulcs (visszavonás, rotáció), ban / unban / lejárat / ban-kijátszás, idempotens detektálás, hibás kérések, konfiguráció-validáció, parancssor, heartbeat, retention, adatbázis-kiesés, SSE |
| Lua unit + integráció (FXServer mock) | `cd tests/lua && ./run.sh` | risk engine és védőkorlátok, sémavalidáció, mozgáselemzés (legitim mozgás, esés, respawn, lag, attach), sebzés/robbanás/entity szabályok, csatlakozási ban (backend nélkül is), KVP perzisztencia, admin panel jogosultságok, hamis heartbeat, event spam, honeypot, távoli konfiguráció elutasítása, kimenő sor |
| Lua ↔ élő backend (szerződésteszt) | `MG_CONTRACT_URL=http://127.0.0.1:8080 MG_CONTRACT_KEY=mgk_… ./run.sh` | a valódi resource a valódi backenddel: handshake/séma, munkamenetek, detektálások, in-game ban/unban, távoli konfiguráció |
| NUI panel (headless Chromium) | `cd tests/e2e && npm ci && npm run nui` | mind a 10 oldal, XSS, indoklás kötelező, végleges ban explicit, jogosultság szerinti menü |
| Web dashboard e2e | `MG_OWNER_PASSWORD=… MG_KEY=mgk_… npm run web` (futó backend + build) | belépés, SSE élő frissítés, minden oldal, ban/unban → játék oldali hatás, whitelist, konfiguráció, API-kulcs visszavonás, adminfelvétel, mobil nézet, kijelentkezés |
| Web unit | `cd web && npm test` | konfiguráció diff, query string |

Előfeltétel: PostgreSQL egy `milcsoguard_test` adatbázissal (`TEST_DATABASE_URL` felülírható), `lua5.4`, Chromium (`CHROMIUM_PATH`).

**Fontos:** a Lua tesztek egy FXServer **mockon** futnak (natívok, eventek, KVP, HTTP emulálva, a FiveM saját `json.lua`-jával). Ez a logikát és a szerződést ellenőrzi, de **nem helyettesíti a valódi FXServeren végzett tesztet** – a valódi szinkronizált értékek (pl. sebesség, invincible flag) viselkedését csak élesben lehet kalibrálni.

## Kézi tesztterv saját FXServeren

Állíts fel egy tesztszervert (OneSync, framework, MilcsoGuard), és két fiókkal (admin + „tesztjátékos”) menj végig:

### Legitim játékmenet – NEM szabad jeleznie
- [ ] Csatlakozás, karakterválasztás, első spawn (join türelmi idő).
- [ ] Halál → respawn kórházban (respawn türelmi idő, nincs teleport).
- [ ] Gyaloglás, sprint, ugrás, esés magasról, ejtőernyő.
- [ ] Autó vezetése autópályán max. sebességgel; motor; helikopter; repülő.
- [ ] Belépés interiorba ajtón (ha kliensoldali teleport → `TeleportZones`).
- [ ] Admin teleport / noclip / godmode admin eszközzel (bypass ≥60 szinten, vagy `AllowMovement` export).
- [ ] Fegyver vásárlás boltban, használat (inventory mismatch ne jelezzen).
- [ ] Jármű lekérése garázsból (entity spawn – trusted resource / `ExpectEntity`).
- [ ] Resource restart (`restart milcsoguard`) online játékosokkal: nincs tömeges detektálás, a banok megmaradnak.
- [ ] Backend leállítása 10 percre: a szerver fut, senki nem kap bant, a bannolt nem tud belépni, a detektálások a backend visszatérése után megérkeznek.

### Szimulált visszaélés – jeleznie KELL (saját tesztszerveren, saját kliensen)
Használj **saját teszt resource-ot** (ne cheat-szoftvert), ami a vizsgált viselkedést előidézi:
- [ ] `SetEntityCoords` kliensoldalon 2 km-re → `movement.teleport`.
- [ ] `SetPlayerInvincible(PlayerId(), true)` → `player.godmode` 2 minta után.
- [ ] `SetEntityVisible(PlayerPedId(), false)` → `player.invisible`.
- [ ] `GiveWeaponToPed(PlayerPedId(), \`WEAPON_RAILGUN\`)` → `weapons.blacklist` + fegyver elvétele.
- [ ] `AddExplosion` orbital cannon típussal (59) → blokkolva + `explosions.filter`.
- [ ] 20 jármű gyors spawnolása kliensoldalon → `entities.spawn` (flood) blokkolva.
- [ ] A MilcsoGuard kliens leállítása (`stop` egy kliensoldali tesztben nem lehetséges; a heartbeat-et egy teszt resource blokkolásával lehet szimulálni) → `client.heartbeat`.
- [ ] Csapda event (`Config.Modules['events.honeypot']`) triggerelése → ban (circuit breaker figyelembevételével).
- [ ] Ellenőrizd minden esetben: dashboard élő lista, Discord riasztás, auditnapló, és hogy kliensoldali jel **nem** okozott bant.

### Adminműveletek
- [ ] Moderátor: időszakos ban igen, végleges ban nem (panelen és weben is).
- [ ] Moderátor nem tud azonos szintű admint kickelni.
- [ ] ACE visszavonása után a nyitott panel következő kérése elutasítva.
- [ ] Web ban → online játékos azonnal lecsatlakozik (parancssor, ~5 mp).
- [ ] Web unban → a játékos újra csatlakozhat (delta szinkron ~60 mp, vagy azonnal a `ban_sync` paranccsal).
- [ ] Konfiguráció módosítás → a játékszerver alkalmazza (*Rendszerállapot*: szerver vN = backend vN).
