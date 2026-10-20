# Hibakeresés

Először: `milcsoguard status` a szerverkonzolban, és a dashboard *Rendszerállapot* oldala.

| Tünet | Ok / teendő |
|---|---|
| `OneSync is OFF` hiba | `set onesync on` a `server.cfg`-ben. Enélkül a mozgás-, állapot-, fegyver- és entity-ellenőrzések nem futnak. |
| `convar milcsoguard_api_url is empty -> running in local-only mode` | Nincs beállítva az API URL → csak helyi védelem. |
| `must use https://` | Az API URL-nek HTTPS-nek kell lennie (kivéve `http://127.0.0.1` / `localhost` fejlesztéshez). |
| `backend handshake failed: Invalid or revoked API key` | Hibás / visszavont kulcs, vagy `setr`-rel lett megadva (és más resource felülírta). Generálj újat. |
| `Game API requires HTTPS` (403) | Produkciós backend közvetlen HTTP-n. Állíts be TLS-t vagy `TRUST_PROXY=true`-t a proxy mögött. |
| `Settings schema rejected` (422) | A resource és a backend verziója eltér. Frissítsd mindkettőt ugyanarra a kiadásra ([UPGRADE.md](UPGRADE.md)). |
| A dashboardon „játékszerver offline” | Nincs heartbeat 120 mp-ig. Nézd a resource konzolt (`sync loop error`, `timeout`), tűzfal, DNS. |
| Detektálások nem jelennek meg | `milcsoguard status` → `queue` nő? Akkor a backend nem elérhető vagy elutasítja a kérést (`backend rejected ... detection(s)` a konzolban, részletes mezőhibával). |
| `[remote config vN rejected]` | A dashboardról mentett konfiguráció a resource validációján elbukott (verzióeltérés). A resource az előző konfigurációt tartja meg; a hiba a *Rendszeresemények* között is megjelenik. |
| Sok `movement.teleport` egy helyen | Legitim kliensoldali teleport (interior ajtó, lift) → add hozzá a `Config.TeleportZones`-hoz, vagy szerveroldali teleportnál hívd az `AllowMovement` exportot. |
| `weapons.inventory_mismatch` fegyverboltnál | Az inventory késve frissül → emeld a `consecutive` értéket, vagy tedd a fegyvert az `ignore` listára. |
| `entities.spawn` blokkolja a garázs scriptet | Tedd a resource-ot whitelistre (*Whitelist → Megbízható resource*) vagy hívd az `ExpectEntity` exportot a spawn előtt. Ha a `GetEntityScript` nem adja vissza a resource nevét, csak az `ExpectEntity` / modell-whitelist működik. |
| `client.heartbeat` kickek lassú gépeken | Emeld a `readyTimeoutSeconds` / `maxMisses` értékét, vagy állítsd `warn`-ra. |
| Admin nem tudja megnyitni a panelt | ACE: `add_ace group.admin milcsoguard.role.administrator allow` + `add_principal identifier.license:… group.admin`; ESX csoport leképezés a `Config.Permissions.framework`-ben; vagy köss azonosítót a webes fiókhoz. |
| „Nincs jogosultságod” a panelen | A jogot a szerver **minden kérésnél** újra ellenőrzi; a webhez kötött adminoknál a webes szerepkör is számít. |
| Belépés: „Hibás bejelentkezési adatok, vagy a fiók átmenetileg zárolva van” | Sok hibás próbálkozás → `LOGIN_LOCK_MINUTES` után újra próbálható; vagy per-IP rate limit (429). |
| 2FA eszköz elveszett | Adatbázisból (platform admin): `UPDATE users SET totp_enabled=false, totp_secret_enc=NULL WHERE username='...';` – utána a felhasználó azonnal állítsa be újra. Auditáld kézzel. |
| A dashboard frissítés után régi | Böngésző cache; a backend a `web/dist` fájlokat kérésenként szolgálja ki, újraindítás nem kell. |
| `Too many requests` | Rate limit. Játékszervernél kulcsonként számol – nézd, nem fut-e két szerver ugyanazzal a kulccsal. |

## Naplók

* Resource: FXServer konzol, `^1[MilcsoGuard:error]`, `^3[MilcsoGuard:warn]`. Részletes mód: `set milcsoguard_debug true` + restart.
* Backend: strukturált JSON (pino) a stdout-on. Az `authorization`, `cookie`, `x-csrf-token` fejlécek redaktálva.
