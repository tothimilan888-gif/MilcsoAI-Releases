// End-to-end test of the web dashboard against a running backend (which also serves web/dist).
//   MG_WEB_URL=http://127.0.0.1:8080 MG_OWNER=owner MG_OWNER_PASSWORD=... MG_KEY=mgk_... node web.test.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'artifacts');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.MG_WEB_URL ?? 'http://127.0.0.1:8080';
const USER = process.env.MG_OWNER ?? 'owner';
const PASS = process.env.MG_OWNER_PASSWORD;
const KEY = process.env.MG_KEY;
if (!PASS || !KEY) {
  console.error('MG_OWNER_PASSWORD and MG_KEY are required');
  process.exit(2);
}
const XSS = '<img src=x onerror="window.__xss=1">';

const failures = [];
const check = (cond, msg) => { if (!cond) { failures.push(msg); console.log('  ✗', msg); } else console.log('  ✓', msg); };
const game = (method, p, body) => fetch(`${BASE}/api/v1/game${p}`, { method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
const det = (localId, extra = {}) => ({ localId, type: 'weapons.blacklist', module: 'weapons', severity: 'CRITICAL', riskScore: 95, source: 'server', action: 'kick', actionResult: 'kicked', netId: 7, playerName: 'E2E Player', identifiers: ['license:' + 'e'.repeat(40)], evidence: { weapon: 'WEAPON_RAILGUN' }, occurredAt: new Date().toISOString(), ...extra });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/401|Unauthorized|Failed to load resource/.test(m.text())) errors.push(m.text()); });
const settle = () => page.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 10000 }).catch(() => undefined);

// ------------------------------------------------------------ login
await page.goto(BASE + '/');
await page.waitForSelector('input[autocomplete="username"]');
await page.screenshot({ path: path.join(OUT, 'web-login.png') });
await page.fill('input[autocomplete="username"]', USER);
await page.fill('input[autocomplete="current-password"]', 'definitely-wrong');
await page.click('button.primary');
await page.waitForSelector('.form-error');
check((await page.textContent('.form-error')).includes('Hibás'), 'wrong password shows a generic error');
const cookies = await ctx.cookies();
check(!cookies.some((c) => c.name.includes('session') && !c.httpOnly), 'session cookie (if any) is httpOnly');
check(await page.evaluate(() => Object.keys(localStorage).length === 0 && Object.keys(sessionStorage).length === 0), 'no tokens in web storage');
await page.fill('input[autocomplete="current-password"]', PASS);
await page.click('button.primary');
await page.waitForSelector('.sidebar nav a');
const sid = page.url().match(/\/s\/([0-9a-f-]{36})/)?.[1];
check(!!sid, 'logged in and redirected to a server dashboard');
await settle();
await page.screenshot({ path: path.join(OUT, 'web-dashboard.png'), fullPage: true });

// ------------------------------------------------------------ live update through SSE
await page.goto(`${BASE}/s/${sid}/detections`);
await settle();
await page.waitForTimeout(800);
const stamp = Date.now().toString(36);
const ingest = await game('POST', '/detections', { detections: [det(`e2e-live-${stamp}`, { playerName: XSS })] });
check(ingest.status === 200, 'game API accepted a detection');
await page.waitForFunction(() => document.body.innerText.includes('<img src=x onerror='), null, { timeout: 8000 }).then(() => check(true, 'new detection appears live (SSE) without reload'), () => check(false, 'new detection appears live (SSE) without reload'));
check((await page.evaluate(() => window.__xss)) === undefined, 'attacker-controlled player name is not executed');
await page.click('tr.clickable td:first-child');
await page.waitForSelector('.modal pre.json');
check((await page.textContent('.modal pre.json')).includes('WEAPON_RAILGUN'), 'detection detail shows evidence');
await page.click('.modal-foot .btn.primary');
await page.waitForSelector('.modal-backdrop >> nth=1 >> textarea');
await page.fill('.modal-backdrop >> nth=-1 >> textarea', 'E2E megerősítés');
await page.click('.modal-backdrop >> nth=-1 >> .modal-foot .btn.primary');
await page.waitForSelector('.toast.success', { timeout: 5000 }).then(() => check(true, 'detection review saved'), () => check(false, 'detection review saved'));
await page.screenshot({ path: path.join(OUT, 'web-detections.png') });

// ------------------------------------------------------------ every page renders
const pages = ['', '/players', '/bans', '/whitelist', '/admins', '/audit', '/analytics', '/system', '/config', '/integrations', '/server'];
for (const p of pages) {
  await page.goto(`${BASE}/s/${sid}${p}`);
  await settle();
  const err = await page.$('.error-state');
  check(!err, `page "${p || '/'}" renders without error`);
  await page.screenshot({ path: path.join(OUT, `web-${(p || '/dashboard').slice(1)}.png`), fullPage: true });
}

// ------------------------------------------------------------ ban create + revoke
await page.goto(`${BASE}/s/${sid}/bans`);
await settle();
await page.click('text=+ Új ban');
await page.fill('.modal textarea >> nth=0', 'license:' + 'f'.repeat(40));
await page.fill('.modal input >> nth=0', 'E2E Banned');
await page.selectOption('.modal select', { label: '7 nap' });
await page.fill('.modal textarea >> nth=1', 'E2E teszt ban');
await page.click('.modal .btn.danger');
await page.waitForSelector('.toast.success');
await page.waitForSelector('text=E2E Banned');
check(true, 'ban created from the web');
const connect = await game('POST', '/players/connect', { name: 'E2E Banned', identifiers: ['license:' + 'f'.repeat(40)] });
check(connect.data?.ban?.reason === 'E2E teszt ban', 'web ban is enforced on game connect');
await page.click('tr.clickable:has-text("E2E Banned") td:first-child');
await page.waitForSelector('.modal .btn.danger:has-text("Feloldás")');
await page.click('.modal .btn.danger:has-text("Feloldás")');
await page.fill('.modal-backdrop >> nth=-1 >> textarea', 'E2E feloldás');
await page.click('.modal-backdrop >> nth=-1 >> .modal-foot .btn.primary:has-text("Feloldás")');
await page.waitForSelector('.toast.success:has-text("feloldva")');
const after = await game('POST', '/players/connect', { name: 'E2E Banned', identifiers: ['license:' + 'f'.repeat(40)] });
check(after.data?.ban === null, 'unban from the web lifts the ban');
await page.keyboard.press('Escape');

// ------------------------------------------------------------ whitelist add + delete
await page.goto(`${BASE}/s/${sid}/whitelist`);
await settle();
await page.click('text=+ Új bejegyzés');
await page.selectOption('.modal select', 'resource');
await page.fill('.modal input >> nth=0', 'e2e_garage');
await page.click('.modal .btn.primary');
await page.waitForSelector('td:has-text("e2e_garage")');
const wl = await game('GET', '/config');
check(wl.data.whitelist.some((w) => w.value === 'e2e_garage'), 'whitelist entry reaches the game server config');
page.once('dialog', (d) => d.accept());
await page.click('tr:has-text("e2e_garage") .btn.danger');
await page.waitForSelector('td:has-text("e2e_garage")', { state: 'detached' });
check(true, 'whitelist entry removed');

// ------------------------------------------------------------ config edit
await page.goto(`${BASE}/s/${sid}/config`);
await settle();
const before = (await game('GET', '/config')).data.version;
const sel = page.locator('.module:has-text("movement.vehicle_speed") select').first();
const target = (await sel.inputValue()) === 'monitor' ? 'warn' : 'monitor';
await sel.selectOption(target);
await page.click('button:has-text("Mentés…")');
await page.fill('.modal textarea', 'E2E: jármű megfigyelés');
await page.click('.modal .modal-foot .btn.primary');
await page.waitForSelector('.toast.success');
const cfg = (await game('GET', '/config')).data;
check(cfg.version === before + 1 && (cfg.overrides.modules?.['movement.vehicle_speed']?.action ?? 'warn') === target, 'config change is versioned and served to the game server');
const clientOpts = await page.locator('.module:has-text("client.heartbeat") select').first().locator('option').allTextContents();
check(!clientOpts.includes('Ban'), 'client-side modules cannot be set to ban in the UI');

// ------------------------------------------------------------ API key
await page.goto(`${BASE}/s/${sid}/integrations`);
await settle();
await page.fill('input[aria-label="Kulcs neve"]', 'e2e key');
await page.click('text=Kulcs generálása');
await page.waitForSelector('pre.secret');
const secret = (await page.textContent('pre.secret')).trim();
check(/^mgk_[A-Za-z0-9]{10}_/.test(secret), 'API key is shown once after creation');
const hb = await fetch(`${BASE}/api/v1/game/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ players: [] }) });
check(hb.status === 200, 'new API key authenticates the game API');
await page.click('text=Elmentettem');
page.once('dialog', (d) => d.accept());
await page.click('tr:has-text("e2e key") .btn.danger');
await page.waitForSelector('tr:has-text("e2e key") >> text=visszavonva');
const hb2 = await fetch(`${BASE}/api/v1/game/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ players: [] }) });
check(hb2.status === 401, 'revoked API key is rejected immediately');

// ------------------------------------------------------------ admin add (temporary password)
await page.goto(`${BASE}/s/${sid}/admins`);
await settle();
await page.click('text=+ Admin hozzáadása');
const uname = `mod_${stamp}`;
await page.fill('.modal input[type="email"]', `${uname}@e2e.local`);
await page.fill('.modal input >> nth=1', uname);
await page.selectOption('.modal select', { label: 'Moderator (40)' });
await page.click('.modal .btn.primary');
await page.waitForSelector('pre.secret');
check(true, 'new admin gets a one-time temporary password');
await page.click('text=Elmentettem');
await page.waitForSelector(`td:has-text("${uname}")`);
await page.screenshot({ path: path.join(OUT, 'web-admins-after.png'), fullPage: true });

// ------------------------------------------------------------ mobile layout
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await ctx.storageState() });
const m = await mobile.newPage();
for (const p of ['', '/detections', '/bans', '/config']) {
  await m.goto(`${BASE}/s/${sid}${p}`);
  await m.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 10000 }).catch(() => undefined);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `mobile ${p || '/'}: no horizontal page scroll (${overflow}px)`);
}
await m.goto(`${BASE}/s/${sid}`);
await m.click('.menu-btn');
await m.waitForTimeout(300);
await m.screenshot({ path: path.join(OUT, 'web-mobile-menu.png') });
await m.click('.sidebar nav a:has-text("Banok")');
await m.waitForURL(/\/bans$/);
check(true, 'mobile navigation drawer works');
await m.screenshot({ path: path.join(OUT, 'web-mobile-bans.png'), fullPage: true });

// ------------------------------------------------------------ logout invalidates the session
await page.click('button:has-text("Kilépés")');
await page.waitForSelector('input[autocomplete="username"]', { timeout: 8000 }).catch(async (e) => { await page.screenshot({ path: path.join(OUT, 'web-logout-fail.png') }); console.log('URL', page.url()); throw e; });
const me = await page.evaluate(() => fetch('/api/v1/auth/me').then((r) => r.status));
check(me === 401, 'logout invalidates the session server-side');

check(errors.length === 0, `no console/page errors ${errors.length ? JSON.stringify(errors.slice(0, 5)) : ''}`);
await browser.close();
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n - ` + failures.join('\n - '));
  process.exit(1);
}
console.log('\nWeb e2e: all checks passed');
