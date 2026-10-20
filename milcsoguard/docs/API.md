# API dokumentáció (v1)

Alap URL: `https://<backend>/api/v1`. Minden válasz JSON. Hibaformátum:

```json
{ "error": { "code": "bad_request|unauthorized|forbidden|not_found|conflict|unprocessable|rate_limited|internal", "message": "…", "details": [{ "path": "modules.movement.teleport.params.maxDistanceOnFoot", "message": "must be between 30 and 2000" }] } }
```

| HTTP | Jelentés |
|---|---|
| 400 | Validációs hiba (zod; `details` mezőnként) |
| 401 | Nincs / lejárt munkamenet, hibás API-kulcs |
| 403 | Hiányzó jogosultság, CSRF hiba, MFA vagy jelszócsere szükséges, HTTPS kötelező (játék API, produkció) |
| 404 | Nem létezik **vagy nem vagy tagja** a szervernek (szándékosan nem 403) |
| 409 | Ütközés (pl. már feloldott ban, régi konfigurációs verzió) |
| 422 | Konfiguráció nem felel meg a sémának |
| 429 | Rate limit |

## Hitelesítés

### Web (dashboard)
* `POST /auth/login` `{login, password}` → httpOnly, `SameSite=Strict` session cookie (`__Host-mg_session` HTTPS alatt) + `{ mfaRequired, csrfToken }`.
* Minden nem-GET kéréshez kötelező az `x-csrf-token` fejléc (értéke a `csrfToken`, a `GET /auth/me` is visszaadja).
* Ha `mfaRequired`, a munkamenet csak a `POST /auth/mfa {code}`, `/auth/me`, `/auth/logout` végpontokat érheti el.
* Ha `mustChangePassword`, csak a `POST /auth/password` (és me/logout) érhető el.
* Munkamenet: tétlenségi lejárat (`SESSION_IDLE_MINUTES`, alap 120) és abszolút lejárat (`SESSION_ABSOLUTE_HOURS`, alap 72). A DB csak a token SHA-256 hash-ét tárolja.
* Login: per-IP rate limit (`LOGIN_RATE_LIMIT`/5 perc) + fiókzárolás (`LOGIN_MAX_ATTEMPTS` hibás próbálkozás után `LOGIN_LOCK_MINUTES`). Ismeretlen felhasználó / rossz jelszó / zárolt fiók ugyanazt az üzenetet kapja.

### Játékszerver
* `Authorization: Bearer mgk_<prefix>_<secret>` – a backend csak `sha256(kulcs)`-ot tárol. Visszavonás azonnali, rotáció türelmi idővel.
* Produkcióban csak HTTPS-en fogad (reverse proxy mögött `TRUST_PROXY=true` kell, hogy az `X-Forwarded-Proto` számítson).
* Rate limit kulcsonként (nem IP-nként).

## Web végpontok

Jelölés: 🔐 = bejelentkezés kell; a jogosultság a szerver szerepköréből jön.

### Auth & profil
| Metódus | Útvonal | Leírás |
|---|---|---|
| POST | `/auth/login` | Belépés |
| POST | `/auth/mfa` | TOTP kód ellenőrzése |
| POST | `/auth/logout` 🔐 | Munkamenet visszavonása |
| GET | `/auth/me` 🔐 | Felhasználó, szerverek, szerepkörök, jogosultságok, CSRF token |
| POST | `/auth/password` 🔐 | Jelszócsere (min. 12, kis/nagybetű, szám); a többi munkamenet kijelentkezik |
| POST | `/auth/totp/setup` 🔐 | Titkos kulcs + otpauth URI (titkosítva tárolva) |
| POST | `/auth/totp/enable` 🔐 | `{code}` |
| POST | `/auth/totp/disable` 🔐 | `{password, code}` |
| GET / DELETE | `/auth/sessions`, `/auth/sessions/:id` 🔐 | Saját munkamenetek listázása / megszüntetése |
| GET / POST / DELETE | `/auth/identifiers[/:identifier]` 🔐 | FiveM azonosító kötése a fiókhoz (játékon belüli jogokhoz) |
| GET | `/permissions` 🔐 | Jogosultság-katalógus leírással |

### Szerverek, tagok, szerepkörök
| Metódus | Útvonal | Jog |
|---|---|---|
| GET | `/servers` | tag |
| POST | `/servers` `{name, slug, description}` | platform admin |
| GET | `/servers/:serverId` | tag |
| PATCH | `/servers/:serverId` `{name?, description?, banMatchTypes?, retention?}` | `servers.manage` |
| DELETE | `/servers/:serverId` `{confirmSlug}` | `servers.manage` (soft delete, kulcsok visszavonása) |
| GET | `/servers/:serverId/roles` | `admins.view` |
| POST / PUT / DELETE | `/servers/:serverId/roles[/:roleId]` | `roles.manage` (eszkaláció ellen védve) |
| GET | `/servers/:serverId/members` | `admins.view` |
| POST | `/servers/:serverId/members` `{email, username, roleId}` | `admins.manage` → új fióknál egyszeri `temporaryPassword` |
| PATCH / DELETE | `/servers/:serverId/members/:userId` | `admins.manage` |

### Detektálások, játékosok, banok
| Metódus | Útvonal | Jog |
|---|---|---|
| GET | `/servers/:serverId/detections?page&pageSize&q&type&module&severity&minSeverity&source&review&playerId&identifier&from&to` | `detections.view` |
| GET | `/servers/:serverId/detections/:id` | `detections.view` |
| POST | `/servers/:serverId/detections/:id/review` `{status: confirmed\|false_positive\|dismissed\|pending, note}` | `detections.review` |
| GET | `/servers/:serverId/detections-meta` | `detections.view` |
| GET | `/servers/:serverId/players/online` | `players.view` |
| GET | `/servers/:serverId/players?page&q&flagged` | `players.view` |
| GET | `/servers/:serverId/players/:playerId` | `players.view` (+ `players.identifiers` a teljes azonosítókhoz) |
| PATCH | `/servers/:serverId/players/:playerId` `{notes}` | `players.view` + `detections.review` |
| POST | `/servers/:serverId/players/:playerId/kick` `{reason}` | `players.kick` |
| GET | `/servers/:serverId/bans?status=active\|expired\|revoked\|all&q&review&source` | `bans.view` |
| GET | `/servers/:serverId/bans/:banId` | `bans.view` (detektálások + teljes előzmény) |
| POST | `/servers/:serverId/bans` `{playerId? \| identifiers[], playerName?, reason, durationSeconds \| null, detectionIds?}` | `bans.create`; `null` = végleges → `bans.permanent` |
| POST | `/servers/:serverId/bans/:banId/revoke` `{reason}` | `bans.remove` |
| POST | `/servers/:serverId/bans/:banId/review` `{status: under_review\|upheld\|overturned, note}` | `bans.remove` (overturned = feloldás) |

A ban a játékos **összes ismert azonosítóját** tiltja (IP soha). Ha egy bannolt azonosítóval új azonosító is megjelenik csatlakozáskor, az a banhoz kerül (ban-kijátszás elleni védelem, auditálva).

### Whitelist, audit, statisztika, rendszer, konfiguráció, integrációk
| Metódus | Útvonal | Jog |
|---|---|---|
| GET / POST | `/servers/:serverId/whitelist` `{kind: player\|resource\|model, value, modules[], note, expiresAt}` | `whitelist.view` / `whitelist.manage` |
| DELETE | `/servers/:serverId/whitelist/:id` | `whitelist.manage` |
| GET | `/servers/:serverId/audit?page&action&actor&actorType&targetType&targetId&from&to` | `audit.view` (nincs módosító végpont) |
| GET | `/servers/:serverId/stats` | `detections.view` |
| GET | `/servers/:serverId/analytics?days=1..365` | `analytics.view` |
| GET | `/servers/:serverId/system`, `/system/events` | `system.view` |
| GET | `/servers/:serverId/config` | `settings.view` (séma + felülírások + verziótörténet) |
| PUT | `/servers/:serverId/config` `{overrides, expectedVersion, note}` | `settings.manage` (optimista zárolás, sémavalidáció) |
| POST | `/servers/:serverId/config/rollback` `{version, expectedVersion}` | `settings.manage` |
| GET / POST | `/servers/:serverId/api-keys` `{name, expiresInDays?}` | `apikeys.manage` (a titok egyszer látszik) |
| POST | `/servers/:serverId/api-keys/:keyId/revoke`, `/rotate {graceMinutes}` | `apikeys.manage` |
| GET | `/servers/:serverId/integrations` | `integrations.manage` (a webhook URL soha nem jön vissza) |
| PUT | `/servers/:serverId/integrations/discord` `{enabled, minSeverity, webhookUrl?}` | `integrations.manage` |
| POST | `/servers/:serverId/integrations/discord/test` | `integrations.manage` |
| GET | `/servers/:serverId/stream` | tag – Server-Sent Events, eseményenként jogosultság szerint szűrve |

SSE események: `detection.created`, `detection.reviewed`, `ban.created`, `ban.revoked`, `players.changed`, `server.status`, `config.changed`, `whitelist.changed`. A payload csak azonosítókat és összefoglalót tartalmaz; a kliens újratölti a részleteket.

## Játékszerver végpontok (`/api/v1/game`, API-kulcs)

| Metódus | Útvonal | Leírás |
|---|---|---|
| POST | `/handshake` | Verzió, framework, függőségek, **beállítás-séma** és effektív konfiguráció jelentése → konfiguráció, whitelist, ban-egyezési típusok |
| POST | `/heartbeat` | Online játékosok (net ID, név, azonosítók IP nélkül, ping, kockázat), resource-állapot, statisztika → konfigurációs verzió |
| POST | `/players/connect` | Ban-ellenőrzés csatlakozáskor + kötött webes admin + whitelist |
| POST | `/players/joined`, `/players/dropped` | Munkamenet nyitás / zárás |
| POST | `/detections` `{detections: [...≤100]}` | Idempotens (`localId`), bizonyíték ≤16 KB, időbélyeg korlátozva |
| GET | `/bans/sync?since=ISO` | Teljes vagy delta ban-szinkron (`bans`, `inactive`) |
| POST | `/bans` | Játékon belüli / automatikus ban (`localId` idempotens, `ageSeconds` = sorban töltött idő) |
| POST | `/bans/:banId/revoke` | Játékon belüli feloldás |
| GET | `/config` | Felülírások + whitelist |
| GET | `/commands`, POST `/commands/:id/ack` | Web → játék parancssor (kick, ban_sync, config_sync, announce_admins) |
| POST | `/system-events` | Resource leállás, elutasított konfiguráció stb. |
| GET/POST/PUT | `/admin/*` | Az in-game panel adatai; minden módosító kérés `actor`-t küld, amit a backend auditál, és ha webes fiókhoz kötött, a webes szerepkör szerint is ellenőriz |

## Health
* `GET /healthz` – a folyamat él.
* `GET /readyz` – adatbázis elérhető és migrált (503 különben).
* `GET /api/v1/health` – DB késleltetéssel.
