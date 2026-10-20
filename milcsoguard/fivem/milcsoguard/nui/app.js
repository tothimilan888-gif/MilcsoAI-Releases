/* MilcsoGuard in-game admin panel.
 * Security notes:
 *  - Every value rendered here can be attacker controlled (player names, evidence). All
 *    interpolation goes through the `html` tagged template, which escapes by default.
 *  - Hiding a button is cosmetic. The server re-checks the permission for every request.
 */
(function () {
  'use strict';

  const RESOURCE = typeof GetParentResourceName === 'function' ? GetParentResourceName() : 'milcsoguard';
  const brand = window.MG_BRAND || {};
  const state = { info: null, perms: new Set(), page: 'dashboard', pageArg: null, live: [], reqId: 0, pending: new Map() };

  // ------------------------------------------------------------------ safe templating
  class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
  const raw = (s) => new Safe(String(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
  function render(v) {
    if (v instanceof Safe) return v.s;
    if (Array.isArray(v)) return v.map(render).join('');
    if (v === null || v === undefined || v === false) return '';
    return esc(v);
  }
  function html(strings, ...values) {
    let out = '';
    strings.forEach((s, i) => { out += s + (i < values.length ? render(values[i]) : ''); });
    return new Safe(out);
  }

  // ------------------------------------------------------------------ transport
  function post(endpoint, body) {
    return fetch(`https://${RESOURCE}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body || {}) }).catch(() => null);
  }
  function api(action, payload) {
    const reqId = ++state.reqId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { state.pending.delete(reqId); resolve({ ok: false, error: 'Időtúllépés – a szerver nem válaszolt.' }); }, 15000);
      state.pending.set(reqId, (res) => { clearTimeout(timer); resolve(res || { ok: false, error: 'Üres válasz' }); });
      post('request', { reqId, action, payload: payload || {} });
    });
  }

  // ------------------------------------------------------------------ helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const can = (p) => state.perms.has(p);
  const fmtTime = (iso) => { if (!iso) return '–'; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'medium' }); };
  const sev = (s) => html`<span class="badge sev-${['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(s) ? s : 'INFO'}">${s}</span>`;
  const ACTION_LABEL = { log: 'Napló', warn: 'Figyelmeztetés', monitor: 'Megfigyelés', kick: 'Kick', ban: 'Ban' };
  const REVIEW_LABEL = { pending: 'Függő', confirmed: 'Megerősítve', false_positive: 'Téves', dismissed: 'Elvetve' };
  const risk = (n) => { const v = Math.max(0, Math.min(100, Math.round((Number(n) || 0) / 1.4))); return html`<div class="risk"><div class="bar"><i style="width:${v}%"></i></div><span>${Math.round(Number(n) || 0)}</span></div>`; };
  const spinner = () => html`<div class="spinner" aria-label="Betöltés"></div>`;
  const empty = (t) => html`<div class="empty">${t}</div>`;
  const errorBox = (t) => html`<div class="error-box">${t}</div>`;

  function toast(message, kind) {
    const el = document.createElement('div');
    el.className = `toast ${kind || ''}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 5200);
  }

  function setContent(node) { $('#content').innerHTML = render(node); }

  // ------------------------------------------------------------------ modal (confirm + reason)
  function modal({ title, text, confirmLabel = 'Megerősítés', danger = false, reason = true, extra = '' }) {
    return new Promise((resolve) => {
      const m = $('#modal');
      m.innerHTML = render(html`<div class="box">
        <h3>${title}</h3>
        ${text ? html`<div class="muted">${text}</div>` : ''}
        ${raw(extra)}
        ${reason ? html`<label class="field">Indoklás (kötelező, min. 3 karakter)<textarea id="mReason" maxlength="500"></textarea></label>` : ''}
        <div class="row"><button class="btn ghost" id="mCancel">Mégse</button><button class="btn ${danger ? 'danger' : 'primary'}" id="mOk">${confirmLabel}</button></div>
      </div>`);
      m.classList.remove('hidden');
      const done = (v) => { m.classList.add('hidden'); m.innerHTML = ''; resolve(v); };
      const reasonEl = $('#mReason');
      if (reasonEl) reasonEl.focus();
      $('#mCancel').onclick = () => done(null);
      $('#mOk').onclick = () => {
        const r = reasonEl ? reasonEl.value.trim() : '';
        if (reason && r.length < 3) { reasonEl.focus(); reasonEl.style.borderColor = 'var(--sev-critical)'; return; }
        const values = {};
        m.querySelectorAll('[data-field]').forEach((el) => { values[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value; });
        done({ reason: r, values });
      };
    });
  }

  // ------------------------------------------------------------------ navigation
  const ICONS = {
    dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
    players: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M16 4a4 4 0 0 1 0 8M22 21c0-3-1.5-5-4-5.6"/>',
    detections: '<path d="M12 2 2 20h20L12 2zM12 9v5M12 17.5v.5"/>',
    bans: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    whitelist: '<path d="M12 2 4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z"/><path d="m8.5 12 2.5 2.5L16 9.5"/>',
    admins: '<circle cx="12" cy="7" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/><path d="m17 3 1 2 2 .3-1.5 1.4.4 2.1L17 7.8 15.1 8.8l.4-2.1L14 5.3l2-.3z"/>',
    logs: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h8M9 9h3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 10l2 2 3-4 2 3 3-2"/>',
  };
  const PAGES = [
    { key: 'dashboard', label: 'Dashboard', perm: 'detections.view' },
    { key: 'players', label: 'Játékosok', perm: 'players.view' },
    { key: 'detections', label: 'Detektálások', perm: 'detections.view' },
    { key: 'bans', label: 'Banok', perm: 'bans.view' },
    { key: 'whitelist', label: 'Whitelist', perm: 'whitelist.view' },
    { key: 'admins', label: 'Adminok', perm: 'admins.view' },
    { key: 'logs', label: 'Naplók', perm: 'audit.view' },
    { key: 'settings', label: 'Beállítások', perm: 'settings.view' },
    { key: 'system', label: 'Rendszer', perm: 'system.view' },
  ];

  function buildNav() {
    const nav = $('#nav');
    nav.innerHTML = render(PAGES.filter((p) => can(p.perm)).map((p) => html`<button data-page="${p.key}" class="${state.page === p.key || (state.page === 'player' && p.key === 'players') ? 'active' : ''}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${raw(ICONS[p.key])}</svg><span>${p.label}</span></button>`));
    nav.querySelectorAll('button').forEach((b) => { b.onclick = () => go(b.dataset.page); });
  }

  function go(page, arg) {
    state.page = page;
    state.pageArg = arg;
    buildNav();
    const def = PAGES.find((p) => p.key === page);
    $('#pageTitle').textContent = page === 'player' ? 'Játékos részletei' : def ? def.label : '';
    setContent(spinner());
    (VIEWS[page] || VIEWS.dashboard)(arg).catch((e) => setContent(errorBox(String(e))));
  }

  // ------------------------------------------------------------------ views
  const VIEWS = {};

  function detectionRow(d) {
    return html`<div class="feed-item">
      ${sev(d.severity)}
      <div><div class="title">${d.type}</div><div class="meta">${d.playerName || d.player_name || '?'} · #${d.netId ?? d.net_id ?? '?'} · ${fmtTime(d.occurredAt || d.occurred_at)} · forrás: ${d.source}</div></div>
      <span class="badge neutral">${ACTION_LABEL[d.action] || d.action}</span>
    </div>`;
  }

  VIEWS.dashboard = async function () {
    const r = await api('dashboard');
    if (!r.ok) return setContent(errorBox(r.error));
    const d = r.data;
    const rm = d.remote || {};
    const live = [...state.live, ...(d.recent || [])].slice(0, 10);
    setContent(html`
      <div class="grid stats">
        <div class="card stat"><div class="label">Online játékosok</div><div class="value">${d.onlinePlayers}</div></div>
        <div class="card stat"><div class="label">Mai detektálások</div><div class="value">${rm.detections_today ?? d.detectionsToday}</div><div class="hint">${rm.detections_today !== undefined ? 'backend' : 'helyi napló'}</div></div>
        <div class="card stat"><div class="label">Nyitott riasztások</div><div class="value">${rm.open_alerts ?? d.alertsToday}</div><div class="hint">HIGH / CRITICAL, felülvizsgálatra vár</div></div>
        <div class="card stat"><div class="label">Aktív banok</div><div class="value">${rm.active_bans ?? d.cachedBans}</div><div class="hint">${rm.active_bans !== undefined ? 'backend' : 'helyi gyorsítótár'}</div></div>
      </div>
      <div class="grid two" style="margin-top:14px">
        <div class="card"><h2>Legutóbbi detektálások</h2>${live.length ? html`<div class="list">${live.map(detectionRow)}</div>` : empty('Még nincs detektálás.')}</div>
        <div class="card"><h2>Kapcsolat</h2>
          <dl class="kv">
            <dt>Backend</dt><dd>${d.api.enabled ? (d.api.online ? html`<span class="badge ok">online</span>` : html`<span class="badge sev-HIGH">nem elérhető</span>`) : html`<span class="badge neutral">kikapcsolva (local-only)</span>`}</dd>
            ${d.api.lastError ? html`<dt>Utolsó hiba</dt><dd class="small">${d.api.lastError}</dd>` : ''}
            <dt>Helyi banok</dt><dd>${d.cachedBans}</dd>
          </dl>
          <p class="muted small">A kritikus védelem a backend nélkül is fut: a banok helyi gyorsítótárból érvényesülnek, a detektálások sorba kerülnek.</p>
        </div>
      </div>`);
  };

  VIEWS.players = async function () {
    const r = await api('players.list');
    if (!r.ok) return setContent(errorBox(r.error));
    const players = r.data || [];
    const draw = (filter) => {
      const f = (filter || '').toLowerCase();
      const list = players.filter((p) => !f || String(p.name).toLowerCase().includes(f) || String(p.id) === f || (p.identifiers || []).some((i) => i.toLowerCase().includes(f)));
      $('#playersBody').innerHTML = render(list.length ? list.map((p) => html`<tr>
        <td class="mono">${p.id}</td>
        <td><b>${p.name}</b> ${p.admin ? html`<span class="badge accent">${p.admin.role}</span>` : ''} ${p.monitored ? html`<span class="badge sev-MEDIUM">megfigyelt</span>` : ''}</td>
        <td>${p.ping} ms</td>
        <td>${risk(p.risk)}</td>
        <td class="small muted">${Math.floor(p.joinedSecondsAgo / 60)} perce</td>
        <td class="actions">
          <button class="btn sm" data-act="details" data-id="${p.id}">Részletek</button>
          ${can('players.kick') ? html`<button class="btn sm" data-act="kick" data-id="${p.id}">Kick</button>` : ''}
          ${can('bans.create') ? html`<button class="btn sm danger" data-act="ban" data-id="${p.id}">Ban</button>` : ''}
        </td></tr>`) : html`<tr><td colspan="6">${empty('Nincs találat.')}</td></tr>`);
      bindPlayerActions($('#playersBody'), players);
    };
    setContent(html`<div class="toolbar"><input id="pSearch" placeholder="Keresés név, ID vagy azonosító alapján" style="width:320px"><div class="spacer"></div><span class="muted">${players.length} online</span><button class="btn" id="pRefresh">Frissítés</button></div>
      <div class="card" style="padding:4px 6px"><table><thead><tr><th>ID</th><th>Név</th><th>Ping</th><th>Kockázat</th><th>Csatlakozott</th><th></th></tr></thead><tbody id="playersBody"></tbody></table></div>`);
    $('#pSearch').oninput = (e) => draw(e.target.value);
    $('#pRefresh').onclick = () => go('players');
    draw('');
  };

  function bindPlayerActions(root, players) {
    root.querySelectorAll('[data-act]').forEach((b) => {
      const id = Number(b.dataset.id);
      const p = (players || []).find((x) => x.id === id) || { id, name: '#' + id };
      b.onclick = async () => {
        if (b.dataset.act === 'details') return go('player', id);
        if (b.dataset.act === 'kick') return kickPlayer(p);
        if (b.dataset.act === 'ban') return banPlayer(p);
        if (b.dataset.act === 'monitor') {
          const r = await api('player.monitor', { id, minutes: 30 });
          toast(r.ok ? `${p.name} megfigyelés alatt (30 perc)` : r.error, r.ok ? 'success' : 'error');
        }
      };
    });
  }

  async function kickPlayer(p) {
    const res = await modal({ title: `Kick: ${p.name}`, text: 'A játékos azonnal lecsatlakozik. A művelet naplózásra kerül.', confirmLabel: 'Kick', danger: true });
    if (!res) return;
    const r = await api('kick', { id: p.id, reason: res.reason });
    toast(r.ok ? `${p.name} kickelve` : r.error, r.ok ? 'success' : 'error');
    if (r.ok && state.page === 'players') go('players');
  }

  async function banPlayer(p) {
    const options = [['3600', '1 óra'], ['86400', '1 nap'], ['259200', '3 nap'], ['604800', '7 nap'], ['2592000', '30 nap']];
    if (can('bans.permanent')) options.push(['permanent', 'Végleges']);
    const extra = render(html`<label class="field">Időtartam<select data-field="duration">${options.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></label>`);
    const res = await modal({ title: `Ban: ${p.name}`, text: 'A játékos minden ismert azonosítója tiltásra kerül, és azonnal lecsatlakozik.', confirmLabel: 'Ban kiadása', danger: true, extra });
    if (!res) return;
    const payload = { id: p.id, reason: res.reason };
    if (res.values.duration === 'permanent') payload.permanent = true; else payload.durationSeconds = Number(res.values.duration);
    const r = await api('ban.create', payload);
    toast(r.ok ? `${p.name} bannolva` : r.error, r.ok ? 'success' : 'error');
    if (r.ok && (state.page === 'players' || state.page === 'player')) go('players');
  }

  VIEWS.player = async function (id) {
    const r = await api('player.details', { id });
    if (!r.ok) return setContent(errorBox(r.error));
    const { player: p, riskHistory, localDetections, remote } = r.data;
    const rd = remote || {};
    setContent(html`
      <div class="toolbar"><button class="btn ghost" id="back">← Vissza</button><div class="spacer"></div>
        ${can('detections.review') ? html`<button class="btn sm" data-act="monitor" data-id="${p.id}">Megfigyelés 30 percig</button>` : ''}
        ${can('players.kick') ? html`<button class="btn sm" data-act="kick" data-id="${p.id}">Kick</button>` : ''}
        ${can('bans.create') ? html`<button class="btn sm danger" data-act="ban" data-id="${p.id}">Ban</button>` : ''}</div>
      <div class="grid two">
        <div class="card"><h2>${p.name} · #${p.id}</h2>
          <dl class="kv"><dt>Kockázat</dt><dd>${risk(p.risk)}</dd><dt>Ping</dt><dd>${p.ping} ms</dd>
          <dt>Megfigyelt</dt><dd>${p.monitored ? 'igen' : 'nem'}</dd><dt>Admin</dt><dd>${p.admin ? `${p.admin.role} (${p.admin.source})` : '–'}</dd>
          <dt>Azonosítók</dt><dd class="mono">${(p.identifiers || []).map((i) => html`<div>${i}</div>`)}</dd>
          ${rd.player ? html`<dt>Első látogatás</dt><dd>${fmtTime(rd.player.first_seen)}</dd><dt>Jegyzet</dt><dd>${rd.player.notes || '–'}</dd>` : ''}</dl>
        </div>
        <div class="card"><h2>Kockázati előzmények (munkamenet)</h2>${(riskHistory || []).length ? html`<div class="list">${riskHistory.slice().reverse().map((h) => html`<div class="feed-item"><span class="badge neutral">+${Math.round(h.points)}</span><div class="title">${h.type}</div><span class="muted small">${h.source}</span></div>`)}</div>` : empty('Nincs kockázati esemény.')}</div>
      </div>
      <div class="card" style="margin-top:14px"><h2>Detektálások</h2>
        ${(rd.detections || localDetections || []).length ? html`<div class="list">${(rd.detections || localDetections).map(detectionRow)}</div>` : empty('Nincs detektálás.')}</div>
      ${rd.bans ? html`<div class="card" style="margin-top:14px"><h2>Banok</h2>${rd.bans.length ? html`<table><thead><tr><th>Kód</th><th>Ok</th><th>Státusz</th><th>Lejár</th></tr></thead><tbody>${rd.bans.map((b) => html`<tr><td class="mono">${b.public_code}</td><td>${b.reason}</td><td>${b.status}</td><td>${b.expires_at ? fmtTime(b.expires_at) : 'végleges'}</td></tr>`)}</tbody></table>` : empty('Nincs ban.')}</div>` : html`<div class="notice" style="margin-top:14px">A teljes előzmény (banok, korábbi munkamenetek) a backendből érkezik, ami most nem elérhető.</div>`}`);
    $('#back').onclick = () => go('players');
    bindPlayerActions($('#content'), [p]);
  };

  VIEWS.detections = async function (arg) {
    const q = Object.assign({ page: 1, severity: '', review: '', q: '' }, arg || {});
    const r = await api('detections.list', q);
    if (!r.ok) return setContent(errorBox(r.error));
    const isRemote = r.data.source === 'backend';
    const items = isRemote ? r.data.page.items : r.data.items;
    const total = isRemote ? r.data.page.total : items.length;
    const pages = isRemote ? Math.max(1, Math.ceil(total / r.data.page.pageSize)) : 1;
    setContent(html`
      ${isRemote ? '' : html`<div class="notice">Backend nem elérhető – a helyi (memóriabeli) napló látható, felülvizsgálat nem lehetséges.</div>`}
      <div class="toolbar">
        <input id="dQ" placeholder="Játékos vagy típus" value="${q.q}">
        <select id="dSev"><option value="">Minden súlyosság</option>${['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => html`<option ${q.severity === s ? raw('selected') : ''}>${s}</option>`)}</select>
        <select id="dRev"><option value="">Minden státusz</option>${Object.entries(REVIEW_LABEL).map(([k, v]) => html`<option value="${k}" ${q.review === k ? raw('selected') : ''}>${v}</option>`)}</select>
        <button class="btn" id="dApply">Szűrés</button><div class="spacer"></div><span class="muted">${total} találat</span>
      </div>
      <div class="card" style="padding:4px 6px">${items.length ? html`<table><thead><tr><th>Idő</th><th>Súlyosság</th><th>Típus</th><th>Játékos</th><th>Forrás</th><th>Intézkedés</th><th>Kockázat</th><th>Státusz</th><th></th></tr></thead><tbody>
        ${items.map((d, i) => html`<tr>
          <td class="small">${fmtTime(d.occurred_at || d.occurredAt)}</td><td>${sev(d.severity)}</td><td>${d.type}</td>
          <td>${d.player_name || d.playerName} <span class="muted">#${d.net_id ?? d.netId ?? '?'}</span></td><td>${d.source}</td>
          <td>${ACTION_LABEL[d.action] || d.action}${(d.action_result || d.actionResult) ? html`<div class="muted small">${d.action_result || d.actionResult}</div>` : ''}</td>
          <td>${d.risk_score ?? d.riskScore}</td><td>${isRemote ? REVIEW_LABEL[d.review_status] || d.review_status : '–'}</td>
          <td class="actions"><button class="btn sm" data-ev="${i}">Bizonyíték</button>${isRemote && can('detections.review') ? html`<button class="btn sm" data-rev="${i}">Felülvizsgálat</button>` : ''}</td></tr>`)}
      </tbody></table>` : empty('Nincs detektálás a szűrésnek megfelelően.')}</div>
      ${isRemote ? html`<div class="pager"><button class="btn sm" id="dPrev" ${q.page <= 1 ? raw('disabled') : ''}>‹</button><span>${q.page} / ${pages}</span><button class="btn sm" id="dNext" ${q.page >= pages ? raw('disabled') : ''}>›</button></div>` : ''}`);
    const collect = () => ({ page: 1, q: $('#dQ').value.trim(), severity: $('#dSev').value, review: $('#dRev').value });
    $('#dApply').onclick = () => go('detections', collect());
    if ($('#dPrev')) $('#dPrev').onclick = () => go('detections', Object.assign(collect(), { page: q.page - 1 }));
    if ($('#dNext')) $('#dNext').onclick = () => go('detections', Object.assign(collect(), { page: q.page + 1 }));
    document.querySelectorAll('[data-ev]').forEach((b) => {
      b.onclick = () => {
        const d = items[Number(b.dataset.ev)];
        modal({ title: d.type, text: 'Bizonyíték (JSON, a szerver által rögzítve):', reason: false, confirmLabel: 'Bezárás', extra: render(html`<pre class="json">${JSON.stringify(d.evidence || {}, null, 2)}</pre>`) });
      };
    });
    document.querySelectorAll('[data-rev]').forEach((b) => {
      b.onclick = async () => {
        const d = items[Number(b.dataset.rev)];
        const extra = render(html`<label class="field">Döntés<select data-field="status"><option value="confirmed">Megerősítve (valós csalás)</option><option value="false_positive">Téves detektálás</option><option value="dismissed">Elvetve</option><option value="pending">Vissza függőbe</option></select></label>`);
        const res = await modal({ title: `Felülvizsgálat: ${d.type}`, text: `${d.player_name} – ${fmtTime(d.occurred_at)}`, extra, confirmLabel: 'Mentés' });
        if (!res) return;
        const rr = await api('detections.review', { id: d.id, status: res.values.status, note: res.reason });
        toast(rr.ok ? 'Felülvizsgálat mentve' : rr.error, rr.ok ? 'success' : 'error');
        if (rr.ok) go('detections', q);
      };
    });
  };

  VIEWS.bans = async function (arg) {
    const q = Object.assign({ page: 1, status: 'active', q: '' }, arg || {});
    const r = await api('bans.list', q);
    if (!r.ok) return setContent(errorBox(r.error));
    const isRemote = r.data.source === 'backend';
    const items = isRemote ? r.data.page.items : r.data.items;
    const total = isRemote ? r.data.page.total : items.length;
    const pages = isRemote ? Math.max(1, Math.ceil(total / r.data.page.pageSize)) : 1;
    setContent(html`
      ${isRemote ? '' : html`<div class="notice">Backend nem elérhető – a helyi ban-gyorsítótár látható (csak aktív banok).</div>`}
      <div class="toolbar">
        ${isRemote ? html`<div class="tabs">${[['active', 'Aktív'], ['expired', 'Lejárt'], ['revoked', 'Feloldott'], ['all', 'Mind']].map(([k, l]) => html`<button data-status="${k}" class="${q.status === k ? 'active' : ''}">${l}</button>`)}</div>` : ''}
        <input id="bQ" placeholder="Név, kód, ok" value="${q.q}"><button class="btn" id="bApply">Keresés</button><div class="spacer"></div><span class="muted">${total} ban</span>
      </div>
      <div class="card" style="padding:4px 6px">${items.length ? html`<table><thead><tr><th>Kód</th><th>Játékos</th><th>Ok</th><th>Létrehozta</th><th>Lejár</th><th>Státusz</th><th></th></tr></thead><tbody>
        ${items.map((b, i) => html`<tr><td class="mono">${b.public_code || b.code}${b.pending ? html` <span class="badge sev-MEDIUM">szinkronra vár</span>` : ''}</td><td>${b.player_name}</td><td>${b.reason}</td>
          <td class="small">${b.created_by_label || '–'}<div class="muted">${fmtTime(b.created_at)}</div></td><td>${b.expires_at ? fmtTime(b.expires_at) : 'végleges'}</td>
          <td><span class="badge ${b.status === 'active' ? 'sev-HIGH' : 'neutral'}">${b.status}</span>${b.revoke_reason ? html`<div class="muted small">${b.revoked_by_label}: ${b.revoke_reason}</div>` : ''}</td>
          <td class="actions">${b.status === 'active' && can('bans.remove') ? html`<button class="btn sm" data-unban="${i}">Feloldás</button>` : ''}</td></tr>`)}
      </tbody></table>` : empty('Nincs ban.')}</div>
      ${isRemote ? html`<div class="pager"><button class="btn sm" id="bPrev" ${q.page <= 1 ? raw('disabled') : ''}>‹</button><span>${q.page} / ${pages}</span><button class="btn sm" id="bNext" ${q.page >= pages ? raw('disabled') : ''}>›</button></div>` : ''}`);
    document.querySelectorAll('[data-status]').forEach((b) => { b.onclick = () => go('bans', { status: b.dataset.status, q: $('#bQ').value.trim() }); });
    $('#bApply').onclick = () => go('bans', { status: q.status, q: $('#bQ').value.trim() });
    if ($('#bPrev')) $('#bPrev').onclick = () => go('bans', Object.assign({}, q, { page: q.page - 1 }));
    if ($('#bNext')) $('#bNext').onclick = () => go('bans', Object.assign({}, q, { page: q.page + 1 }));
    document.querySelectorAll('[data-unban]').forEach((b) => {
      b.onclick = async () => {
        const ban = items[Number(b.dataset.unban)];
        const res = await modal({ title: `Ban feloldása: ${ban.player_name}`, text: `${ban.public_code || ban.code} – ${ban.reason}`, confirmLabel: 'Feloldás' });
        if (!res) return;
        const rr = await api('ban.revoke', { id: ban.id, reason: res.reason });
        toast(rr.ok ? 'Ban feloldva' : rr.error, rr.ok ? 'success' : 'error');
        if (rr.ok) go('bans', q);
      };
    });
  };

  VIEWS.whitelist = async function () {
    const r = await api('whitelist.list');
    if (!r.ok) return setContent(errorBox(r.error));
    const items = r.data.items || [];
    const KIND = { player: 'Játékos', resource: 'Resource', model: 'Modell' };
    setContent(html`
      ${r.data.source === 'backend' ? '' : html`<div class="notice">Backend nem elérhető – a legutóbb szinkronizált whitelist látható, módosítás nem lehetséges.</div>`}
      ${can('whitelist.manage') ? html`<div class="card" style="margin-bottom:14px"><h2>Új bejegyzés</h2><div class="toolbar">
        <select id="wKind"><option value="player">Játékos (azonosító vagy online ID)</option><option value="resource">Megbízható resource</option><option value="model">Engedélyezett modell</option></select>
        <input id="wValue" placeholder="license:… / 12 / resource név / modell" style="width:260px"><input id="wModules" placeholder="Modulok (vesszővel, üres = mind)" style="width:240px">
        <input id="wNote" placeholder="Megjegyzés"><button class="btn primary" id="wAdd">Hozzáadás</button></div>
        <div class="muted small">Játékos-whitelist: a megadott modulok nem futnak rá (pl. movement.* az admin noclip miatt). Resource: entitásspawnok engedélyezése. Modell: spawn tiltólista alóli kivétel.</div></div>` : ''}
      <div class="card" style="padding:4px 6px">${items.length ? html`<table><thead><tr><th>Típus</th><th>Érték</th><th>Modulok</th><th>Megjegyzés</th><th>Létrehozta</th><th></th></tr></thead><tbody>
        ${items.map((w) => html`<tr><td>${KIND[w.kind] || w.kind}</td><td class="mono">${w.value}</td><td>${(w.modules || []).length ? w.modules.join(', ') : 'mind'}</td><td>${w.note}</td><td class="small">${w.created_by_label}</td>
          <td class="actions">${can('whitelist.manage') && r.data.source === 'backend' ? html`<button class="btn sm danger" data-del="${w.id}">Törlés</button>` : ''}</td></tr>`)}
      </tbody></table>` : empty('A whitelist üres.')}</div>`);
    if ($('#wAdd')) $('#wAdd').onclick = async () => {
      const modules = $('#wModules').value.split(',').map((s) => s.trim()).filter(Boolean);
      const rr = await api('whitelist.add', { kind: $('#wKind').value, value: $('#wValue').value.trim(), modules, note: $('#wNote').value.trim() });
      toast(rr.ok ? 'Bejegyzés hozzáadva' : rr.error, rr.ok ? 'success' : 'error');
      if (rr.ok) go('whitelist');
    };
    document.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const res = await modal({ title: 'Whitelist bejegyzés törlése', confirmLabel: 'Törlés', danger: true, reason: false });
        if (!res) return;
        const rr = await api('whitelist.remove', { id: b.dataset.del });
        toast(rr.ok ? 'Törölve' : rr.error, rr.ok ? 'success' : 'error');
        if (rr.ok) go('whitelist');
      };
    });
  };

  VIEWS.admins = async function () {
    const r = await api('admins.list');
    if (!r.ok) return setContent(errorBox(r.error));
    const d = r.data;
    setContent(html`<div class="grid two">
      <div class="card"><h2>Online adminok</h2>${d.online.length ? html`<table><thead><tr><th>ID</th><th>Név</th><th>Szerepkör</th><th>Forrás</th></tr></thead><tbody>${d.online.map((a) => html`<tr><td>${a.id}</td><td>${a.name}</td><td><span class="badge accent">${a.role}</span></td><td>${a.source}</td></tr>`)}</tbody></table>` : empty('Nincs online admin.')}</div>
      <div class="card"><h2>Szerepkör hierarchia</h2><table><tbody>${d.roles.map((x) => html`<tr><td>${x.label}</td><td class="muted">szint ${x.level}</td></tr>`)}</tbody></table>
        <p class="muted small">Adminok hozzáadása és szerepkörök módosítása a webes dashboardon történik (eszkalációvédelemmel). ACE-alapú jogok: <span class="mono">add_ace group.admin milcsoguard.role.administrator allow</span></p></div>
    </div>
    <div class="card" style="margin-top:14px"><h2>Webes fiókok (backend)</h2>${d.members ? (d.members.length ? html`<table><thead><tr><th>Felhasználó</th><th>Szerepkör</th><th>Kötött azonosítók</th><th>Utolsó belépés</th></tr></thead><tbody>${d.members.map((m) => html`<tr><td>${m.username}</td><td>${m.role_name}</td><td class="mono small">${(m.identifiers || []).join(', ') || '–'}</td><td>${fmtTime(m.last_login_at)}</td></tr>`)}</tbody></table>` : empty('Nincs tag.')) : html`<div class="notice">Backend nem elérhető.</div>`}</div>`);
  };

  VIEWS.logs = async function (arg) {
    const q = Object.assign({ page: 1, action: '', actor: '' }, arg || {});
    const r = await api('audit.list', q);
    if (!r.ok) return setContent(errorBox(r.error));
    const pg = r.data;
    const pages = Math.max(1, Math.ceil(pg.total / pg.pageSize));
    setContent(html`<div class="toolbar"><input id="lAction" placeholder="Művelet (pl. ban.)" value="${q.action}"><input id="lActor" placeholder="Végrehajtó" value="${q.actor}"><button class="btn" id="lApply">Szűrés</button><div class="spacer"></div><span class="muted">${pg.total} bejegyzés</span></div>
      <div class="card" style="padding:4px 6px">${pg.items.length ? html`<table><thead><tr><th>Idő</th><th>Végrehajtó</th><th>Művelet</th><th>Cél</th><th>Részletek</th></tr></thead><tbody>
        ${pg.items.map((a) => html`<tr><td class="small">${fmtTime(a.created_at)}</td><td>${a.actor_label}<div class="muted small">${a.actor_type}</div></td><td class="mono">${a.action}</td><td class="small">${a.target_type || ''} ${a.target_id ? String(a.target_id).slice(0, 8) : ''}</td><td><pre class="json" style="max-height:90px">${JSON.stringify(a.details)}</pre></td></tr>`)}
      </tbody></table>` : empty('Nincs bejegyzés.')}</div>
      <div class="pager"><button class="btn sm" id="lPrev" ${q.page <= 1 ? raw('disabled') : ''}>‹</button><span>${q.page} / ${pages}</span><button class="btn sm" id="lNext" ${q.page >= pages ? raw('disabled') : ''}>›</button></div>`);
    const collect = () => ({ action: $('#lAction').value.trim(), actor: $('#lActor').value.trim() });
    $('#lApply').onclick = () => go('logs', Object.assign(collect(), { page: 1 }));
    $('#lPrev').onclick = () => go('logs', Object.assign(collect(), { page: q.page - 1 }));
    $('#lNext').onclick = () => go('logs', Object.assign(collect(), { page: q.page + 1 }));
  };

  VIEWS.settings = async function () {
    const r = await api('settings.get');
    if (!r.ok) return setContent(errorBox(r.error));
    const { schema, effective, canEdit, version } = r.data;
    const cats = {};
    Object.entries(schema.modules).forEach(([key, spec]) => { (cats[spec.category] = cats[spec.category] || []).push([key, spec]); });
    const CAT = { movement: 'Mozgás és fizika', player: 'Játékosállapot', weapons: 'Fegyverek és sebzés', entities: 'Entitások és robbanások', events: 'Eventek és gazdaság', resources: 'Resource-ok', client: 'Kliensoldali jelzések (soha nem bannolnak)' };
    const dis = canEdit ? '' : raw('disabled');
    const paramInput = (key, name, spec, value) => {
      const id = `p|${key}|${name}`;
      if (spec.type === 'boolean') return html`<label class="field">${spec.label}<select data-param="${id}" data-type="boolean" ${dis}><option value="true" ${value ? raw('selected') : ''}>igen</option><option value="false" ${!value ? raw('selected') : ''}>nem</option></select></label>`;
      if (spec.type === 'list') return html`<label class="field">${spec.label}<input data-param="${id}" data-type="list" value="${(value || []).join(', ')}" ${dis}></label>`;
      return html`<label class="field">${spec.label}${spec.unit ? ` (${spec.unit})` : ''} <span class="muted">[${spec.min}–${spec.max}]</span><input type="number" step="${spec.type === 'integer' ? 1 : 'any'}" min="${spec.min}" max="${spec.max}" data-param="${id}" data-type="${spec.type}" value="${value}" ${dis}></label>`;
    };
    setContent(html`
      <div class="notice">Konfiguráció verzió: v${version}. ${canEdit ? 'A módosítás a backendre kerül (auditálva), és minden szerverpéldány érvényesíti.' : 'Csak olvasható (settings.manage jog és backend kapcsolat szükséges).'}
        A kliensoldali modulok automatikus banra nem állíthatók – ezt a szerver és a backend is elutasítja.</div>
      ${Object.entries(cats).map(([cat, mods]) => html`<div class="card settings-group"><h2>${CAT[cat] || cat}</h2>
        ${mods.map(([key, spec]) => { const e = effective[key]; return html`<div class="module-row" data-module="${key}">
          <div><div class="name">${spec.label} <span class="muted mono small">${key}</span></div><div class="desc">${spec.description}</div>${spec.limitations ? html`<div class="desc">⚠ ${spec.limitations}</div>` : ''}</div>
          <select data-k="action" ${dis}>${schema.actions.filter((a) => !(spec.source === 'client' && a === 'ban')).map((a) => html`<option value="${a}" ${e.action === a ? raw('selected') : ''}>${ACTION_LABEL[a] || a}</option>`)}</select>
          <select data-k="severity" ${dis}>${schema.severities.map((s) => html`<option ${e.severity === s ? raw('selected') : ''}>${s}</option>`)}</select>
          <label class="switch" title="Engedélyezve"><input type="checkbox" data-k="enabled" ${e.enabled ? raw('checked') : ''} ${dis}><span></span></label>
          ${Object.keys(spec.params || {}).length ? html`<div class="params">${Object.entries(spec.params).map(([n, ps]) => paramInput(key, n, ps, e.params[n]))}</div>` : ''}
        </div>`; })}</div>`)}
      ${canEdit ? html`<div class="toolbar"><div class="spacer"></div><button class="btn primary" id="sSave">Mentés…</button></div>` : ''}`);
    if (!canEdit) return;
    $('#sSave').onclick = async () => {
      const overrides = { modules: {}, risk: {} };
      document.querySelectorAll('[data-module]').forEach((row) => {
        const key = row.dataset.module;
        const o = { enabled: row.querySelector('[data-k=enabled]').checked, action: row.querySelector('[data-k=action]').value, severity: row.querySelector('[data-k=severity]').value, params: {} };
        row.querySelectorAll('[data-param]').forEach((inp) => {
          const name = inp.dataset.param.split('|')[2];
          const t = inp.dataset.type;
          if (t === 'boolean') o.params[name] = inp.value === 'true';
          else if (t === 'list') o.params[name] = inp.value.split(',').map((s) => s.trim()).filter(Boolean);
          else o.params[name] = Number(inp.value);
        });
        overrides.modules[key] = o;
      });
      const res = await modal({ title: 'Beállítások mentése', text: 'A változás azonnal életbe lép és auditnaplóba kerül.', confirmLabel: 'Mentés' });
      if (!res) return;
      const rr = await api('settings.save', { overrides, note: res.reason });
      toast(rr.ok ? `Mentve (v${rr.data.version})` : rr.error, rr.ok ? 'success' : 'error');
      if (rr.ok) go('settings');
    };
  };

  VIEWS.system = async function () {
    const r = await api('system.status');
    if (!r.ok) return setContent(errorBox(r.error));
    const d = r.data;
    const yes = (b) => (b ? html`<span class="badge ok">igen</span>` : html`<span class="badge sev-HIGH">nem</span>`);
    setContent(html`<div class="grid two">
      <div class="card"><h2>Játékszerver</h2><dl class="kv">
        <dt>MilcsoGuard</dt><dd>v${d.version}</dd><dt>Artifact</dt><dd class="small">${d.artifact || '?'}</dd>
        <dt>OneSync</dt><dd>${d.onesync} ${d.onesync === 'off' ? html`<span class="badge sev-CRITICAL">szerveroldali ellenőrzések inaktívak</span>` : ''}</dd>
        <dt>sv_entityLockdown</dt><dd>${d.entityLockdown}</dd><dt>Framework</dt><dd>${d.framework}${d.inventory ? ` + ${d.inventory}_inventory` : ''}</dd>
        <dt>Függőségek</dt><dd>${Object.entries(d.deps || {}).map(([k, v]) => html`<div class="small">${k}: ${v}</div>`)}${Object.keys(d.deps || {}).length ? '' : '–'}</dd>
        <dt>Uptime</dt><dd>${Math.floor(d.uptimeSeconds / 3600)} óra ${Math.floor((d.uptimeSeconds % 3600) / 60)} perc</dd>
        <dt>Konfiguráció</dt><dd>v${d.configVersion}</dd><dt>Helyi banok</dt><dd>${d.cachedBans} (utolsó szinkron: ${fmtTime(d.lastBanSync)})</dd>
        <dt>Auto-ban breaker</dt><dd>${d.breaker.open ? html`<span class="badge sev-CRITICAL">nyitva</span>` : html`<span class="badge ok">zárva</span>`} (${d.breaker.recent} friss auto-ban)</dd>
        <dt>Detektálások (futás óta)</dt><dd>${d.counters.total}</dd></dl></div>
      <div class="card"><h2>Backend kapcsolat</h2><dl class="kv">
        <dt>Engedélyezve</dt><dd>${yes(d.api.enabled)}</dd><dt>Online</dt><dd>${yes(d.api.online)}</dd>
        <dt>Szerver</dt><dd>${d.api.server || '–'}</dd><dt>Utolsó sikeres</dt><dd>${fmtTime(d.api.lastOkAt)}</dd>
        <dt>Utolsó hiba</dt><dd class="small">${d.api.lastError || '–'}</dd><dt>Kimenő sor</dt><dd>${d.api.queue} elem</dd>
        <dt>Küldve / hiba / eldobva</dt><dd>${d.api.stats.sent} / ${d.api.stats.failed} / ${d.api.stats.dropped}</dd></dl></div>
    </div>
    <div class="card" style="margin-top:14px"><h2>Rendszeresemények</h2>${d.events ? (d.events.length ? html`<div class="list">${d.events.map((e) => html`<div class="feed-item">${sev(e.severity)}<div><div class="title">${e.message}</div><div class="meta">${e.type}</div></div><span class="muted small">${fmtTime(e.created_at)}</span></div>`)}</div>` : empty('Nincs esemény.')) : html`<div class="notice">Backend nem elérhető.</div>`}</div>`);
  };

  // ------------------------------------------------------------------ lifecycle
  function applyBrand() {
    const root = document.documentElement;
    if (brand.accent) root.style.setProperty('--accent', brand.accent);
    if (brand.accent2) root.style.setProperty('--accent2', brand.accent2);
    $('#brandName').textContent = brand.name || 'MilcsoGuard';
    $('#brandTag').textContent = brand.tagline || 'Anticheat';
  }

  function updateStatus() {
    const el = $('#apiStatus');
    const i = state.info;
    el.className = 'status ' + (!i.apiEnabled ? '' : i.apiOnline ? 'ok' : 'down');
    el.querySelector('span').textContent = !i.apiEnabled ? 'Local-only' : i.apiOnline ? 'Backend online' : 'Backend nem elérhető';
  }

  function open(info) {
    state.info = info;
    state.perms = new Set(info.permissions || []);
    applyBrand();
    $('#roleChip').textContent = `${info.role} · szint ${info.level}`;
    $('#version').textContent = `v${info.version}`;
    updateStatus();
    $('#root').classList.remove('hidden');
    const first = PAGES.find((p) => can(p.perm));
    go(state.page && PAGES.some((p) => p.key === state.page && can(p.perm)) ? state.page : first ? first.key : 'dashboard');
  }

  function close() {
    $('#root').classList.add('hidden');
    $('#modal').classList.add('hidden');
    post('close');
  }

  $('#closeBtn').onclick = close;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('#root').classList.contains('hidden')) return;
    if (!$('#modal').classList.contains('hidden')) { $('#modal').classList.add('hidden'); return; }
    close();
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'open') open(m.info || {});
    else if (m.type === 'response') {
      const cb = state.pending.get(m.reqId);
      if (cb) { state.pending.delete(m.reqId); cb(m.result); }
    } else if (m.type === 'detection' && m.detection) {
      state.live.unshift(m.detection);
      state.live = state.live.slice(0, 20);
      const rank = { INFO: 1, LOW: 2, MEDIUM: 3, HIGH: 4, CRITICAL: 5 };
      if ((rank[m.detection.severity] || 0) >= (rank[(state.info || {}).notifyMin] || 3)) toast(`${m.detection.severity}: ${m.detection.type} – ${m.detection.playerName} (#${m.detection.netId}) → ${ACTION_LABEL[m.detection.action] || m.detection.action}`, 'error');
      if (state.page === 'dashboard' && $('.modal.hidden')) go('dashboard');
    } else if (m.type === 'system' && m.event) {
      toast(String(m.event.message), m.event.severity === 'CRITICAL' ? 'error' : '');
    }
  });
})();
