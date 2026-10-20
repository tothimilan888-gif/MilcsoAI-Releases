# Biztonsági ellenőrzőlista

## Telepítés előtt / után

- [ ] A backend **csak TLS mögött** érhető el (Caddy/nginx/Traefik), az API port csak `127.0.0.1`-en hallgat.
- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true` (proxy mögött). Produkcióban `ALLOW_INSECURE_GAME_HTTP` nem engedélyezhető (a backend nem indul el vele).
- [ ] `APP_ENCRYPTION_KEY` véletlen 32 bájt, a repón kívül, backupolva.
- [ ] Erős `POSTGRES_PASSWORD`, az adatbázis nem érhető el kívülről.
- [ ] Az API-kulcs **`set`**-tel van a `server.cfg`-ben (**nem `setr`**), és a `server.cfg` nincs publikus repóban.
- [ ] A platform owner fiókon és minden adminfiókon **be van kapcsolva a 2FA**.
- [ ] Az ideiglenes jelszavak le lettek cserélve (a rendszer kikényszeríti).
- [ ] A szerepkörök a legkisebb szükséges joggal vannak kiosztva (Viewer / Moderator alapértelmezésként).
- [ ] `onesync on`, `sv_entityLockdown relaxed` vagy `strict`, `sv_filterRequestControl 2` ([DETECTIONS.md](DETECTIONS.md)).
- [ ] Az első időszakban `autoBanEnabled = false`, amíg a téves riasztási arány nem ismert.
- [ ] Discord webhook csak zárt csatornába mutat.
- [ ] Rendszeres, **tesztelt** backup ([BACKUP.md](BACKUP.md)).

## Beépített védelmek (implementálva és tesztelve)

| Terület | Megoldás |
|---|---|
| Jelszavak | scrypt (N=2^17, r=8, p=1), konstans idejű összehasonlítás, ismeretlen felhasználónál is hash-elés (időzítés) |
| Munkamenet | 32 bájt véletlen token, DB-ben csak SHA-256; httpOnly + Secure + `SameSite=Strict` + `__Host-` prefix; tétlenségi és abszolút lejárat; jelszócserekor a többi munkamenet visszavonva |
| CSRF | munkamenetenkénti token, minden nem-GET kérésnél kötelező `x-csrf-token` fejléc |
| Brute force | per-IP login rate limit + fiókzárolás; egységes hibaüzenet (nincs fiók-enumeráció) |
| 2FA | TOTP (RFC 6238, ±30 s), a titok AES-256-GCM-mel titkosítva |
| RBAC | minden végponton backend ellenőrzés; nem tag → 404; eszkalációvédelem (saját szerep, magasabb szint, nem birtokolt jog); utolsó owner védelem |
| Tenant szeparáció | minden lekérdezés `server_id`-ra szűr; API-kulcs szerverhez kötött; tesztelve |
| API-kulcsok | csak hash tárolva, egyszer megjelenítve, azonnali visszavonás, rotáció türelmi idővel, utolsó használat (idő, IP) naplózva |
| Bemenet | zod validáció minden végponton, méretkorlátok (body 512 KB, bizonyíték 16 KB), paraméterezett SQL, `LIKE` escape |
| HTTP fejlécek | Helmet: CSP (`script-src 'self'`), HSTS, `frame-ancestors 'none'`, nosniff; CORS csak explicit allowlist |
| XSS | React automatikus escape; a NUI saját, alapból escape-elő template-et használ; bizonyíték mindig JSON szövegként; tesztelve rosszindulatú játékosnévvel |
| Titkok | a Discord webhook URL titkosítva, soha nem kerül vissza a böngészőbe; a naplóban az auth fejlécek redaktálva |
| Audit | minden adminművelet (web, játék, automatikus) a változtathatatlan auditnaplóba; nincs módosító/törlő végpont |
| Remote config | csak modul- és kockázati beállítás írható távolról, kétoldali sémavalidáció, egészében elutasítás hibánál |
| FiveM kliens | nem kap konfigurációt vagy titkot; minden net event rate limitelt és típusellenőrzött; a panel minden kérése szerveroldali jogellenőrzésen megy át |
| Automatikus ban | kliensjel önmagában soha; 2 független szerveroldali jel vagy perdöntő jel; circuit breaker; backend kiesés nem okoz bant |
| Adatvédelem | IP soha nem hagyja el a játékszervert és nem ban-azonosító alapból; nincs fájlrendszer-, folyamat- vagy képernyőhozzáférés a kliensen; azonosítók maszkolva `players.identifiers` jog nélkül |

## Ismert korlátok / nyitott pontok

* Az in-game rate limiterek és a backend rate limit memóriában élnek (backend: példányonként). Több backend példánynál a limit példányonként értendő.
* Az `APP_ENCRYPTION_KEY` rotációja nincs automatizálva.
* Nincs WebAuthn/passkey, csak TOTP.
* Nincs automatikus SAST/dependency audit a pipeline-ban (CI nincs beállítva ebben a repóban).
* A játékon belüli, **webes fiókhoz nem kötött** adminok (ACE/framework) műveleteit a backend a játékszerver API-kulcsának jogán fogadja el – a jogosultságot ilyenkor a játékszerver ellenőrzi. Ha ezt el akarod kerülni, használd csak a `backend` jogosultsági forrást.
