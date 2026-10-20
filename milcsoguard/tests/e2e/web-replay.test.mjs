// Web dashboard replay flow against a running backend (same env as web.test.mjs):
//   MG_WEB_URL=http://127.0.0.1:8080 MG_OWNER=owner MG_OWNER_PASSWORD=... MG_KEY=mgk_... node web-replay.test.mjs
// A real WebM is recorded in Chromium (MediaRecorder on a canvas), uploaded through the game API
// exactly like the resource does, then played in the dashboard.
import { chromium } from 'playwright-core';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'artifacts');
const BASE = process.env.MG_WEB_URL ?? 'http://127.0.0.1:8080';
const USER = process.env.MG_OWNER ?? 'owner';
const PASS = process.env.MG_OWNER_PASSWORD;
const KEY = process.env.MG_KEY;
const VIEWER = process.env.MG_VIEWER;
const VIEWER_PASS = process.env.MG_VIEWER_PASSWORD;
if (!PASS || !KEY) {
  console.error('MG_OWNER_PASSWORD and MG_KEY are required');
  process.exit(2);
}
const XSS = '<img src=x onerror="window.__xss=1">';
const failures = [];
const check = (cond, msg) => { if (!cond) { failures.push(msg); console.log('  ✗', msg); } else console.log('  ✓', msg); };
const game = (method, p, body) => fetch(`${BASE}/api/v1/game${p}`, { method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

// ------------------------------------------------------------ record two real WebM segments
const rec = await browser.newPage();
const segments = await rec.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  document.body.appendChild(c);
  const g = c.getContext('2d');
  let t = 0;
  const timer = setInterval(() => { t++; g.fillStyle = `hsl(${t * 7 % 360} 70% 40%)`; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.font = '28px sans-serif'; g.fillText('frame ' + t, 20, 100); }, 66);
  const stream = c.captureStream(15);
  const one = () => new Promise((resolve) => {
    const r = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    r.ondataavailable = (e) => chunks.push(e.data);
    r.onstop = async () => {
      const b = new Blob(chunks, { type: 'video/webm' });
      const s = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(b); });
      resolve(s);
    };
    r.start();
    setTimeout(() => r.stop(), 1500);
  });
  const a = await one();
  const b = await one();
  clearInterval(timer);
  return [a, b];
});
await rec.close();
check(segments.every((s) => Buffer.from(s, 'base64').readUInt32BE(0) === 0x1a45dfa3), 'recorded two real WebM segments');

// ------------------------------------------------------------ upload like the game resource does
const stamp = Date.now().toString(36);
const license = 'license:' + crypto.createHash('sha1').update(stamp).digest('hex');
await game('POST', '/players/connect', { name: XSS, identifiers: [license] });
await game('POST', '/players/joined', { netId: 41, name: XSS, identifiers: [license] });
const localId = `gban-e2e${stamp}`;
const replayId = crypto.randomUUID();
check((await game('POST', '/replays', { id: replayId, kind: 'ban', playerName: XSS, identifiers: [license], reason: 'Automatikus: e2e', banLocalId: localId, width: 320, height: 180, fps: 15 })).status === 200, 'replay announced');
for (const [i, s] of segments.entries()) {
  check((await game('PUT', `/replays/${replayId}/parts/${i}`, { durationMs: 1500, data: s })).status === 200, `part ${i} uploaded`);
}
check((await game('POST', `/replays/${replayId}/complete`, { status: 'ready' })).data?.status === 'ready', 'replay completed');
const ban = await game('POST', '/bans', { localId, identifiers: [license], playerName: XSS, reason: 'E2E replay ban', durationSeconds: 3600 });
check(ban.status === 200, 'ban synced after the replay (the replay gets linked)');

// ------------------------------------------------------------ dashboard
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/401|Unauthorized/.test(m.text())) errors.push(m.text()); });
await page.goto(BASE + '/');
await page.fill('input[autocomplete="username"]', USER);
await page.fill('input[autocomplete="current-password"]', PASS);
await page.click('button.primary');
await page.waitForSelector('.sidebar nav a');
const sid = page.url().match(/\/s\/([0-9a-f-]{36})/)?.[1];

check(await page.$(`.sidebar nav a[href="/s/${sid}/replays"]`), 'Visszajátszások menu item');
await page.click(`.sidebar nav a[href="/s/${sid}/replays"]`);
await page.waitForSelector('tr.clickable');
check((await page.textContent('main')).includes('E2E') || (await page.textContent('main')).includes('Automatikus: e2e'), 'replay listed');
await page.click('tr.clickable');
await page.waitForSelector('.modal video');
const loaded = await page.waitForFunction(() => { const v = document.querySelector('.modal video'); return v && v.src.startsWith('blob:') && v.readyState >= 2; }, null, { timeout: 10000 }).then(() => true).catch(() => false);
check(loaded, 'the replay plays in the dashboard (blob: video, CSP media-src allows it)');
const dur = await page.waitForFunction(() => { const v = document.querySelector('.modal video'); return v && Number.isFinite(v.duration) && v.duration > 1 ? v.duration : null; }, null, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => null);
check(dur !== null, `real duration is known, the seek bar works (${dur} s)`);
check((await page.$$('.modal .replay-part')).length === 2, 'both parts shown on the timeline');
const next = await page.waitForFunction(() => document.querySelectorAll('.modal .replay-part')[1]?.classList.contains('active'), null, { timeout: 8000 }).then(() => true).catch(() => false);
check(next, 'continues with the next part automatically');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'web-replay.png') });
check((await page.textContent('.modal')).includes(ban.data.ban.code), 'replay is linked to the ban code');
await page.keyboard.press('Escape');

// ban detail shows the player
await page.click(`.sidebar nav a[href="/s/${sid}/bans"]`);
await page.fill('input[type="search"]', 'E2E replay ban');
await page.waitForFunction(() => document.body.innerText.includes('E2E replay ban'));
await page.click('tr.clickable');
await page.waitForSelector('.modal h3');
const banVideo = await page.waitForFunction(() => { const v = document.querySelector('.modal video'); return v && v.readyState >= 1; }, null, { timeout: 10000 }).then(() => true).catch(() => false);
check(banVideo, 'ban detail embeds the POV replay');
await page.screenshot({ path: path.join(OUT, 'web-ban-replay.png') });
await page.keyboard.press('Escape');

// request from the player profile (the player is online)
const playerId = (await page.evaluate(async ([s, id]) => (await (await fetch(`/api/v1/servers/${s}/replays/${id}`)).json()).replay.player_id, [sid, replayId]));
await page.goto(`${BASE}/s/${sid}/players/${playerId}`);
await page.waitForSelector('text=Visszajátszás kérése');
check((await page.textContent('main')).includes('POV visszajátszások'), 'player profile lists the replays');
await page.click('text=Visszajátszás kérése');
await page.fill('.modal textarea', 'e2e kérés');
await page.click('.modal-foot .btn.primary');
await page.waitForSelector('.toast.success', { timeout: 5000 }).then(() => check(true, 'replay request accepted'), () => check(false, 'replay request accepted'));
const cmds = (await game('GET', '/commands')).data.commands;
const cmd = cmds.find((c) => c.type === 'replay_request');
check(cmd && cmd.payload.netId === 41 && cmd.payload.reason === 'e2e kérés', 'game server receives the replay_request command');

// audit trail
const audit = await page.evaluate(async (s) => (await (await fetch(`/api/v1/servers/${s}/audit?action=replay.`)).json()).items.map((a) => a.action), sid);
check(audit.includes('replay.view') && audit.includes('replay.request'), 'viewing and requesting are audited');

// viewer role: no menu, API 403
if (VIEWER && VIEWER_PASS) {
  const vctx = await browser.newContext();
  const vp = await vctx.newPage();
  await vp.goto(BASE + '/');
  await vp.fill('input[autocomplete="username"]', VIEWER);
  await vp.fill('input[autocomplete="current-password"]', VIEWER_PASS);
  await vp.click('button.primary');
  await vp.waitForSelector('.sidebar nav a');
  check(!(await vp.$('.sidebar nav a[href$="/replays"]')), 'viewer has no replay menu');
  const st = await vp.evaluate(async ([s, id]) => (await fetch(`/api/v1/servers/${s}/replays/${id}/parts/0`)).status, [sid, replayId]);
  check(st === 403, 'viewer cannot download replay parts (403)');
  await vctx.close();
}

check(!(await page.evaluate(() => window.__xss)), 'no injected HTML executed');
check(errors.length === 0, `no console/page errors ${errors.join(' | ')}`);
await browser.close();
if (failures.length) {
  console.error('\nFAILED:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('\nweb replay e2e: all checks passed');
