// Records the demo videos (webm) with Playwright:
//   admin-web.webm  – the REAL dashboard against a REAL running backend (demo server seeded via the game API)
//   admin-nui.webm  – the in-game panel with a mocked NUI bridge (no game client here) – labelled as demo data
//   player.webm     – a labelled SIMULATION of the player's view, using the real ban code from the backend
// Usage: MG_OWNER_PASSWORD=... SCHEMA=schema.json OUT=dir node record.mjs
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MG_WEB_URL ?? 'http://127.0.0.1:8080';
const PASS = process.env.MG_OWNER_PASSWORD;
const OUT = process.env.OUT ?? path.join(here, 'out');
const SCHEMA = JSON.parse(readFileSync(process.env.SCHEMA, 'utf8'));
mkdirSync(OUT, { recursive: true });
if (!PASS) throw new Error('MG_OWNER_PASSWORD required');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1280, H = 720;

// ---------------------------------------------------------------- seed the demo server through the real API
async function seed() {
  let cookie = '', csrf = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  csrf = (await call('POST', '/api/v1/auth/login', { login: 'owner', password: PASS })).csrfToken;
  const slug = 'demo-' + Date.now().toString(36);
  const { server } = await call('POST', '/api/v1/servers', { name: 'Milcso RP (demó)', slug, description: 'Demó szerver a bemutatóhoz' });
  const { secret: key } = await call('POST', `/api/v1/servers/${server.id}/api-keys`, { name: 'demo' });
  const game = (method, p, body) => call(method, '/api/v1/game' + p, body, { authorization: `Bearer ${key}`, cookie: '' });
  await game('POST', '/handshake', { resourceVersion: '1.0.0', artifact: 'FXServer demo', framework: 'esx', onesync: 'on', dependencies: { es_extended: '1.16.3', ox_inventory: '2.48.0' }, schema: SCHEMA, effective: {} });
  return { serverId: server.id, key, game };
}

const PLAYERS = [
  { netId: 7, name: 'Nagy_Eszter', identifiers: ['license:5d1e7a90c3b24f68a0e9d3417c5b2f86e4a1d093', 'discord:402918374650192837'], ping: 31, risk: 0 },
  { netId: 12, name: 'Kovacs_Bela', identifiers: ['license:a3f9c2d17be84c0e9d5a61f2b7c4083e1d9a5f60', 'discord:381274650192837465'], ping: 44, risk: 0 },
  { netId: 21, name: 'Szabo_Peter', identifiers: ['license:9c4b7e2a1d8f4630b5a7c9e1f3d2a6840b7c5e19', 'discord:295837461029384756'], ping: 58, risk: 0 },
];
const det = (id, p, extra) => ({ localId: id, netId: p.netId, playerName: p.name, identifiers: p.identifiers, source: 'server', occurredAt: new Date().toISOString(), ...extra });

// ---------------------------------------------------------------- helpers for pleasant recordings
const OVERLAY = `
(() => {
  const mk = () => {
    if (document.getElementById('__cap')) return;
    const s = document.createElement('style');
    s.textContent = '#__cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;background:linear-gradient(transparent,rgba(0,0,0,.9) 45%);padding:44px 40px 20px;font:600 22px/1.35 Segoe UI,Inter,system-ui,sans-serif;color:#fff;text-align:center;pointer-events:none}#__cur{position:fixed;z-index:2147483001;width:22px;height:22px;border-radius:50%;background:rgba(124,108,255,.55);border:2px solid #fff;pointer-events:none;transform:translate(-50%,-50%);left:-50px;top:-50px;transition:transform .08s}#__cur.dn{transform:translate(-50%,-50%) scale(.7);background:rgba(45,212,191,.8)}';
    document.head.appendChild(s);
    const c = document.createElement('div'); c.id = '__cap'; document.body.appendChild(c);
    const u = document.createElement('div'); u.id = '__cur'; document.body.appendChild(u);
    document.addEventListener('mousemove', (e) => { u.style.left = e.clientX + 'px'; u.style.top = e.clientY + 'px'; }, true);
    document.addEventListener('mousedown', () => u.classList.add('dn'), true);
    document.addEventListener('mouseup', () => u.classList.remove('dn'), true);
  };
  if (document.readyState !== 'loading') mk(); else document.addEventListener('DOMContentLoaded', mk);
  window.__setCap = (t) => { mk(); document.getElementById('__cap').textContent = t; document.getElementById('__cap').style.display = t ? 'block' : 'none'; };
})();`;

async function newRec(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: path.join(OUT, 'raw-' + name), size: { width: W, height: H } } });
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  return { ctx, page };
}
const cap = (page, t) => page.evaluate((x) => window.__setCap(x), t).catch(() => undefined);
async function finish({ ctx, page }, name) {
  const v = page.video();
  await ctx.close();
  const p = await v.path();
  renameSync(p, path.join(OUT, name + '.webm'));
}
async function point(page, selector, { click = true, pause = 450 } = {}) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: 'visible', timeout: 15000 });
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 25 });
  await sleep(pause);
  if (click) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
async function typeInto(page, selector, text) {
  await point(page, selector);
  await page.keyboard.type(text, { delay: 45 });
}
const card = async (page, title, sub) => {
  await page.setContent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0d14;color:#e8eaf2;font-family:Segoe UI,Inter,sans-serif;text-align:center"><div><div style="font-size:48px;font-weight:700">${title}</div><div style="font-size:22px;color:#8a91a8;margin-top:14px;max-width:900px">${sub}</div></div></body>`);
  await sleep(3600);
};

// ================================================================ 1) real web dashboard
async function adminWeb(browser, { serverId, game }) {
  const r = await newRec(browser, 'web');
  const { page } = r;
  await card(page, '💻 Az admin oldala – webes dashboard', 'Valódi backend, valódi felület. A demó szerver és a „játékosok” egy teszt-szkripttől érkeznek a játékszerver API-ján át.');
  await page.goto(BASE + '/login');
  await cap(page, 'Belépés: erős jelszó, kétlépcsős azonosítással (TOTP) bekapcsolható');
  await typeInto(page, 'input[autocomplete="username"]', 'owner');
  await typeInto(page, 'input[autocomplete="current-password"]', PASS);
  await point(page, 'button.primary');
  await page.waitForSelector('.sidebar nav a');
  // pick the demo server in the switcher
  await page.goto(`${BASE}/s/${serverId}`);
  await game('POST', '/heartbeat', { players: PLAYERS, resources: [{ name: 'milcsoguard', state: 'started' }], stats: {}, uptimeSeconds: 5400, configVersion: 0, queueSize: 0 });
  await page.waitForSelector('.stat-value');
  await sleep(1500);
  await cap(page, 'Dashboard: online játékosok, mai detektálások, nyitott riasztások, aktív banok – a játékszerver 30 mp-enként küld adatot');
  await sleep(5500);

  await point(page, '.sidebar nav a:has-text("Élő detektálások")');
  await page.waitForSelector('.empty, table');
  await cap(page, 'Élő detektálások – az új riasztások frissítés nélkül, valós időben (SSE) jelennek meg');
  await sleep(2500);
  const kb = PLAYERS[1];
  await game('POST', '/detections', { detections: [det('demo-tp-0001', kb, { type: 'movement.teleport', module: 'movement', severity: 'MEDIUM', riskScore: 15, action: 'warn', actionResult: '', evidence: { distance: 2210.4, seconds: 1.0, inVehicle: false, limit: 120 } })] });
  await page.waitForSelector('tr.clickable');
  await cap(page, 'Megjött: teleport-gyanú (MEDIUM) – a szerver csak figyelmeztetett');
  await sleep(4000);
  await game('POST', '/detections', { detections: [det('demo-wp-0001', kb, { type: 'weapons.blacklist', module: 'weapons', severity: 'HIGH', riskScore: 50, action: 'kick', actionResult: 'kicked', evidence: { weapon: 'WEAPON_RAILGUN' } })] });
  await page.waitForFunction(() => document.querySelectorAll('tr.clickable').length >= 2);
  await cap(page, 'Második, független jelzés: tiltott fegyver (HIGH) – a játékost a szerver kickelte');
  await sleep(4500);

  await cap(page, 'Kattintás egy sorra: részletek és a szerver által rögzített bizonyíték');
  await point(page, 'tr.clickable:has-text("weapons.blacklist") td:first-child');
  await page.waitForSelector('.modal pre.json');
  await sleep(4500);
  await cap(page, 'Felülvizsgálat: megerősítés vagy „téves riasztás” – indoklás kötelező, az auditnaplóba kerül');
  await point(page, '.modal-foot .btn.primary');
  await page.waitForSelector('.modal-backdrop >> nth=1');
  await point(page, '.modal-backdrop >> nth=-1 >> textarea');
  await page.keyboard.type('Bizonyított: a Railgun nincs az inventoryban és tiltólistás.', { delay: 35 });
  await sleep(500);
  await point(page, '.modal-backdrop >> nth=-1 >> .modal-foot .btn.primary');
  await page.waitForSelector('.toast.success');
  await sleep(2500);

  await point(page, '.sidebar nav a:has-text("Játékosok")');
  await page.waitForSelector('tr:has-text("Kovacs_Bela")');
  await cap(page, 'Játékosok: ki van online, mekkora a kockázati pontszáma – innen lehet kickelni vagy bannolni');
  await sleep(4500);
  await cap(page, 'Ban kiadása: időtartam + kötelező indoklás. A játékos összes azonosítója tiltásra kerül (IP soha)');
  await point(page, 'tr:has-text("Kovacs_Bela") .btn.danger');
  await page.waitForSelector('.modal select');
  await sleep(800);
  await point(page, '.modal select', { click: false });
  await page.selectOption('.modal select', { label: '7 nap' });
  await sleep(700);
  await typeInto(page, '.modal textarea', 'Tiltott fegyver és teleport – ismételt szabályszegés');
  await sleep(700);
  await point(page, '.modal-foot .btn.danger');
  await page.waitForSelector('.toast.success');
  await sleep(2500);

  await point(page, '.sidebar nav a:has-text("Banok")');
  await page.waitForSelector('tr.clickable');
  await cap(page, 'Banok: aktív / lejárt / feloldott. A játékszerver pár másodpercen belül lecsatlakoztatja az online játékost');
  await sleep(4500);
  await point(page, 'tr.clickable td:first-child');
  await page.waitForSelector('.modal .timeline');
  await cap(page, 'Ban részletei: kapcsolódó detektálások, azonosítók, teljes előzmény – és itt lehet feloldani vagy téves banként felülvizsgálni');
  await sleep(5500);
  await page.keyboard.press('Escape');

  await point(page, '.sidebar nav a:has-text("Auditnapló")');
  await page.waitForSelector('tr.clickable');
  await cap(page, 'Auditnapló: ki, mikor, mit csinált – nem módosítható és nem törölhető');
  await sleep(5000);

  await point(page, '.sidebar nav a:has-text("Anticheat beállítások")');
  await page.waitForSelector('.module');
  await cap(page, 'Beállítások: minden modul küszöbe és intézkedése állítható – az ismert korlátai is ott vannak');
  await sleep(4000);
  await page.mouse.wheel(0, 600);
  await sleep(3500);
  await cap(page, 'Kliensoldali jelzés automatikus banra nem állítható – ezt a szerver és a backend is elutasítja');
  await sleep(4000);

  await point(page, '.sidebar nav a:has-text("Rendszerállapot")');
  await page.waitForSelector('.card');
  await cap(page, 'Rendszerállapot: játékszerver, függőségek, backend, API-kulcsok, rendszeresemények');
  await sleep(5000);
  await point(page, '.sidebar nav a:has-text("Statisztika")');
  await page.waitForSelector('.chart');
  await cap(page, 'Statisztika: napi trend, típusok és téves riasztási arány – ez alapján hangolható a rendszer');
  await sleep(5500);
  await finish(r, 'admin-web');
}

// ================================================================ 2) in-game panel (mocked NUI bridge)
async function adminNui(browser) {
  const r = await newRec(browser, 'nui');
  const { page } = r;
  const now = new Date().toISOString();
  const det1 = { id: '0001', type: 'weapons.blacklist', severity: 'HIGH', player_name: 'Kovacs_Bela', net_id: 12, source: 'server', action: 'kick', action_result: 'kicked', risk_score: 50, review_status: 'pending', occurred_at: now, evidence: { weapon: 'WEAPON_RAILGUN' } };
  const det2 = { ...det1, id: '0002', type: 'movement.teleport', severity: 'MEDIUM', action: 'warn', action_result: '', risk_score: 15, evidence: { distance: 2210.4 } };
  const answers = {
    dashboard: { ok: true, data: { onlinePlayers: 3, detectionsToday: 2, alertsToday: 1, cachedBans: 1, recent: [{ ...det1, playerName: 'Kovacs_Bela', netId: 12, occurredAt: now }, { ...det2, playerName: 'Kovacs_Bela', netId: 12, occurredAt: now }], api: { enabled: true, online: true }, remote: { detections_today: 2, open_alerts: 1, active_bans: 1 } } },
    'players.list': { ok: true, data: PLAYERS.map((p) => ({ id: p.netId, name: p.name, ping: p.ping, risk: p.netId === 12 ? 50 : 0, monitored: p.netId === 12, identifiers: ['license:a3f9…60'], joinedSecondsAgo: 1800 })) },
    'detections.list': { ok: true, data: { source: 'backend', page: { items: [det1, det2], total: 2, page: 1, pageSize: 25 } } },
    'ban.create': { ok: true, data: { id: 'local:demo' } },
    'settings.get': { ok: true, data: { schema: SCHEMA, effective: Object.fromEntries(Object.entries(SCHEMA.modules).map(([k, m]) => [k, { ...m.defaults, params: Object.fromEntries(Object.entries(m.params).map(([pk, ps]) => [pk, ps.default])) }])), risk: {}, version: 1, canEdit: false } },
    'system.status': { ok: true, data: { version: '1.0.0', framework: 'esx', inventory: 'ox', deps: { es_extended: '1.16.3', ox_inventory: '2.48.0' }, onesync: 'on', artifact: 'FXServer demo', entityLockdown: 'relaxed', api: { enabled: true, online: true, queue: 0, stats: { sent: 12, failed: 0, dropped: 0 }, server: 'Milcso RP (demó)' }, configVersion: 1, cachedBans: 1, uptimeSeconds: 5400, players: 3, breaker: { open: false, recent: 0 }, counters: { total: 2 }, events: [] } },
  };
  await page.route('https://milcsoguard/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(req.postData() || '{}');
    await route.fulfill({ status: 200, headers: cors, body: '{}' });
    if (new URL(req.url()).pathname === '/request') {
      const result = answers[body.action] ?? { ok: true, data: {} };
      setTimeout(() => page.evaluate(([reqId, res]) => window.postMessage({ type: 'response', reqId, result: res }, '*'), [body.reqId, result]).catch(() => {}), 120);
    }
  });
  await card(page, '🎮 Az admin oldala – játékon belüli panel', 'A /anticheat parancs nyitja. Itt bemutató-adatok látszanak (nincs élő játékszerver ebben a környezetben), a felület és a folyamat viszont a valódi.');
  await page.goto('file://' + path.resolve(here, '../../../fivem/milcsoguard/nui/index.html'));
  await page.evaluate((perms) => window.postMessage({ type: 'open', info: { version: '1.0.0', role: 'Administrator', level: 60, permissions: perms, apiEnabled: true, apiOnline: true, notifyMin: 'MEDIUM' } }, '*'),
    ['players.view', 'players.identifiers', 'players.kick', 'detections.view', 'detections.review', 'bans.view', 'bans.create', 'bans.remove', 'whitelist.view', 'whitelist.manage', 'settings.view', 'system.view', 'audit.view', 'admins.view']);
  await page.waitForSelector('#root:not(.hidden)');
  await cap(page, 'A panelt csak a szerver nyitja meg, ha tényleg admin vagy – a kliens nem dönthet erről. Minden gombnyomásnál újra ellenőrzi a jogot');
  await sleep(5500);
  await page.evaluate(() => window.postMessage({ type: 'detection', detection: { type: 'weapons.blacklist', severity: 'CRITICAL', action: 'kick', playerName: 'Szabo_Peter', netId: 21, occurredAt: new Date().toISOString(), source: 'server' } }, '*'));
  await cap(page, 'Új riasztás érkezik élőben – akkor is, ha a panel be van zárva, értesítésként jelenik meg');
  await sleep(4500);
  await point(page, 'nav button[data-page="players"]');
  await page.waitForSelector('[data-act="ban"]');
  await cap(page, 'Játékosok: ping, kockázat, megfigyelés – kick és ban egy kattintás, de indoklás nélkül nem megy');
  await sleep(4000);
  await point(page, '[data-act="ban"][data-id="12"]');
  await page.waitForSelector('#mOk');
  await sleep(900);
  await point(page, '#mOk');
  await cap(page, 'Indoklás nélkül a ban nem indul el');
  await sleep(2500);
  await typeInto(page, '#mReason', 'Tiltott fegyver (Railgun) – bizonyítva');
  await cap(page, 'A végleges ban külön jogosultság (bans.permanent) – alapból időtartamot kell választani');
  await sleep(1500);
  await point(page, '#mOk');
  await sleep(2500);
  await point(page, 'nav button[data-page="detections"]');
  await page.waitForSelector('[data-ev="0"]');
  await cap(page, 'Detektálások: bizonyíték megnyitása és felülvizsgálat (téves riasztás jelölése)');
  await sleep(3000);
  await point(page, '[data-ev="0"]');
  await page.waitForSelector('#modal pre.json');
  await sleep(4500);
  await page.keyboard.press('Escape');
  await point(page, 'nav button[data-page="settings"]');
  await page.waitForSelector('.module-row');
  await cap(page, 'Beállítások és rendszerállapot is itt érhető el – ugyanaz a jogosultsági rendszer védi');
  await sleep(5500);
  await finish(r, 'admin-nui');
}

// ================================================================ 3) player simulation
async function player(browser, code, reason, until) {
  const r = await newRec(browser, 'player');
  const url = `file://${path.join(here, 'player.html')}?code=${encodeURIComponent(code)}&reason=${encodeURIComponent(reason)}&until=${encodeURIComponent(until)}`;
  await r.page.goto(url);
  await r.page.waitForFunction(() => document.title === 'done', null, { timeout: 90000 });
  await finish(r, 'player');
}

const PARTS = (process.env.PARTS ?? 'web,nui,player').split(',');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
try {
  let demo;
  if (PARTS.includes('web')) {
    demo = await seed();
    writeFileSync(path.join(OUT, 'demo.json'), JSON.stringify({ serverId: demo.serverId, key: demo.key }));
    await adminWeb(browser, demo);
  } else {
    demo = JSON.parse(readFileSync(path.join(OUT, 'demo.json'), 'utf8'));
  }
  if (PARTS.includes('nui')) await adminNui(browser);
  // real ban data for the player scene
  let code = 'MG-DEMO0000', reason = 'Tiltott fegyver és teleport – ismételt szabályszegés', until = '';
  const res = await fetch(`${BASE}/api/v1/game/bans/sync`, { headers: { authorization: `Bearer ${demo.key}` } }).then((x) => x.json());
  const ban = res.bans.find((b) => b.playerName === 'Kovacs_Bela');
  if (ban) { code = ban.code; reason = ban.reason; until = ban.expiresAt ? new Date(ban.expiresAt).toISOString().slice(0, 16).replace('T', ' ') : 'soha (végleges)'; }
  console.log('ban', code);
  if (PARTS.includes('player')) await player(browser, code, reason, until);
  console.log('done');
} finally {
  await browser.close();
}
