# Frissítés és rollback

## Verziókompatibilitás

A FiveM resource és a backend **együtt** adandó ki (azonos verziószám, `fxmanifest.lua` → `version`, `backend/package.json` → `version`). A backend a resource által küldött sémát validálja; ha egy új resource új modult hoz, a régi backend is elfogadja (a séma a resource-ból jön), de egy régebbi backend szigorúbb validációja elutasíthat új paramétertípust → először mindig a **backendet** frissítsd.

## Frissítés lépései

1. **Backup** ([BACKUP.md](BACKUP.md)) – adatbázis dump + `APP_ENCRYPTION_KEY` megvan-e.
2. Backend:
   ```bash
   git pull                       # vagy új kiadás kicsomagolása
   docker compose up -d --build   # a konténer induláskor lefuttatja a migrációkat (advisory lockkal, több példány esetén is biztonságos)
   docker compose logs api | grep migrate
   ```
   Kézi telepítésnél: `npm ci && npm run build && npm run migrate:prod`, majd a szolgáltatás újraindítása.
3. Web: a Docker image tartalmazza; kézi telepítésnél `cd web && npm ci && npm run build` (újraindítás nem kell).
4. FiveM resource: cseréld le a `milcsoguard` mappát, **a saját `config/config.lua`-dat tartsd meg** (vesd össze az újjal – új kulcsok lehetnek), majd `restart milcsoguard`. A helyi ban-gyorsítótár és a kimenő sor KVP-ben van, a restart túléli.
5. Ellenőrzés: *Rendszerállapot* → resource verzió, séma, heartbeat; `milcsoguard status`.

## Rollback

* **Konfiguráció:** *Anticheat beállítások → Verziótörténet → Visszaállítás* (új verzióként menti, auditálva).
* **Resource:** az előző kiadás mappájának visszamásolása + `restart milcsoguard`.
* **Backend kód:** az előző image/tag visszaállítása. Ha a frissítés migrációt is futtatott, és az új séma nem kompatibilis a régi kóddal:
  ```bash
  # 1) ellenőrizd, melyik migráció az utolsó
  psql "$DATABASE_URL" -c 'SELECT * FROM schema_migrations ORDER BY id DESC LIMIT 3;'
  # 2) a legutolsó visszavonása (minden migrációnak van .down.sql párja)
  npm run migrate:down
  ```
  **Figyelem:** a `001_init.down.sql` az egész sémát törli. Down migrációt csak friss backup után futtass; éles adatnál a backupból való visszaállítás (BACKUP.md) a biztonságosabb rollback.

## Kulcsrotáció

* **API-kulcs:** *API-kulcsok → Rotálás* → az új kulcs a `server.cfg`-be, `restart milcsoguard`. A régi 60 percig még érvényes.
* **APP_ENCRYPTION_KEY:** jelenleg nincs automatikus újratitkosítás; csere után a TOTP-t a felhasználóknak újra be kell állítaniuk, a Discord webhookot újra megadni. (Ismert hiányosság.)
