# MilcsoGuard – szerveroldali FiveM anticheat

Saját márkájú, moduláris FiveM anticheat: **szerveroldali döntéshozó resource**, **játékon belüli adminpanel**, **webes dashboard**, **backend API + PostgreSQL**, ban-, whitelist-, jogosultság- és auditrendszer, **POV visszajátszás** (a bannolt játékos saját nézete a ban előtti utolsó ~15 másodpercből).

> A „MilcsoGuard” munkanév – név, logó és színek: `web/src/brand.ts`, `web/src/styles.css` (`:root`), `fivem/milcsoguard/nui/brand.js`, `config/config.lua` (`Config.Brand`).

## Alapelvek

* **A kliens nem megbízható.** A döntések a szerveren születnek; kliensoldali jel önmagában *kódszinten* nem okozhat bant.
* **A backend kiesése nem gyengíti a védelmet és nem okoz tömeges bant** – helyi ban-gyorsítótár (KVP), perzisztens kimenő sor, fail-open csatlakozás.
* **Automatikus ban csak alátámasztva**: ≥2 független szerveroldali jel vagy perdöntő szerveroldali jel, circuit breakerrel.
* **Minden adminművelet auditált**, a jogosultságot a backend *és* a FiveM szerver is ellenőrzi.
* **Nincs rejtett adatgyűjtés**: nincs fájlrendszer-, folyamat- vagy képernyőhozzáférés a játékos gépén; az IP nem hagyja el a szervert.

## Összetevők

| Mappa | Tartalom |
|---|---|
| [`fivem/milcsoguard`](fivem/milcsoguard) | FiveM resource (Lua 5.4): 27 detektálási modul, risk engine, ban store, ESX/QBCore/ox_inventory bridge, NUI adminpanel (11 oldal: ban/kick/feloldás, offline ban, spectate, odamegyek/idehozom, fagyasztás, üzenet, visszajátszás kérése és lejátszása), POV felvevő |
| [`backend`](backend) | Node.js 22 + TypeScript + Fastify 5 + PostgreSQL: auth (session + CSRF + TOTP), RBAC, játék API, SSE, Discord riasztás, retention |
| [`web`](web) | React 19 + TypeScript + Vite dashboard (sötét téma, reszponzív, élő frissítés) |
| [`tests`](tests) | Lua tesztek FXServer mockkal, szerződésteszt élő backend ellen, Playwright e2e (NUI + web) |
| [`docs`](docs) | dokumentáció |

## Gyors indítás

```bash
cp .env.example .env            # POSTGRES_PASSWORD, APP_ENCRYPTION_KEY (openssl rand -base64 32)
docker compose up -d --build
docker compose exec api node dist/scripts/create-owner.js --email you@example.com --username owner
```

Majd: dashboard → szerver létrehozása → API-kulcs → `server.cfg` (`set milcsoguard_api_url`, `set milcsoguard_api_key`, `ensure milcsoguard`). Részletek: [docs/INSTALL.md](docs/INSTALL.md).

## Dokumentáció

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | projektfelmérés, architektúra, bizalmi modell, ellenőrzött API-k |
| [INSTALL.md](docs/INSTALL.md) | telepítés (Docker / kézi), FiveM beállítás |
| [REPLAY.md](docs/REPLAY.md) | POV visszajátszás: működés, korlátok, beállítások, adatvédelem |
| [RENDER.md](docs/RENDER.md) | telepítés Renderre (`render.yaml`), Cloudflare domain |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | konfigurációs rétegek, validáció, minden kulcs |
| [DETECTIONS.md](docs/DETECTIONS.md) | modulok, **mit tud és mit nem**, exportok, ajánlott convarok |
| [PERMISSIONS.md](docs/PERMISSIONS.md) | jogosultsági mátrix, eszkalációvédelem, in-game jogok |
| [API.md](docs/API.md) | REST + SSE + játék API |
| [SECURITY.md](docs/SECURITY.md) | biztonsági ellenőrzőlista és ismert korlátok |
| [TESTING.md](docs/TESTING.md) | automatikus tesztek és kézi tesztterv |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | hibakeresés |
| [UPGRADE.md](docs/UPGRADE.md) | frissítés és rollback |
| [BACKUP.md](docs/BACKUP.md) | backup/restore, adatmegőrzés |

## Tesztállapot (2026-10-20)

| Csomag | Eredmény |
|---|---|
| Backend (Vitest, valódi PostgreSQL 16) | 79 / 79 ✅ |
| Lua unit + integráció (FXServer mock, FiveM saját `json.lua`) | 104 / 104 ✅ |
| Lua resource ↔ élő backend szerződésteszt | 7 / 7 ✅ |
| NUI panel e2e (headless Chromium) | 22 / 22 ✅ |
| NUI felvevő + új admin eszközök e2e (valódi MediaRecorder) | 36 / 36 ✅ |
| Web dashboard e2e (élő backend) | 38 / 38 ✅ |
| Web visszajátszás e2e (élő backend, valódi WebM) | 21 / 21 ✅ |
| Web unit | 3 / 3 ✅ |

## Amit őszintén tudni kell

* **Nem futott valódi FXServeren.** A fejlesztői környezetben nem volt FiveM szerver; a resource egy FXServer mockon és élő backend ellen lett tesztelve. A natívok és eventek létezését és mezőit a `citizenfx/fivem` forrásból ellenőriztük, de a küszöbértékeket (sebesség, távolság, minták) **saját tesztszerveren kalibrálni kell** – ezért alapból a legtöbb mozgás-modul csak figyelmeztet.
* **POV visszajátszás:** a játékkép kiolvasása a CitizenFX hivatalos `screenshot-basic` módszerével történik, és valódi FiveM kliensen működik (az automatikus tesztekben, headless Chromiumban fekete a kép, ott csak a felvétel/feltöltés/lejátszás ellenőrizhető). A felvevő a játékos gépén fut, egy csaló blokkolhatja; a felvétel bizonyíték, nem perdöntő. Részletek: [REPLAY.md](docs/REPLAY.md).
* **A Docker image buildje nem lett lefuttatva** (nem volt Docker daemon); a produkciós Node build igen.
* **Nincs implementálva:** screenshot bizonyíték, aimbot statisztikai elemzés, memória/injektor detektálás (szándékosan), `APP_ENCRYPTION_KEY` rotáció, WebAuthn.
* **FiveM korlát:** más resource-ok net eventjeire nincs globális hook – ezeket a `CheckEvent` exporttal kell bekötni.
* Kliensoldali kód (a MilcsoGuard kliens része is) **manipulálható** – ezért csak jelzésként használjuk.
