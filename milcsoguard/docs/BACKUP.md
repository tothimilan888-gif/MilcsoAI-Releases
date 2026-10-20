# Backup, visszaállítás és adatmegőrzés

## Mit kell menteni

| Mit | Hol | Miért |
|---|---|---|
| PostgreSQL adatbázis | `pgdata` volume / DB szerver | banok, detektálások, audit, felhasználók, konfiguráció |
| `APP_ENCRYPTION_KEY` | `.env` | nélküle a TOTP titkok és a Discord webhook nem fejthetők vissza |
| `fivem/milcsoguard/config/config.lua` | FiveM szerver | helyi beállításaid |
| FiveM resource KVP | FXServer cache | helyi ban-gyorsítótár és kimenő sor – a backendből újraépül, mentése opcionális |

A `.env` és a backup **titkos adat** (jelszó-hash-ek, munkamenet-hash-ek, azonosítók). Titkosítva, hozzáférés-korlátozva tárold.

## Mentés

```bash
# Docker Compose
docker compose exec -T db pg_dump -U milcsoguard -d milcsoguard -Fc > milcsoguard-$(date +%F).dump
# napi cron + legalább 7 napi / 4 heti megőrzés, másik gépen / tárhelyen
```

## Visszaállítás (ellenőrizd rendszeresen egy teszt adatbázison!)

```bash
docker compose stop api
docker compose exec -T db dropdb -U milcsoguard milcsoguard
docker compose exec -T db createdb -U milcsoguard milcsoguard
docker compose exec -T db pg_restore -U milcsoguard -d milcsoguard --no-owner < milcsoguard-2026-10-20.dump
docker compose start api      # a migrátor csak a hiányzó migrációkat futtatja
```

Visszaállítás után a játékszerverek a következő teljes ban-szinkronnál (`milcsoguard sync` vagy restart) frissítik a helyi gyorsítótárat.

## Törölt szerver visszaállítása

A szervertörlés soft delete (`servers.deleted_at`), az adatok megmaradnak:

```sql
UPDATE servers SET deleted_at = NULL WHERE slug = 'a-szerver-slugja';
-- az API-kulcsok vissza lettek vonva: generálj újat a dashboardon
```

## Adatmegőrzés (retention)

Szerverenként állítható (*Szerver* oldal). A karbantartó job (`RETENTION_JOB_MINUTES`, alap 60 perc):

* törli a megőrzési időn túli detektálásokat – **kivéve a banhoz csatoltakat**,
* törli a régi auditnaplót, rendszereseményeket, lezárt játékos-munkameneteket,
* törli a lejárt/visszavont webes munkameneteket (7 nap után) és a régi parancsokat,
* lejártra állítja az időszakos banokat (percenként).

Banok és ban-előzmények nem törlődnek automatikusan. Egy játékos adatainak kézi törlése (adatvédelmi kérés):

```sql
-- a játékos összes adatának törlése egy szerveren (a banok player_id-ja NULL lesz, a ban megmarad)
DELETE FROM players WHERE id = '<player uuid>' AND server_id = '<server uuid>';
-- figyelem: a detections.identifiers mezőben az azonosítók szövegként megmaradnak; ha azokat is törölni kell:
-- DELETE FROM detections WHERE server_id = '<server uuid>' AND identifiers ?| array['license:...'];
```
