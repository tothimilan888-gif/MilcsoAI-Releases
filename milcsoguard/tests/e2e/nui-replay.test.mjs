// Headless test of the NUI replay recorder and the new in-game panel tools (mocked NUI bridge).
// What this proves: MediaRecorder segmenting, the capture/chunk protocol, that the produced WebM
// parts play back in the in-game player, and the panel flows. What it cannot prove: the FiveM game
// view hook (CfxTexture) – Chromium has no game back buffer, so the frames here are black.
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NUI = path.resolve(here, '../../fivem/milcsoguard/nui/index.html');
const XSS = '<img src=x onerror="window.__xss=1">';
const PERMS = ['players.view', 'players.kick', 'players.moderate', 'replays.view', 'replays.request', 'bans.view', 'bans.create', 'bans.permanent', 'detections.view'];
const now = new Date().toISOString();

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); else console.log('  ✓', msg); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_FILE_NOT_FOUND')) errors.push(m.text()); });

const posts = [];
const replayItem = { id: '3c2c3d4e-aaaa-4bbb-8ccc-ddddeeeeffff', player_name: XSS, kind: 'ban', reason: XSS, ban_code: 'MG-REPLAY1', status: 'ready', duration_ms: 6000, created_at: now, requested_by_label: 'anticheat:ban' };
let playParts = 0;
function respond(action, payload) {
  switch (action) {
    case 'players.list': return { ok: true, data: [{ id: 7, name: 'Suspect', ping: 30, risk: 40, identifiers: [], joinedSecondsAgo: 120, recorder: 'recording' }] };
    case 'player.details': return { ok: true, data: { player: { id: 7, name: 'Suspect', ping: 30, risk: 40, identifiers: [], frozen: false, recorder: 'recording' }, riskHistory: [], localDetections: [], remote: null } };
    case 'players.recent': return { ok: true, data: [{ key: 'k-1', name: XSS, id: 9, reason: 'Exiting', risk: 70, droppedAt: now, identifiers: ['license:abcd…ef'] }] };
    case 'replays.list': return { ok: true, data: { items: [replayItem, { ...replayItem, id: 'x2', status: 'failed', error: 'timeout' }], total: 2, page: 1, pageSize: 20 } };
    case 'replay.play': return { ok: true, data: { replay: replayItem, parts: playParts } };
    case 'replay.request': return { ok: true, data: { id: 'r1', recorder: 'recording' } };
    default: return { ok: true, data: {} };
  }
}

await page.route('https://milcsoguard/**', async (route) => {
  const req = route.request();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const endpoint = new URL(req.url()).pathname.slice(1);
  const body = JSON.parse(req.postData() || '{}');
  posts.push({ endpoint, body });
  await route.fulfill({ status: 200, headers: cors, body: '{}' });
  if (endpoint === 'request') {
    const result = respond(body.action, body.payload);
    setTimeout(() => page.evaluate(([reqId, res]) => window.postMessage({ type: 'response', reqId, result: res }, '*'), [body.reqId, result]).catch(() => {}), 20);
  }
});

const waitFor = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  return null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto('file://' + NUI);

// ---------------------------------------------------------------- recorder
console.log('recorder');
check(await waitFor(() => posts.find((p) => p.endpoint === 'replayHello')), 'recorder asks for its config on load');
await page.evaluate(() => window.postMessage({ type: 'replay:config', config: { seconds: 4, segmentSeconds: 2, width: 320, height: 180, fps: 10, bitrateKbps: 300, uploadBps: 100000 } }, '*'));
const status = await waitFor(() => posts.find((p) => p.endpoint === 'replayStatus'));
check(status && status.body.state === 'recording', `recorder reports "recording" (${status && status.body.state} ${status && status.body.detail})`);
await sleep(7500);
const kept = await page.evaluate(() => window.MG_REPLAY.segments.map((s) => s.durationMs));
check(kept.length >= 2 && kept.reduce((a, b) => a + b, 0) >= 4000 && kept.reduce((a, b) => a + b, 0) - kept[0] < 4000, `ring buffer keeps just enough completed segments (${kept.join(', ')} ms)`);

async function capture(id) {
  const from = posts.length;
  await page.evaluate((cid) => window.postMessage({ type: 'replay:capture', id: cid }, '*'), id);
  const done = await waitFor(() => posts.slice(from).find((p) => p.endpoint === 'replayDone' && p.body.id === id));
  const chunks = posts.slice(from).filter((p) => p.endpoint === 'replayChunk' && p.body.id === id);
  return { done, chunks };
}

const first = await capture('cap-1');
check(first.done, 'capture answers with a manifest');
const m = first.done ? first.done.body.manifest : { parts: [] };
const total = m.parts.reduce((a, p) => a + p.durationMs, 0);
check(m.parts.length >= 3, `manifest has the kept segments + the running one (${m.parts.length} parts)`);
check(total >= 4000 && total <= 4000 + 2000 + 1500, `covers at least the configured seconds (${total} ms)`);
check(m.width === 320 && m.height === 180 && m.fps === 10, 'manifest carries the recording format');
const partsB64 = m.parts.map((_, idx) => first.chunks.filter((c) => c.body.part === idx).sort((a, b) => a.body.seq - b.body.seq).map((c) => c.body.data).join(''));
check(m.parts.every((p, idx) => first.chunks.filter((c) => c.body.part === idx).length === p.chunks), 'chunk counts match the manifest');
check(partsB64.every((b) => Buffer.from(b, 'base64').readUInt32BE(0) === 0x1a45dfa3), 'every part is a standalone WebM file (EBML header)');
check(first.chunks.every((c) => /^[A-Za-z0-9+/]+=*$/.test(c.body.data) && c.body.data.length <= 240 * 1024), 'chunks are plain base64 within the size limit');
check(await page.evaluate(() => window.MG_REPLAY.state === 'recording' && !!window.MG_REPLAY.current), 'keeps recording after a capture');
await sleep(2500);
const second = await capture('cap-2');
const secondMs = second.done ? second.done.body.manifest.parts.reduce((a, p) => a + p.durationMs, 0) : 0;
check(second.done && secondMs > 1500 && secondMs < 3500, `a later capture only contains video recorded since the previous one (${secondMs} ms)`);

// ---------------------------------------------------------------- panel: replays page + player
console.log('panel');
await page.evaluate((perms) => window.postMessage({ type: 'open', info: { brand: 'MilcsoGuard', version: '1.1.0', role: 'Administrator', level: 60, permissions: perms, apiEnabled: true, apiOnline: true, notifyMin: 'MEDIUM', replayEnabled: true } }, '*'), PERMS);
await page.waitForSelector('#root:not(.hidden)');
check(await page.$('nav button[data-page="replays"]'), 'Visszajátszások menu item for replays.view');
await page.click('nav button[data-page="replays"]');
await page.waitForSelector('[data-play]');
check((await page.$$('[data-play]')).length === 1, 'only ready replays can be played');
check(await page.textContent('#content').then((t) => t.includes('timeout')), 'failed replays show the reason');
await page.screenshot({ path: path.join(here, 'artifacts/nui-replays.png') });

playParts = partsB64.length;
await page.click('[data-play]');
await page.waitForSelector('#rv');
for (const [idx, data] of partsB64.entries()) {
  await page.evaluate(([i, d, n]) => window.postMessage({ type: 'replayPart', part: { id: '3c2c3d4e-aaaa-4bbb-8ccc-ddddeeeeffff', idx: i, total: n, durationMs: 2000, mime: 'video/webm', data: d } }, '*'), [idx, data, partsB64.length]);
}
const meta = await page.waitForFunction(() => { const v = document.querySelector('#rv'); return v && v.src.startsWith('blob:') && v.readyState >= 1; }, null, { timeout: 8000 }).then(() => true).catch(() => false);
check(meta, 'the recorded WebM loads in the in-game player');
const nuiDur = await page.waitForFunction(() => { const v = document.querySelector('#rv'); return v && Number.isFinite(v.duration) && v.duration > 1 ? v.duration : null; }, null, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => null);
check(nuiDur !== null, `in-game player knows the real duration (${nuiDur} s)`);
const advanced = await page.waitForFunction(() => document.querySelector('#rvPart').textContent.startsWith('2.'), null, { timeout: 12000 }).then(() => true).catch(() => false);
check(advanced, 'playback continues with the next part when one ends');
await page.screenshot({ path: path.join(here, 'artifacts/nui-replay-player.png') });
check(posts.some((p) => p.endpoint === 'request' && p.body.action === 'replay.play' && p.body.payload.id === replayItem.id), 'replay.play requested with the replay id');
await page.keyboard.press('Escape');
check(await page.$eval('#modal', (el) => el.classList.contains('hidden') && el.innerHTML === ''), 'Escape closes the player and frees the video');

// ---------------------------------------------------------------- moderation tools
await page.click('nav button[data-page="players"]');
await page.waitForSelector('[data-act="details"]');
await page.click('[data-act="details"]');
await page.waitForSelector('[data-act="spectate"]');
for (const a of ['spectate', 'goto', 'bring', 'freeze', 'message', 'replay']) check(await page.$(`#content [data-act="${a}"]`), `player page has the ${a} tool`);
await page.screenshot({ path: path.join(here, 'artifacts/nui-player-tools.png') });
await page.click('#content [data-act="freeze"]');
check(await waitFor(() => posts.find((p) => p.body.action === 'player.freeze' && p.body.payload.freeze === true && p.body.payload.id === 7)), 'freeze sends player.freeze');
await page.click('#content [data-act="replay"]');
await page.fill('#mReason', 'report #5');
await page.click('#mOk');
check(await waitFor(() => posts.find((p) => p.body.action === 'replay.request' && p.body.payload.reason === 'report #5')), 'replay request needs and sends a reason');
await page.click('#content [data-act="message"]');
await page.fill('[data-field="message"]', 'Gyere a rendőrségre');
await page.click('#mOk');
check(await waitFor(() => posts.find((p) => p.body.action === 'player.message' && p.body.payload.message === 'Gyere a rendőrségre')), 'message is sent');
await page.click('#content [data-act="spectate"]');
check(await waitFor(() => posts.find((p) => p.body.action === 'player.spectate')), 'spectate requested');
check(await waitFor(() => posts.find((p) => p.endpoint === 'close')), 'the panel closes so the admin can watch');

await page.evaluate((perms) => window.postMessage({ type: 'open', info: { brand: 'MilcsoGuard', version: '1.1.0', role: 'Administrator', level: 60, permissions: perms, apiEnabled: true, apiOnline: true, replayEnabled: true, spectating: 7 } }, '*'), PERMS);
await page.evaluate(() => window.postMessage({ type: 'spectate', active: true, target: 7, name: 'Suspect' }, '*'));
check(await page.$eval('#specBar', (el) => !el.classList.contains('hidden') && el.textContent.includes('Suspect')), 'spectate banner shows the target');
await page.click('#specStop');
check(await waitFor(() => posts.find((p) => p.body.action === 'player.spectate.stop')), 'banner stops spectating');
await page.evaluate(() => window.postMessage({ type: 'spectate', active: false }, '*'));
check(await page.$eval('#specBar', (el) => el.classList.contains('hidden')), 'banner disappears');

// ---------------------------------------------------------------- recently left + offline ban
await page.click('nav button[data-page="players"]');
await page.waitForSelector('[data-ptab="recent"]');
await page.click('[data-ptab="recent"]');
await page.waitForSelector('[data-oban]');
await page.click('[data-oban]');
await page.fill('#mReason', 'combat log');
await page.selectOption('[data-field="duration"]', '604800');
await page.click('#mOk');
check(await waitFor(() => posts.find((p) => p.body.action === 'ban.offline' && p.body.payload.key === 'k-1' && p.body.payload.durationSeconds === 604800)), 'offline ban sends the stored key and duration');

check(!(await page.evaluate(() => window.__xss)), 'no injected HTML executed (names, reasons)');
check(errors.length === 0, `no console/page errors ${errors.join(' | ')}`);

await browser.close();
if (failures.length) {
  console.error('\nFAILED:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('\nNUI replay/tools e2e: all checks passed');
