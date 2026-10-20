# Telepítési útmutató

A rendszer három részből áll: **backend + adatbázis** (Node.js 22, PostgreSQL 14+), **webes dashboard** (a backend szolgálja ki) és a **FiveM resource**. A FiveM resource backend nélkül is véd (local-only mód), de dashboard és központi ban-kezelés csak backenddel van.

## 1. Backend – Docker Compose (ajánlott)

```bash
cd milcsoguard
cp .env.example .env
# .env:
#   POSTGRES_PASSWORD=<erős jelszó>
#   APP_ENCRYPTION_KEY=$(openssl rand -base64 32)   <- MENTSD EL BIZTONSÁGOS HELYRE
docker compose up -d --build
docker compose logs -f api          # "Server listening" + "[migrate] applying 001_init"
```

> Megjegyzés: a fejlesztői környezetben, ahol ez a projekt készült, nem volt Docker daemon, ezért **a Docker image buildje itt nem lett lefuttatva**. A lefordított produkciós build (`npm run build` → `node dist/src/index.js`, `NODE_ENV=production`) viszont tesztelve van. Ha a build hibát jelez, jelezd, és javítjuk.

Az API csak `127.0.0.1:8080`-on hallgat; elé **TLS-t terminező reverse proxy** kell. Caddy példa:

```
ac.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx esetén SSE-hez kapcsold ki a pufferelést az `/api/v1/servers/*/stream` útvonalon (a backend `X-Accel-Buffering: no` fejlécet is küld), és add tovább az `X-Forwarded-Proto` fejlécet.

### Első tulajdonos (platform admin)

```bash
docker compose exec api node dist/scripts/create-owner.js --email you@example.com --username owner
# Ideiglenes jelszót ír ki – első belépéskor kötelező lecserélni.
```

## 1b. Backend – kézi telepítés

```bash
cd milcsoguard/web && npm ci && npm run build
cd ../backend && npm ci && npm run build
cp .env.example .env    # töltsd ki: DATABASE_URL, APP_ENCRYPTION_KEY, WEB_DIST_DIR=../web/dist
set -a && . ./.env && set +a
npm run migrate:prod
node dist/scripts/create-owner.js --email you@example.com --username owner
node dist/src/index.js   # systemd / pm2 alá
```

## 2. Szerver és API-kulcs

1. Lépj be a dashboardra (`https://ac.example.com`), cseréld le a jelszót, **kapcsold be a 2FA-t** (Profil).
2. `+ Szerver` → név + azonosító.
3. *API-kulcsok és integrációk* → **Kulcs generálása**. A kulcs **csak egyszer** látszik.

## 3. FiveM resource

1. Másold a `fivem/milcsoguard` mappát a szerver `resources` könyvtárába (pl. `resources/[security]/milcsoguard`).
2. `server.cfg`:

```cfg
set onesync on
set sv_entityLockdown relaxed

# Titkok: csak 'set' (NEM 'setr', az a kliensekhez is eljut!)
set milcsoguard_api_url "https://ac.example.com"
set milcsoguard_api_key "mgk_xxxxxxxxxx_...."

# Admin jogok (példa)
add_ace group.admin milcsoguard.role.administrator allow
add_principal identifier.license:XXXXXXXX group.admin

# a framework (es_extended / qb-core) és az ox_inventory UTÁN
ensure milcsoguard
```

3. Indítás után a konzolban:

```
[MilcsoGuard:info] MilcsoGuard v1.0.0 starting (artifact ...)
[MilcsoGuard:info] framework: esx, inventory: ox
[MilcsoGuard:info] connected to backend as "..." (config v0)
[MilcsoGuard:info] ready: 27 module(s) enabled, 0 cached ban(s), framework esx, API enabled
```

Konzol parancsok: `milcsoguard status`, `milcsoguard sync`, `milcsoguard unban <banId> [ok]`. Játékban: `/anticheat` (vagy `Config.Permissions.keybind`).

## 4. Ellenőrzés

* Dashboard → *Rendszerállapot*: a játékszerver online, a séma „megérkezett”, a resource verzió látszik.
* Csatlakozz a szerverre → *Játékosok* → Online.
* Állíts be Discord webhookot (*Integrációk*) és küldj tesztet.
* Futtasd le a [TESTING.md](TESTING.md) kézi ellenőrzőlistáját **saját tesztszerveren**.

## Függőségek

| Függőség | Kötelező? | Megjegyzés |
|---|---|---|
| OneSync | **igen** a szerveroldali ellenőrzésekhez | Nélküle csak a csatlakozási banok, kliensjelzések és a panel működik – a resource hangosan jelzi |
| es_extended / qb-core | nem | auto-detektálás; csoport → szerepkör leképezés, inventory ellenőrzés |
| ox_inventory | nem | fegyver-inventory ellenőrzés, `createItem` hook |
| ox_lib, oxmysql | nem | jelenlétük megjelenik a rendszerállapotban, de a resource nem használja őket (a perzisztencia KVP + backend) |
| screenshot-basic | nem | jelenleg **nincs** integrálva |
