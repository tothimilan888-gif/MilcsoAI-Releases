# Telepítés Renderre (lépésről lépésre)

A repó gyökerében lévő `render.yaml` egy **Docker web szolgáltatást** (API + dashboard egy URL-en) és egy **PostgreSQL adatbázist** hoz létre.

> **Állapot:** a `render.yaml` a Blueprint dokumentált szintaxisa alapján készült, de **élő Render fiókon nem lett kipróbálva** (a fejlesztői környezetből a Render nem érhető el, és Docker daemon sem volt). A Dockerfile lépéseit (npm ci → build → prune → indítás) tiszta másolaton lefuttattam, és a kapott alkalmazást Renderhez hasonló beállításokkal (production, `PORT=10000`, `X-Forwarded-Proto`, bootstrap owner) elindítva ellenőriztem. Ha a deploy hibát ad, a build/deploy logot küldd el.

## 1. Előkészület
* Render fiók, a GitHub repó (`tothimilan888-gif/MilcsoAI-Releases`, a MilcsoGuard ágát vagy `main`-t építsd) csatlakoztatva a Renderhez.
* **Fizetős csomag kell.** Az ingyenes web szolgáltatás tétlenség után elalszik, a játékszerver heartbeatje/parancssora pedig állandó forgalmat vár; az ingyenes adatbázis lejár. A `render.yaml` ezért `starter` webet és fizetős Postgrest kér – az aktuális csomagneveket / árat a Render oldalán ellenőrizd.

> A repó gyökerében van egy `Dockerfile`, így Renderen **nem kell Dockerfile-útvonalat vagy build contextet beállítani**: Language = `Docker`, a többi marad az alapérték (Root Directory üres, Dockerfile Path `./Dockerfile`).

## 2. Deploy
1. Render → **New → Blueprint** → válaszd ki a repót (és az ágat).
2. A Blueprint bekéri a `sync: false` változókat. Töltsd ki **az első deploy előtt**:
   * `BOOTSTRAP_OWNER_EMAIL` – a te e-mail címed
   * `BOOTSTRAP_OWNER_USERNAME` – pl. `owner`
   * `BOOTSTRAP_OWNER_PASSWORD` – erős jelszó (min. 12 karakter, kis/nagybetű, szám). Első belépéskor **kötelező lecserélni**.
3. **Apply**. A build néhány perc. Az indulási log tartalmazza:
   ```
   [migrate] applying 001_init
   [bootstrap] bootstrap owner "owner" created; ...
   Server listening at http://0.0.0.0:10000
   ```
4. A szolgáltatás URL-je: `https://milcsoguard-xxxx.onrender.com` – ez a **web URL** és egyben a FiveM `milcsoguard_api_url`.

## 3. Első belépés után
1. Lépj be, cseréld le a jelszót, a **Profil**-on kapcsold be a 2FA-t.
2. **Töröld a `BOOTSTRAP_OWNER_*` változókat** a Render Environment oldalán (nem árt, ha maradnak – csak akkor hatnak, ha nincs tulajdonos –, de a jelszó ott ne maradjon).
3. **Mentsd el az `APP_ENCRYPTION_KEY` értékét** máshová is (Render → Environment). Nélküle a 2FA titkok és a Discord webhook nem fejthető vissza.
4. `+ Szerver` → név → **API-kulcsok és integrációk → Kulcs generálása** (a kulcs csak egyszer látszik).

## 4. FiveM szerver
Másold a `fivem/milcsoguard` mappát a `resources` könyvtárba, és a `server.cfg`-be (mintafájl: `fivem/server.cfg.example`):

```cfg
set onesync on
set sv_entityLockdown relaxed
set milcsoguard_api_url "https://milcsoguard-xxxx.onrender.com"
set milcsoguard_api_key "mgk_xxxxxxxxxx_..."
ensure milcsoguard        # a framework (es_extended / qb-core) és az ox_inventory UTÁN
```

Indítás után a dashboard *Rendszerállapot* oldalán a játékszerver „online”.

## 5. Saját domain és Cloudflare (opcionális)
* Render → szolgáltatás → **Settings → Custom Domains**: add hozzá pl. `ac.sajatdomain.hu`-t, és állítsd be a CNAME-et a Render által megadott címre.
* Ha a domain DNS-e Cloudflare-nél van: kezdetben a CNAME legyen **„DNS only” (szürke felhő)**, amíg a Render ki nem állítja a tanúsítványt. Utána bekapcsolhatod a proxyt (narancs felhő), de:
  * SSL/TLS mód: **Full (strict)**,
  * az SSE (élő frissítés) hosszú kapcsolat – a Cloudflare ezt támogatja, de ha az élő lista megszakadozik, kapcsold ki a proxyt az adott domainre,
  * a játékszerver a `milcsoguard_api_url`-ben szintén ezt a domaint használja.
* A Cloudflare **Pages/Workers nem alkalmas** a backendnek (hagyományos Node szerver + PostgreSQL + tartós kapcsolatok).

## 6. Üzemeltetés Renderen
| Téma | Teendő |
|---|---|
| Frissítés | `git push` → `autoDeploy`; a migrációk induláskor automatikusan futnak |
| Backup | A Render fizetős Postgres csomagjai napi backupot adnak – ellenőrizd a megőrzési időt; ezen felül időnként `pg_dump` (lásd BACKUP.md) |
| Naplók | Render → Logs (strukturált JSON) |
| Egészség | `/readyz` – ezt használja a Render health checkje |
| 2FA elvesztése | Render → Postgres → Shell/psql: lásd TROUBLESHOOTING.md |
| Költség | web (Starter) + Postgres: a Render árlistájából; a játékszerverenként 1 heartbeat / 30 mp és 1 parancs-lekérdezés / 5 mp elhanyagolható terhelés |

## Hibakeresés Renderen
| Tünet | Ok |
|---|---|
| Build hiba `npm ci` | a `web/` és `backend/` `package-lock.json` hiányzik / nem commitolt |
| Indulás: `APP_ENCRYPTION_KEY must decode to exactly 32 bytes` | A kulcs nem 32 bájtos. Érvényes: `openssl rand -base64 32` vagy `openssl rand -hex 32` kimenete (Windows PowerShell 7: `[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`). Nem lehet kitalált szöveg, és ne legyen előtte/utána szóköz vagy idézőjel. A Renderen a változó megadásakor használhatod a **Generate** gombot is, ha van. |
| Indulás: `Invalid environment configuration` | hiányzó vagy hibás változó – a log mezőnként megmondja |
| `Game API requires HTTPS` | a kérés nem a Render proxyján át érkezett, vagy `TRUST_PROXY` nincs `true`-ra állítva |
| A dashboard betölt, de belépés után kidob | `COOKIE_SECURE=true` mellett csak HTTPS-en működik – használd a `https://` URL-t |
| Az első deploy után nincs owner | a `BOOTSTRAP_OWNER_*` mindhárom változó kell, erős jelszóval; a log `bootstrap owner skipped: ...` sora megmondja az okot |
