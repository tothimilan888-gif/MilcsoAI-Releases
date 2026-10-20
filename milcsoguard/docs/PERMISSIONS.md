# Jogosultsági mátrix

A táblázat a kódból generált (`backend/src/lib/permissions.ts` → `SYSTEM_ROLES`), a FiveM oldali megfelelő a `config/config.lua` → `Config.Roles`.

| Jogosultság | Leírás | Owner (100) | Developer (90) | Server Manager (80) | AdminController (70) | Administrator (60) | Moderator (40) | Viewer (10) |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `players.view` | Játékosok listázása és profiljuk megtekintése | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `players.identifiers` | Teljes azonosítók (license, discord, steam…) megtekintése | ✅ | ✅ | ✅ | ✅ | ✅ | – | – |
| `players.kick` | Játékos kickelése | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | – |
| `players.moderate` | Játékon belüli admin eszközök: fagyasztás, teleport, spectate, üzenet | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | – |
| `replays.view` | POV visszajátszások megtekintése | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | – |
| `replays.request` | POV visszajátszás kérése egy online játékostól (utolsó másodpercek) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | – |
| `detections.view` | Detektálások megtekintése | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `detections.review` | Detektálások felülvizsgálata, téves riasztás jelölése | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | – |
| `bans.view` | Banok megtekintése | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `bans.create` | Időszakos ban kiadása | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | – |
| `bans.permanent` | Végleges ban kiadása | ✅ | ✅ | ✅ | ✅ | ✅ | – | – |
| `bans.remove` | Ban feloldása | ✅ | ✅ | ✅ | ✅ | ✅ | – | – |
| `whitelist.view` | Whitelist megtekintése | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `whitelist.manage` | Whitelist bejegyzések kezelése | ✅ | ✅ | ✅ | ✅ | ✅ | – | – |
| `admins.view` | Adminok listázása | ✅ | ✅ | ✅ | ✅ | – | – | – |
| `admins.manage` | Adminok hozzáadása, szerepkör módosítása (csak alacsonyabb szintig) | ✅ | ✅ | ✅ | ✅ | – | – | – |
| `roles.manage` | Egyedi szerepkörök kezelése | ✅ | ✅ | – | – | – | – | – |
| `settings.view` | Anticheat konfiguráció megtekintése | ✅ | ✅ | ✅ | ✅ | ✅ | – | – |
| `settings.manage` | Anticheat konfiguráció módosítása | ✅ | ✅ | ✅ | – | – | – | – |
| `audit.view` | Auditnapló megtekintése | ✅ | ✅ | ✅ | ✅ | – | – | – |
| `analytics.view` | Statisztikák megtekintése | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `system.view` | Rendszerállapot megtekintése | ✅ | ✅ | ✅ | ✅ | ✅ | – | ✅ |
| `apikeys.manage` | Játékszerver API-kulcsok kezelése | ✅ | ✅ | – | – | – | – | – |
| `integrations.manage` | Integrációk (Discord webhook) kezelése | ✅ | ✅ | ✅ | – | – | – | – |
| `servers.manage` | Szerver beállításai, adatmegőrzés, törlés | ✅ | – | – | – | – | – | – |

## Szabályok (backend kényszeríti, nem a frontend)

1. Minden szerverhez kötött végpont a `requireServer(permission)` ellenőrzésen megy át. Nem tag felhasználó **404**-et kap (a szerverazonosítók nem kitalálhatók), tag jogosultság nélkül **403**-at.
2. **Senki nem módosíthatja a saját szerepkörét.**
3. Csak a saját szintje **alatti** tagot lehet módosítani / eltávolítani, és csak a saját szintje **alatti** szerepkör osztható ki (kivétel: Owner).
4. A kiosztott (vagy egyedi) szerepkör **nem tartalmazhat olyan jogot, amivel a kiosztó nem rendelkezik**.
5. Az utolsó Owner nem fokozható le és nem távolítható el.
6. Minden szerepkör- és tagváltozás auditnaplóba kerül (`member.add`, `member.role_change`, `member.remove`, `role.create/update/delete`).
7. Platform admin (telepítés tulajdonosa, `create-owner` script) minden szerveren Owner-ként viselkedik, és csak ő hozhat létre szervert.
8. Végleges banhoz `bans.permanent`, időszakoshoz `bans.create` kell. Az időtartam nélküli ban **soha nem** értelmeződik véglegesnek – a véglegest explicit kérni kell.
9. A játékon belüli eszközök (`players.moderate`) és a visszajátszás-kérés nem használható azonos vagy magasabb szintű adminon (kivétel: Owner, illetve az Odamegyek / Spectate / Üzenet, amik nem hatnak a célpontra). Minden használat auditált (`ingame.player.freeze`, `…goto`, `…bring`, `…spectate`, `…message`, `replay.request`, `replay.view`).

## Játékon belüli jogosultság

Forrásai (`Config.Permissions.sources`), a legmagasabb szint nyer:

| Forrás | Beállítás |
|---|---|
| `ace` | `add_ace group.admin milcsoguard.role.administrator allow` – szerepkör; vagy egyedi jog: `add_ace identifier.license:xxx milcsoguard.perm.bans.create allow` |
| `framework` | ESX csoport (`xPlayer.getGroup()`) vagy QBCore jogosultság (ACE alapú) → szerepkör leképezés a `Config.Permissions.framework`-ben |
| `backend` | A webes fiókhoz kötött FiveM azonosító (Profil → Kötött azonosítók); a webes szerepkör érvényes |

* A kliens soha nem dönt arról, hogy admin-e: a panel csak a szerver utasítására nyílik meg, és **minden kérésnél** friss jogosultság-ellenőrzés fut (`MG.Permissions.refresh`). Egy visszavont ACE azonnal hat.
* Ha a játékon belüli admin webes fiókhoz kötött, a backend **a webes szerepkör szerint is** ellenőrzi a műveletet (pl. egy Moderator nem adhat végleges bant a játékból sem).
* Azonos vagy magasabb szintű admint kickelni/bannolni nem lehet (Owner kivételével).
* A `Config.Permissions.bypass` szerint a ≥60-as szintű adminokra a mozgás-, godmode-, láthatatlanság- és spectate-ellenőrzés nem fut (admin eszközök miatt).
