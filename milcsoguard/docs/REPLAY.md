# POV visszajátszás (ban előtti utolsó másodpercek)

Kitiltás előtt a szerver bekéri a játékos kliensétől a **saját nézete utolsó ~15 másodpercét**. A felvételt a webes dashboardon (Banok → ban részletei, illetve Visszajátszások) és a játékon belüli panelen (Visszajátszások) is meg lehet nézni. Egy online játékostól az admin kézzel is kérhet felvételt, például egy report kivizsgálásához.

## Hogyan működik

```
játékos kliense (NUI, rejtett)                FXServer (MilcsoGuard)                  backend (PostgreSQL)
──────────────────────────────                ─────────────────────                  ────────────────────
játékkép → WebGL → canvas → MediaRecorder
5 mp-es önálló WebM darabok, a memóriában
mindig ≥ 15 mp marad, a régi törlődik
                       ◄── capture(id) ── ban / admin kérés / web kérés
darabok base64-ben, 240 KB-os csomagokban ─►  ellenőrzi: csak attól a játékostól,
  (latent event, sávszél-korlátozva)          méret, formátum, darabszám
                                              ─► POST /game/replays, PUT …/parts/N ─►  tárolás, banhoz kötés
                                              DropPlayer (ban esetén) ← feltöltés után
```

* **Mi kerül a felvételre:** csak a játék képe (a GTA back buffere). Nem kerül rá az asztal, más ablak, mikrofon, sőt a NUI (például a telefon UI) sem. A natívokkal rajzolt Lua menük (DrawText/DrawRect) a játékkép részei, ezért **látszanak**. A DirectX overlay-ként rajzolt külső menük általában nem.
* **Mikor hagyja el a gépet:** csak bannál (ha `Config.Replay.onBan = true`) vagy admin kérésre (`replays.request` jog, auditálva). Egyébként a memóriában marad és felülíródik.
* **Formátum:** WebM (VP8), alapból 854×480, 15 fps, ~700 kbit/s, ami 15 másodpercre ~1,3 MB. Minden darab önálló fájl, a lejátszó egymás után játssza le őket. Az utolsó darab vége a ban vagy a kérés pillanata.
* **Ban közben:** a ban azonnal érvénybe lép (helyi gyorsítótár), ezért az újracsatlakozás ilyenkor már elutasított. A játékos egy saját routing bucketbe kerül és lefagy, hogy a feltöltés alatt se zavarjon senkit. Ezután a szerver lecsatlakoztatja, legkésőbb `uploadTimeoutSeconds` (25 mp) után. Ha a kliens felvevője nem fut, nincs várakozás, a ledobás azonnal megtörténik.

## Amit őszintén tudni kell

* **A kliensen fut, ezért megkerülhető.** Egy csaló letilthatja a NUI-t, hamis vagy üres videót küldhet, vagy kiléphet (Alt+F4) a feltöltés közben. A szerver ezt kezeli: méret- és formátumellenőrzés, időtúllépés, a már beérkezett teljes darabok megmaradnak. A visszajátszás **bizonyíték, de nem perdöntő**. A hiánya sem bizonyít semmit, mindig a detektálásokkal együtt kell értékelni.
* **A játékkép-hook valódi FiveM kliensen működik** (1.1.0 éles próba: a játékkép rögzült, de fejjel lefelé – ez 1.1.1-ben javítva, a függőleges tükrözés kikerült a shaderből). A módszer (CfxTexture: 1×1 textúra + `TEXTURE_WRAP_T` szekvencia) azonos a CitizenFX `screenshot-basic` / `@citizenfx/three` kódjával. Az automatikus tesztekben (headless Chromium) nincs GTA, ott fekete a kép; a tájolást csak élő kliensen lehet ellenőrizni. Az 1.1.0-val készült felvételek fejjel lefelé maradnak.
* **Teljesítmény a kliensen:** másodpercenként 15 kis WebGL rajzolás és szoftveres VP8 kódolás 480p-ben. Ez egy átlagos gépen pár százalék CPU, gyenge gépen érezhető lehet. Ha gond van, csökkentsd: `fps = 10`, `width = 640, height = 360`, vagy kapcsold ki (`enabled = false`).
* **Adatvédelem:** a játékosok képernyőjéről (a játékról) készül felvétel. Írd bele a szerver szabályzatába vagy az adatkezelési tájékoztatóba, és állítsd be a megőrzési időt (Szerver → adatmegőrzés, `replaysDays`, alapból 30 nap). A megnyitás és a kérés auditnaplóba kerül (`replay.view`, `replay.request`).

## Ha a felvétel fejjel lefelé áll

1. Nézd meg, melyik felvevő fut a kliensen: Panel → Játékosok → játékos → **Felvevő** sor, pl. `v1.1.2 854x480@15 …`. Ha nincs verziószám, a kliens még a régi felvevőt futtatja: `restart milcsoguard`, majd lépj ki és csatlakozz újra.
2. A tájolás **felvételkor** dől el, a játékos gépén. Az 1.1.0-val készült felvételek fejjel lefelé maradnak; ezeket a lejátszó **Kép fordítása** gombjával lehet nézni (csak a megjelenítést fordítja).
3. Ha egy friss, `v1.1.2`-es felvevővel készült felvétel is fejjel lefelé áll: `Config.Replay.flipY = true`, `restart milcsoguard`, újracsatlakozás. Ilyenkor jelezd a FiveM build számát is.

## Beállítások (`config/config.lua` → `Config.Replay`)

| Kulcs | Alap | Leírás |
|---|---|---|
| `enabled` | `true` | A kliensoldali felvevő és a funkció ki/be |
| `seconds` | 15 | Legalább ennyi videó marad meg a pillanat előtt |
| `segmentSeconds` | 5 | Ilyen hosszú darabokra vág (ennyivel lehet hosszabb a felvétel) |
| `width` / `height` / `fps` | 854 / 480 / 15 | Felbontás és képkockaszám |
| `bitrateKbps` | 700 | Videó bitráta |
| `flipY` | `false` | Függőleges fordítás felvételkor (csak ha az új felvételek fejjel lefelé állnak) |
| `onBan` | `true` | Ban előtt bekéri a felvételt |
| `isolateOnBan` | `true` | Saját routing bucket + fagyasztás a feltöltés alatt |
| `uploadTimeoutSeconds` | 25 | Ennyi idő után a bannolt játékos mindenképp lecsatlakozik |
| `uploadBps` | 500000 | Kliens → szerver feltöltési sávszél (bájt/s) |
| `maxBytes` | 12 MB | Egy felvétel felső határa |
| `maxConcurrent` | 4 | Egyszerre futó feltöltések |

Backend: `REPLAY_STORAGE_LIMIT_MB` (alap 1024) a szerverenkénti tárhelykorlát. Ha betelik, a legrégebbi felvételek törlődnek. **Aktív banhoz tartozó felvétel soha nem törlődik**, se helyhiány, se megőrzési idő miatt (a fellebbezéshez kell). Ha minden tárolt felvétel aktív banhoz tartozik, az új feltöltés `507`-et kap.

## Jogosultságok

| Jog | Mit enged |
|---|---|
| `replays.view` | Felvételek listázása és lejátszása (web és játékon belül), auditálva |
| `replays.request` | Felvétel kérése egy online játékostól. Azonos vagy magasabb szintű admintól nem lehet kérni |
| `servers.manage` | Felvétel törlése |

Alapból Moderator, Administrator, AdminController, valamint minden magasabb szerepkör kapja meg (Viewer nem).

## Hibakeresés

* **A játékos profilján „Felvevő: nem támogatott”.** A kliens CEF-je nem ismeri a MediaRecorder-t vagy a captureStream-et. Ilyenkor nincs felvétel, a ban azonnal lefut.
* **„sikertelen – timeout”.** A kliens nem küldött semmit 25 mp alatt. Lehet blokkolás, nagyon lassú feltöltés vagy kilépés. Növelheted a `uploadBps` vagy az `uploadTimeoutSeconds` értékét.
* **Fekete kép valódi szerveren.** A játékkép-hook nem működik az adott FiveM buildben. Jelezd: a funkció ilyenkor csak a ban előtti időzítést és a feltöltést adja.
