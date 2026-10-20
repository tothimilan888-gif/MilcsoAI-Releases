// Headless test of the in-game NUI panel with a mocked FiveM NUI bridge.
// Verifies: every page renders, permission-based navigation, confirm+reason flow, and that
// attacker-controlled strings (player names, evidence) cannot inject HTML/JS.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NUI = path.resolve(here, '../../fivem/milcsoguard/nui/index.html');
const OUT = path.join(here, 'artifacts');
mkdirSync(OUT, { recursive: true });

const XSS = '<img src=x onerror="window.__xss=1">';
const ALL = ['players.view', 'players.identifiers', 'players.kick', 'detections.view', 'detections.review', 'bans.view', 'bans.create', 'bans.permanent', 'bans.remove', 'whitelist.view', 'whitelist.manage', 'admins.view', 'audit.view', 'settings.view', 'settings.manage', 'system.view'];

const now = new Date().toISOString();
const det = (i, extra = {}) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, type: 'movement.teleport', severity: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'][i % 4], player_name: i === 1 ? XSS : `Player${i}`, net_id: i, source: 'server', action: 'warn', action_result: '', risk_score: 20 + i, review_status: 'pending', occurred_at: now, evidence: { distance: 812, note: '</pre><script>window.__xss=2</script>' }, ...extra });
const schema = {
  version: 1, actions: ['log', 'warn', 'monitor', 'kick', 'ban'], severities: ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
  modules: {
    'movement.teleport': { label: 'Teleport anomália', category: 'movement', source: 'server', description: 'x', limitations: 'y', defaults: { enabled: true, action: 'warn', severity: 'MEDIUM' }, params: { maxDistanceOnFoot: { type: 'number', label: 'Max', min: 30, max: 2000, default: 120, unit: 'm' }, ignoreZones: { type: 'boolean', label: 'Zones', default: true } } },
    'client.heartbeat': { label: 'Heartbeat', category: 'client', source: 'client', description: 'x', limitations: '', defaults: { enabled: true, action: 'kick', severity: 'MEDIUM' }, params: {} },
    'weapons.blacklist': { label: 'Tiltott fegyver', category: 'weapons', source: 'server', description: 'x', limitations: '', defaults: { enabled: true, action: 'kick', severity: 'HIGH' }, params: { weapons: { type: 'list', label: 'Fegyverek', maxItems: 10, default: ['WEAPON_RAILGUN'] } } },
  },
  risk: {},
};
const effective = { 'movement.teleport': { enabled: true, action: 'warn', severity: 'MEDIUM', params: { maxDistanceOnFoot: 120, ignoreZones: true } }, 'client.heartbeat': { enabled: true, action: 'kick', severity: 'MEDIUM', params: {} }, 'weapons.blacklist': { enabled: true, action: 'kick', severity: 'HIGH', params: { weapons: ['WEAPON_RAILGUN'] } } };

const requests = [];
function respond(action, payload) {
  switch (action) {
    case 'dashboard': return { ok: true, data: { onlinePlayers: 3, detectionsToday: 5, alertsToday: 2, cachedBans: 4, recent: [{ ...det(1), playerName: XSS, netId: 1, occurredAt: now }], api: { enabled: true, online: true }, remote: { detections_today: 7, open_alerts: 2, active_bans: 9 } } };
    case 'players.list': return { ok: true, data: [{ id: 1, name: XSS, ping: 40, risk: 55, monitored: true, identifiers: ['license:abcd…ef'], joinedSecondsAgo: 600 }, { id: 2, name: 'Normal Joe', ping: 20, risk: 3, monitored: false, admin: { role: 'Moderator', level: 40, source: 'ace' }, identifiers: [], joinedSecondsAgo: 60 }] };
    case 'player.details': return { ok: true, data: { player: { id: payload.id, name: XSS, ping: 40, risk: 55, identifiers: ['license:abcd…ef'] }, riskHistory: [{ type: 'movement.teleport', points: 15, source: 'server' }], localDetections: [], remote: { player: { first_seen: now, notes: XSS }, detections: [det(1)], bans: [] } } };
    case 'detections.list': return { ok: true, data: { source: 'backend', page: { items: [det(1), det(2), det(3)], total: 3, page: 1, pageSize: 25 } } };
    case 'bans.list': return { ok: true, data: { source: 'backend', page: { items: [{ id: 'b1', public_code: 'MG-AAAA', player_name: XSS, reason: XSS, created_by_label: 'boss', created_at: now, expires_at: null, status: 'active', identifiers: [] }], total: 1, page: 1, pageSize: 25 } } };
    case 'whitelist.list': return { ok: true, data: { source: 'backend', items: [{ id: 'w1', kind: 'player', value: 'license:aaa', modules: ['movement.*'], note: XSS, created_by_label: 'boss' }] } };
    case 'admins.list': return { ok: true, data: { online: [{ id: 2, name: 'Normal Joe', role: 'Moderator', level: 40, source: 'ace' }], roles: [{ key: 'owner', label: 'Owner', level: 100 }], members: [{ username: 'boss', role_name: 'Owner', identifiers: [], last_login_at: now }] } };
    case 'audit.list': return { ok: true, data: { items: [{ created_at: now, actor_label: XSS, actor_type: 'game_admin', action: 'ban.create', target_type: 'ban', target_id: 'b1', details: { reason: XSS } }], total: 1, page: 1, pageSize: 30 } };
    case 'settings.get': return { ok: true, data: { schema, effective, risk: {}, version: 2, canEdit: true } };
    case 'settings.save': return { ok: true, data: { version: 3 } };
    case 'system.status': return { ok: true, data: { version: '1.0.0', framework: 'esx', inventory: 'ox', deps: { es_extended: '1.16.3' }, onesync: 'on', artifact: 'FXServer', entityLockdown: 'relaxed', api: { enabled: true, online: true, queue: 0, stats: { sent: 1, failed: 0, dropped: 0 } }, configVersion: 2, cachedBans: 4, uptimeSeconds: 3700, players: 3, breaker: { open: false, recent: 0 }, counters: { total: 9 }, events: [{ severity: 'HIGH', message: XSS, type: 'resource_stop', created_at: now }] } };
    case 'ban.create': return payload.reason?.length >= 3 ? { ok: true, data: { id: 'local:x' } } : { ok: false, error: 'Indoklás kötelező' };
    case 'kick': return { ok: true, data: {} };
    default: return { ok: true, data: {} };
  }
}

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); else console.log('  ✓', msg); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_FILE_NOT_FOUND')) errors.push(m.text()); });

await page.route('https://milcsoguard/**', async (route) => {
  const req = route.request();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const endpoint = new URL(req.url()).pathname.slice(1);
  const body = JSON.parse(req.postData() || '{}');
  requests.push({ endpoint, body });
  await route.fulfill({ status: 200, headers: cors, body: '{}' });
  if (endpoint === 'request') {
    const result = respond(body.action, body.payload);
    setTimeout(() => page.evaluate(([reqId, res]) => window.postMessage({ type: 'response', reqId, result: res }, '*'), [body.reqId, result]).catch(() => {}), 20);
  }
});

await page.goto('file://' + NUI);
await page.evaluate((perms) => window.postMessage({ type: 'open', info: { brand: 'MilcsoGuard', version: '1.0.0', role: 'Owner', level: 100, permissions: perms, apiEnabled: true, apiOnline: true, notifyMin: 'MEDIUM' } }, '*'), ALL);
await page.waitForSelector('#root:not(.hidden)');

const pages = ['dashboard', 'players', 'detections', 'bans', 'whitelist', 'admins', 'logs', 'settings', 'system'];
for (const p of pages) {
  await page.click(`nav button[data-page="${p}"]`);
  await page.waitForFunction(() => !document.querySelector('#content .spinner'), null, { timeout: 5000 });
  const hasError = await page.$('#content .error-box');
  check(!hasError, `page "${p}" renders without error`);
  await page.screenshot({ path: path.join(OUT, `nui-${p}.png`) });
}

// player details page
await page.click('nav button[data-page="players"]');
await page.waitForSelector('[data-act="details"]');
await page.click('[data-act="details"][data-id="1"]');
await page.waitForFunction(() => document.querySelector('#pageTitle').textContent.includes('részletei'));
check(!(await page.$('#content .error-box')), 'player details page renders');
await page.screenshot({ path: path.join(OUT, 'nui-player.png') });

// XSS: names and evidence are shown as text
await page.click('nav button[data-page="detections"]');
await page.waitForSelector('[data-ev="0"]');
await page.click('[data-ev="0"]');
await page.waitForSelector('#modal pre.json');
const xss = await page.evaluate(() => window.__xss);
check(xss === undefined, 'attacker-controlled names/evidence are not executed (no XSS)');
const shownName = await page.evaluate(() => document.body.innerText.includes('<img src=x onerror='));
check(shownName, 'malicious names are displayed literally as text');
await page.keyboard.press('Escape');

// ban flow: reason is mandatory, permanent must be explicit
await page.click('nav button[data-page="players"]');
await page.waitForSelector('[data-act="ban"][data-id="2"]');
await page.click('[data-act="ban"][data-id="2"]');
await page.waitForSelector('#mOk');
await page.click('#mOk');
check(!(await page.$('#modal.hidden')), 'ban modal stays open without a reason');
check(!requests.some((r) => r.body.action === 'ban.create'), 'no ban request is sent without a reason');
await page.fill('#mReason', 'Aimbot, bizonyítékkal');
await page.selectOption('[data-field="duration"]', 'permanent');
await page.click('#mOk');
await page.waitForTimeout(150);
const banReq = requests.find((r) => r.body.action === 'ban.create');
check(banReq && banReq.body.payload.permanent === true && banReq.body.payload.durationSeconds === undefined, 'permanent ban is requested explicitly');

// settings: client modules never offer "ban"
await page.click('nav button[data-page="settings"]');
await page.waitForSelector('[data-module="client.heartbeat"]');
const clientOptions = await page.$$eval('[data-module="client.heartbeat"] [data-k="action"] option', (o) => o.map((x) => x.value));
check(!clientOptions.includes('ban'), 'client-side modules do not offer the ban action');
await page.click('#sSave');
await page.fill('#mReason', 'küszöb emelése');
await page.click('#mOk');
await page.waitForTimeout(150);
const save = requests.find((r) => r.body.action === 'settings.save');
check(save && save.body.payload.overrides.modules['movement.teleport'].params.maxDistanceOnFoot === 120, 'settings form serialises overrides');

// live detection push
await page.evaluate((x) => window.postMessage({ type: 'detection', detection: { type: 'weapons.blacklist', severity: 'CRITICAL', action: 'kick', playerName: x, netId: 9, occurredAt: new Date().toISOString(), source: 'server' } }, '*'), XSS);
await page.waitForSelector('.toast');
check((await page.evaluate(() => window.__xss)) === undefined, 'live toast does not execute injected HTML');

// limited permissions: viewer only sees allowed pages
await page.evaluate(() => window.postMessage({ type: 'open', info: { role: 'Viewer', level: 10, version: '1.0.0', permissions: ['players.view', 'detections.view', 'bans.view'], apiEnabled: true, apiOnline: false } }, '*'));
await page.waitForTimeout(200);
const nav = await page.$$eval('nav button', (b) => b.map((x) => x.dataset.page));
check(JSON.stringify(nav) === JSON.stringify(['dashboard', 'players', 'detections', 'bans']), 'navigation is filtered by permissions');
const kickButtons = await page.$$('[data-act="kick"]');
check(kickButtons.length === 0 || (await page.$eval('#pageTitle', (e) => e.textContent)) !== 'Játékosok', 'viewer sees no kick buttons');

// close
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check(requests.some((r) => r.endpoint === 'close'), 'Escape closes the panel and releases NUI focus');

check(errors.length === 0, `no console/page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await browser.close();
if (failures.length) {
  console.error('\nFAILED:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('\nNUI e2e: all checks passed');
