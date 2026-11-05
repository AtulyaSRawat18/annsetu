/* AnnSetu — Application Layer (MySQL + XAMPP Backend)
   All data lives in MySQL database 'annsetu' hosted via XAMPP.
   Data queries and mutations are performed via asynchronous API endpoints in /api. */

const S = {
  log: [],
  charts: [],
  inv: { status: 'All', q: '', cat: '' },
  reqFilter: 'open',
  selectedReq: null,
  report: 0,
  consoleSql: "SELECT product, warehouse, qty_available, days_left, status\nFROM v_batch_status\nWHERE status IN ('Critical','Near Expiry')\nORDER BY days_left;"
};

const $ = (s, el = document) => el.querySelector(s);
const view = () => $('#view');

/* ---------- Central API Client ---------- */
function getApiUrl(endpoint) {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://') || endpoint.startsWith('/')) {
    return endpoint;
  }
  let path = window.location.pathname;
  if (!path.endsWith('/')) {
    if (path.includes('.')) {
      path = path.substring(0, path.lastIndexOf('/') + 1);
    } else {
      path = path + '/';
    }
  }
  return path + endpoint;
}

async function api(url, body = null) {
  const fullUrl = getApiUrl(url);
  const t0 = performance.now();
  const method = body ? 'POST' : 'GET';
  const opts = body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  } : { method: 'GET' };

  try {
    const res = await fetch(fullUrl, opts);
    const ms = (performance.now() - t0).toFixed(1);
    const data = await res.json().catch(() => ({}));
    
    logAPI(method, fullUrl, res.status, ms, body, data);

    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return data;
  } catch (err) {
    const ms = (performance.now() - t0).toFixed(1);
    if (!url.includes('logAPI')) {
      logAPI(method, fullUrl, 'ERR', ms, body, { error: err.message });
    }
    throw err;
  }
}

function logAPI(method, url, status, ms, reqBody, resData) {
  const entry = {
    method,
    url,
    status,
    ms,
    req: reqBody ? JSON.stringify(reqBody, null, 2) : null,
    res: resData ? JSON.stringify(resData, null, 2) : null,
    t: new Date().toLocaleTimeString('en-IN')
  };
  S.log.unshift(entry);
  if (S.log.length > 100) S.log.pop();
  const badge = $('#logCount');
  if (badge) badge.textContent = S.log.length;
  if ($('#drawer').classList.contains('open')) renderLog();
}

/* ---------- UI Helpers ---------- */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 1) => (n === null || n === undefined || n === '') ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d });
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const pillCls = (s) => 's-' + String(s).split(' ')[0];
const pill = (s) => `<span class="pill ${pillCls(s)}">${esc(s)}</span>`;
const icons = () => window.lucide && lucide.createIcons();
const niceDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const daysText = (n) => n < 0 ? `${-n} day${n === -1 ? '' : 's'} ago` : n === 0 ? 'Expires today' : `in ${n} day${n === 1 ? '' : 's'}`;

const KW = 'SELECT|FROM|WHERE|JOIN|LEFT|INNER|ON|AND|OR|NOT|IN|IS|NULL|AS|GROUP|BY|ORDER|HAVING|LIMIT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|VIEW|TRIGGER|INDEX|BEGIN|COMMIT|ROLLBACK|TRANSACTION|END|CASE|WHEN|THEN|ELSE|WITH|RECURSIVE|UNION|ALL|DISTINCT|COUNT|SUM|AVG|MIN|MAX|ROUND|IFNULL|COALESCE|CAST|OVER|PARTITION|RANK|DENSE_RANK|ROW_NUMBER|EXISTS|BETWEEN|LIKE|DESC|ASC|PRIMARY|KEY|REFERENCES|FOREIGN|CHECK|UNIQUE|DEFAULT|INTEGER|TEXT|REAL|DATE|DATETIME|AFTER|BEFORE|FOR|EACH|ROW|CALL|PROCEDURE';
const TOK = new RegExp(`(--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|('(?:[^']|'')*')|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(${KW})\\b`, 'gi');
function hl(sql) {
  let out = '', last = 0;
  sql.replace(TOK, (m, cm, str, num, kw, idx) => {
    out += esc(sql.slice(last, idx));
    out += cm ? `<span class="cm">${esc(m)}</span>` : str ? `<span class="str">${esc(m)}</span>` : num ? `<span class="numl">${m}</span>` : `<span class="kw">${esc(m.toUpperCase())}</span>`;
    last = idx + m.length; return m;
  });
  return out + esc(sql.slice(last));
}
const tidy = (sql) => String(sql || '').replace(/^\n+|\s+$/g, '').replace(/^ {2,}/gm, (m) => m.slice(Math.min(m.length, 2)));
const sqlBlock = (sql) => `<pre class="code">${hl(tidy(sql))}</pre>`;

function toast(title, msg = '', err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.innerHTML = `<b>${esc(title)}</b>${msg ? `<span class="muted small">${esc(msg)}</span>` : ''}`;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 4200);
}

function openModal(title, html, onMount) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modalWrap').classList.add('on');
  icons();
  if (onMount) onMount($('#modalBody'));
}
const closeModal = () => $('#modalWrap').classList.remove('on');

function table(rows, cols) {
  if (!rows || !rows.length) return `<div class="empty">No rows match.</div>`;
  return `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.h}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.r ? c.r(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function resultTable(res) {
  if (!res || !res.columns) return '';
  return `<div class="table-wrap"><table class="result-table"><thead><tr>${res.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
  <tbody>${(res.values || []).map((v) => `<tr>${v.map((x) => `<td>${x === null ? '<span class="muted">NULL</span>' : esc(typeof x === 'number' && !Number.isInteger(x) ? Math.round(x * 100) / 100 : x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function killCharts() { S.charts.forEach((c) => c.destroy()); S.charts = []; }
const opts = (rows, val, label, sel) => (rows || []).map((r) => `<option value="${r[val]}" ${String(r[val]) === String(sel) ? 'selected' : ''}>${esc(label(r))}</option>`).join('');

/* ---------- Routing ---------- */
const ROUTES = {
  dashboard: ['Dashboard', 'Live overview of stock, expiry risk and food rescued', renderDashboard],
  inventory: ['Inventory & Expiry', 'Every batch with its live expiry status (view v_batch_status)', renderInventory],
  distribution: ['Food Distribution', 'Match NGO requests with near-expiry stock using FEFO', renderDistribution],
  ngos: ['NGOs', 'Registered partner organisations and their impact', renderNgos],
  reports: ['SQL Reports', 'Ready-made analytical queries — joins, aggregates, subqueries, window functions', renderReports],
  console: ['SQL Console', 'Run any SQL directly against the live database', renderConsole],
  schema: ['Schema & ER Diagram', 'Tables, relationships, triggers and views', renderSchema],
  audit: ['Audit Log', 'Rows written automatically by triggers', renderAudit],
};

async function route() {
  const r = (location.hash.slice(1) || 'dashboard').split('?')[0];
  const [title, sub, fn] = ROUTES[r] || ROUTES.dashboard;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === r));
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('on');
  killCharts();
  
  if (window.location.protocol === 'file:') {
    view().innerHTML = `
    <div class="card card-body" style="border: 2px solid var(--critical); background: #fff5f5; max-width: 700px; margin: 40px auto; text-align: center; padding: 32px 24px;">
      <div style="font-size: 40px; margin-bottom: 12px;">⚠️</div>
      <h2 style="color: var(--critical); margin-bottom: 12px; font-size: 20px;">Open via XAMPP Localhost</h2>
      <p style="color: var(--text-sub); line-height: 1.6;">You are viewing this file directly from the filesystem (<code>file://</code>). Web browsers block background API requests on local file paths for security.</p>
      <div style="margin: 24px 0;">
        <a class="btn btn-primary" href="http://localhost/annsetu/" target="_blank" style="padding: 10px 24px; font-size: 15px; display: inline-flex; align-items: center; gap: 8px;">
          <i data-lucide="external-link"></i>Open http://localhost/annsetu/
        </a>
      </div>
      <p class="small muted">Make sure <b>Apache</b> and <b>MySQL</b> are started in the XAMPP Control Panel.</p>
    </div>`;
    icons();
    return;
  }

  view().innerHTML = `<div class="loading"><div class="spinner"></div>Loading data from MySQL…</div>`;
  try {
    await fn();
  } catch (err) {
    view().innerHTML = `<div class="card card-body"><div class="error-box"><b>Failed to load view:</b> ${esc(err.message)}</div></div>`;
  }
  icons();
  window.scrollTo(0, 0);
}

const refresh = async () => {
  const r = (location.hash.slice(1) || 'dashboard').split('?')[0];
  killCharts();
  try {
    await (ROUTES[r] || ROUTES.dashboard)[2]();
  } catch (err) {
    toast('Refresh error', err.message, true);
  }
  icons();
};

/* ---------- Dashboard ---------- */
async function renderDashboard() {
  const data = await api('api/dashboard.php');
  const k = data.kpis || {};
  const byStatus = data.byStatus || [];
  const trend = data.trend || [];
  const alerts = data.alerts || [];
  const reqs = data.open_requests || [];

  const donatedNum = Number(k.donated || 0);
  const wastedNum = Number(k.wasted || 0);
  const rescue = (donatedNum + wastedNum) ? Math.round((donatedNum / (donatedNum + wastedNum)) * 100) : 0;

  const COL = { Expired: '#c03a34', Critical: '#e07a1f', 'Near Expiry': '#e3b52c', Fresh: '#1d5bd8' };
  
  view().innerHTML = `
  <section class="kpis">
    <div class="card kpi hero"><span class="label"><i data-lucide="heart-handshake"></i>Meals served</span><span class="value">${fmt(k.meals, 0)}</span><span class="hint">${fmt(k.donated)} kg food donated</span></div>
    <div class="card kpi"><span class="label"><i data-lucide="package-check"></i>Usable stock</span><span class="value">${fmt(k.usable_kg, 0)} kg</span><span class="hint">Not expired, not depleted</span></div>
    <div class="card kpi"><span class="label"><i data-lucide="alarm-clock"></i>Batches at risk</span><span class="value">${k.at_risk || 0}</span><span class="hint">${inr(k.value_at_risk)} value expiring soon</span></div>
    <div class="card kpi"><span class="label"><i data-lucide="recycle"></i>Rescue rate</span><span class="value">${rescue}%</span><span class="hint">${fmt(k.wasted)} kg wasted so far</span></div>
    <div class="card kpi"><span class="label"><i data-lucide="inbox"></i>Open requests</span><span class="value">${k.open_req || 0}</span><span class="hint">Waiting for food</span></div>
  </section>

  <section class="grid g-3-1">
    <div class="card">
      <div class="card-head"><div><h2>Donated vs wasted — last 14 days</h2><div class="sub">Built with a recursive CTE date series in MySQL</div></div></div>
      <div class="card-body"><div class="chart-box"><canvas id="trendChart"></canvas></div></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Stock by expiry status</h2><div class="sub">kg available, from view v_batch_status</div></div></div>
      <div class="card-body">
        <div class="chart-box" style="height:180px"><canvas id="statusChart"></canvas></div>
        <div class="legend" style="margin-top:16px">${byStatus.map((s) => `<div class="legend-row"><span class="sw" style="background:${COL[s.status] || '#1d5bd8'}"></span>${s.status}<span class="muted small">${s.batches} batches</span><span class="v">${fmt(s.qty, 0)} kg</span></div>`).join('')}</div>
      </div>
    </div>
  </section>

  <section class="grid g-2">
    <div class="card">
      <div class="card-head"><div><h2>Expiry alerts</h2><div class="sub">Donate before it is wasted</div></div><div class="actions"><a class="btn btn-ghost btn-sm" href="#inventory">View all<i data-lucide="arrow-right"></i></a></div></div>
      <div class="alert-list">${alerts.map((a) => `
        <div class="alert-item">
          <div class="days-badge ${pillCls(a.status)}">${a.days_left < 0 ? 'EXP' : a.days_left}<small>${a.days_left < 0 ? 'expired' : a.days_left === 1 ? 'day' : 'days'}</small></div>
          <div class="meta"><div class="title">${esc(a.product)} <span class="muted mono small">${a.batch_code}</span></div><div class="cell-sub">${fmt(a.qty_available)} ${a.unit} · ${esc(a.warehouse)}</div></div>
          ${a.status === 'Expired' ? `<button class="btn btn-danger btn-sm" data-waste="${a.batch_id}"><i data-lucide="trash-2"></i>Discard</button>` : `<button class="btn btn-primary btn-sm" data-donate="${a.batch_id}"><i data-lucide="hand-heart"></i>Donate</button>`}
        </div>`).join('') || '<div class="empty">No alerts — all stock is fresh.</div>'}</div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Open NGO requests</h2><div class="sub">Sorted by deadline</div></div><div class="actions"><a class="btn btn-ghost btn-sm" href="#distribution">Distribute<i data-lucide="arrow-right"></i></a></div></div>
      <div class="alert-list">${reqs.map((r) => `
        <div class="alert-item">
          <div class="days-badge s-Pending">${r.days_to_deadline <= 0 ? '!' : r.days_to_deadline}<small>${r.days_to_deadline <= 0 ? 'due' : 'days'}</small></div>
          <div class="meta"><div class="title">${esc(r.ngo)}</div><div class="cell-sub">Needs ${fmt(r.qty_remaining)} kg · ${esc(r.category)}</div></div>
          <a class="btn btn-outline btn-sm" href="#distribution" data-sel="${r.request_id}"><i data-lucide="sparkles"></i>Match</a>
        </div>`).join('') || '<div class="empty">All requests fulfilled.</div>'}</div>
    </div>
  </section>`;

  if (window.Chart) {
    try {
      Chart.defaults.font.family = "'General Sans', system-ui, sans-serif";
      Chart.defaults.color = '#5a6a86';
      const trendEl = $('#trendChart');
      if (trendEl) {
        S.charts.push(new Chart(trendEl, {
          type: 'bar',
          data: {
            labels: trend.map((t) => new Date((t.d || '') + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })),
            datasets: [
              { label: 'Donated (kg)', data: trend.map((t) => Number(t.donated || 0)), backgroundColor: '#1d5bd8', borderRadius: 5, maxBarThickness: 26 },
              { label: 'Wasted (kg)', data: trend.map((t) => Number(t.wasted || 0)), backgroundColor: '#bcd3fc', borderRadius: 5, maxBarThickness: 26 }
            ]
          },
          options: {
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3 } } },
            scales: { x: { grid: { display: false } }, y: { grid: { color: '#eef2f8' }, border: { display: false } } }
          }
        }));
      }

      const statusEl = $('#statusChart');
      if (statusEl) {
        S.charts.push(new Chart(statusEl, {
          type: 'doughnut',
          data: {
            labels: byStatus.map((s) => s.status),
            datasets: [{ data: byStatus.map((s) => Number(s.qty || 0)), backgroundColor: byStatus.map((s) => COL[s.status] || '#1d5bd8'), borderWidth: 2, borderColor: '#fff' }]
          },
          options: { maintainAspectRatio: false, cutout: '68%', plugins: { legend: { display: false } } }
        }));
      }
    } catch (e) {
      console.warn('Chart render warning:', e);
    }
  }

  bindRowActions(view());
  view().querySelectorAll('[data-sel]').forEach((a) => a.addEventListener('click', () => { S.selectedReq = +a.dataset.sel; }));
}

/* ---------- Inventory ---------- */
async function renderInventory() {
  const cats = await api('api/inventory.php?categories=1');
  
  view().innerHTML = `
  <div class="card">
    <div class="card-head">
      <div><h2>Stock batches</h2><div class="sub">FEFO order — earliest expiry first</div></div>
      <div class="actions">
        <button class="btn btn-outline btn-sm" id="discardAll"><i data-lucide="trash-2"></i>Discard all expired</button>
        <button class="btn btn-primary btn-sm" id="addBatch"><i data-lucide="plus"></i>Receive stock</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="search"><i data-lucide="search"></i><input id="invQ" placeholder="Search product or batch code" value="${esc(S.inv.q)}" /></div>
      <div class="chips" id="statusChips">
        ${['All', 'Expired', 'Critical', 'Near Expiry', 'Fresh', 'Depleted'].map((s) => `<button class="chip ${S.inv.status === s ? 'on' : ''}" data-s="${s}">${s}<span class="n" id="cnt-${s.replace(' ','_')}">—</span></button>`).join('')}
      </div>
      <select id="invCat" style="width:auto;min-width:170px"><option value="">All categories</option>${opts(cats, 'category_id', (c) => c.name, S.inv.cat)}</select>
    </div>
    <div id="invTable"><div class="loading"><div class="spinner"></div>Loading stock...</div></div>
  </div>
  <div class="card card-body small muted" style="display:flex;gap:10px;align-items:flex-start"><i data-lucide="info" style="color:var(--primary)"></i>
    <span>Status is computed dynamically by the MySQL view <span class="mono">v_batch_status</span> using <span class="mono">DATEDIFF(expiry_date, CURDATE())</span> and each category's alert days. Stock quantities change only via triggers on <span class="mono">stock_movement</span> and <span class="mono">distribution</span>.</span></div>`;

  await invTable();

  let tmr;
  $('#invQ').addEventListener('input', (e) => {
    clearTimeout(tmr);
    tmr = setTimeout(() => { S.inv.q = e.target.value; invTable(); }, 280);
  });
  $('#invCat').addEventListener('change', (e) => { S.inv.cat = e.target.value; invTable(); });
  $('#statusChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    S.inv.status = b.dataset.s;
    document.querySelectorAll('#statusChips .chip').forEach((c) => c.classList.toggle('on', c === b));
    invTable();
  });

  $('#addBatch').onclick = addBatchModal;
  $('#discardAll').onclick = async () => {
    try {
      const res = await api('api/inventory.php', { action: 'discard_all' });
      const n = res.batches_discarded || 0;
      toast(n ? `${n} expired batch${n > 1 ? 'es' : ''} discarded` : 'Nothing to discard', n ? 'Trigger trg_reduce_stock set quantity to 0 and audited in log.' : 'No expired batches with stock remaining.');
      await renderInventory();
      icons();
    } catch (e) {
      toast('Database error', e.message, true);
    }
  };
}

async function invTable() {
  const params = new URLSearchParams();
  if (S.inv.status !== 'All') params.append('status', S.inv.status);
  if (S.inv.cat) params.append('cat', S.inv.cat);
  if (S.inv.q.trim()) params.append('q', S.inv.q.trim());

  try {
    const res = await api(`api/inventory.php?${params.toString()}`);
    const rows = res.batches || [];
    const counts = res.counts || [];

    const cntMap = Object.fromEntries(counts.map((c) => [c.status, c.n]));
    const total = counts.reduce((a, c) => a + Number(c.n), 0);

    const allChip = $('#cnt-All');
    if (allChip) allChip.textContent = total;
    ['Expired', 'Critical', 'Near_Expiry', 'Fresh', 'Depleted'].forEach((k) => {
      const el = $(`#cnt-${k}`);
      if (el) el.textContent = cntMap[k.replace('_', ' ')] || 0;
    });

    $('#invTable').innerHTML = table(rows, [
      { h: 'Batch', r: (r) => `<div class="cell-strong mono">${r.batch_code}</div><div class="cell-sub">${esc(r.supplier)}</div>` },
      { h: 'Product', r: (r) => `<div class="cell-strong">${esc(r.product)}</div><div class="cell-sub">${esc(r.category)}</div>` },
      { h: 'Warehouse', k: 'warehouse' },
      { h: 'Expiry', r: (r) => `<div>${niceDate(r.expiry_date)}</div><div class="cell-sub">${daysText(r.days_left)}</div>` },
      { h: 'Available', num: true, r: (r) => `<div class="cell-strong">${fmt(r.qty_available)} ${r.unit}</div><div class="cell-sub">of ${fmt(r.qty_received)}</div>` },
      { h: 'Status', r: (r) => pill(r.status) },
      { h: '', r: (r) => `<div class="row-actions">
          <button class="btn btn-primary btn-sm" data-donate="${r.batch_id}" ${['Expired', 'Depleted'].includes(r.status) ? 'disabled' : ''} title="Donate to NGO"><i data-lucide="hand-heart"></i>Donate</button>
          <button class="btn btn-outline btn-sm" data-issue="${r.batch_id}" ${r.status === 'Depleted' ? 'disabled' : ''} title="Record usage or sale"><i data-lucide="shopping-bag"></i></button>
          <button class="btn btn-danger btn-sm" data-waste="${r.batch_id}" ${r.status === 'Depleted' ? 'disabled' : ''} title="Discard as waste"><i data-lucide="trash-2"></i></button></div>` },
    ]);
    bindRowActions($('#invTable'));
    icons();
  } catch (err) {
    $('#invTable').innerHTML = `<div class="error-box">Failed to load batches: ${esc(err.message)}</div>`;
  }
}

function bindRowActions(root) {
  root.querySelectorAll('[data-donate]').forEach((b) => b.onclick = () => donateModal(+b.dataset.donate));
  root.querySelectorAll('[data-issue]').forEach((b) => b.onclick = () => movementModal(+b.dataset.issue, 'ISSUE'));
  root.querySelectorAll('[data-waste]').forEach((b) => b.onclick = () => movementModal(+b.dataset.waste, 'WASTE'));
}

/* ---------- Modals ---------- */
async function donateModal(batchId) {
  try {
    const data = await api(`api/inventory.php?batch_id=${batchId}`);
    const b = data.batch;
    const ngos = data.ngos || [];

    openModal('Donate food to an NGO', `
      <div class="card card-body" style="background:var(--surface-2);margin-bottom:16px;display:flex;gap:12px;align-items:center">
        <div style="flex:1"><div class="cell-strong">${esc(b.product)} <span class="mono muted small">${b.batch_code}</span></div><div class="cell-sub">${fmt(b.qty_available)} ${b.unit} available · expires ${niceDate(b.expiry_date)}</div></div>${pill(b.status)}</div>
      <form id="f" class="form-grid">
        <label class="field span-2">NGO<select name="ngo">${opts(ngos, 'ngo_id', (n) => n.name)}</select></label>
        <label class="field span-2">Link to open request (optional)<select name="req"><option value="">— none —</option></select></label>
        <label class="field">Quantity (${b.unit})<input name="qty" type="number" step="0.5" min="0.5" value="${Math.min(b.qty_available, 20)}" required /></label>
        <label class="field">Volunteer<input name="vol" value="Rahul" /></label>
        <div class="span-2 small muted">Note: Entering more than ${fmt(b.qty_available)} will be blocked by MySQL trigger <span class="mono">trg_check_stock</span>.</div>
        <div class="span-2 form-actions" style="margin-top:0"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary"><i data-lucide="check"></i>Record donation</button></div>
      </form>`, async (root) => {
      const f = $('#f', root);
      
      const loadReqs = async () => {
        try {
          const reqs = await api('api/inventory.php', {
            action: 'reqs_for_ngo_cat',
            ngo_id: +f.ngo.value,
            category_id: b.category_id
          });
          f.req.innerHTML = '<option value="">— none —</option>' + (reqs || []).map((r) => `<option value="${r.request_id}">Request #${r.request_id} · needs ${fmt(r.qty_remaining)} kg</option>`).join('');
        } catch (_) {}
      };
      
      f.ngo.addEventListener('change', loadReqs);
      await loadReqs();

      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('api/inventory.php', {
            action: 'donate',
            batch_id: batchId,
            ngo_id: +f.ngo.value,
            request_id: f.req.value ? +f.req.value : null,
            qty: +f.qty.value,
            volunteer: f.vol.value
          });
          closeModal();
          toast('Donation recorded', 'Triggers updated stock, updated request status, and created audit log.');
          await refresh();
        } catch (err) {
          toast('Rejected by database', err.message, true);
        }
      };
    });
  } catch (err) {
    toast('Error loading batch', err.message, true);
  }
}

async function movementModal(batchId, type) {
  try {
    const data = await api(`api/inventory.php?batch_id=${batchId}`);
    const b = data.batch;
    const isW = type === 'WASTE';

    openModal(isW ? 'Discard as waste' : 'Record usage / sale', `
      <div class="card card-body" style="background:var(--surface-2);margin-bottom:16px;display:flex;gap:12px;align-items:center">
        <div style="flex:1"><div class="cell-strong">${esc(b.product)} <span class="mono muted small">${b.batch_code}</span></div><div class="cell-sub">${fmt(b.qty_available)} ${b.unit} available</div></div>${pill(b.status)}</div>
      <form id="f" class="form-grid">
        <label class="field">Quantity (${b.unit})<input name="qty" type="number" step="0.5" min="0.5" value="${b.qty_available}" required /></label>
        <label class="field">Reason / note<input name="note" value="${isW ? (b.status === 'Expired' ? 'Expired' : 'Damaged') : 'Retail sale'}" /></label>
        <div class="span-2 form-actions" style="margin-top:0"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn ${isW ? 'btn-danger' : 'btn-primary'}"><i data-lucide="check"></i>Save movement</button></div>
      </form>`, (root) => {
      const f = $('#f', root);
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('api/inventory.php', {
            action: 'movement',
            batch_id: batchId,
            type,
            qty: +f.qty.value,
            note: f.note.value
          });
          closeModal();
          toast('Movement saved', 'Trigger trg_reduce_stock updated batch quantity in MySQL.');
          await refresh();
        } catch (err) {
          toast('Rejected by database', err.message, true);
        }
      };
    });
  } catch (err) {
    toast('Error loading batch', err.message, true);
  }
}

async function addBatchModal() {
  try {
    const meta = await api('api/inventory.php?meta=1');
    const prods = meta.products || [];
    const sups = meta.suppliers || [];
    const whs = meta.warehouses || [];
    const next = meta.next || { c: 'B-1027', today: '', exp: '' };

    openModal('Receive new stock', `
      <form id="f" class="form-grid">
        <label class="field span-2">Product<select name="prod">${opts(prods, 'product_id', (p) => `${p.name} — ${p.cat}`)}</select></label>
        <label class="field">Supplier<select name="sup">${opts(sups, 'supplier_id', (s) => s.name)}</select></label>
        <label class="field">Warehouse<select name="wh">${opts(whs, 'warehouse_id', (w) => w.name)}</select></label>
        <label class="field">Batch code<input name="code" value="${next.c}" required /></label>
        <label class="field">Quantity<input name="qty" type="number" step="0.5" value="50" required /></label>
        <label class="field">Manufactured on<input name="mfg" type="date" value="${next.today}" required /></label>
        <label class="field">Expires on<input name="exp" type="date" value="${next.exp}" required /></label>
        <div class="span-2 small muted">Constraint test: Setting expiry before mfg date triggers the <span class="mono">chk_dates</span> constraint in MySQL.</div>
        <div class="span-2 form-actions" style="margin-top:0"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary"><i data-lucide="check"></i>Save batch</button></div>
      </form>`, (root) => {
      const f = $('#f', root);
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('api/inventory.php', {
            action: 'add_batch',
            code: f.code.value,
            prod: +f.prod.value,
            sup: +f.sup.value,
            wh: +f.wh.value,
            qty: +f.qty.value,
            mfg: f.mfg.value,
            exp: f.exp.value
          });
          closeModal();
          toast('Batch saved', 'Trigger trg_batch_in logged IN movement and written to audit log.');
          await refresh();
        } catch (err) {
          toast('Rejected by database', err.message, true);
        }
      };
    });
  } catch (err) {
    toast('Error loading metadata', err.message, true);
  }
}

/* ---------- Food Distribution ---------- */
async function renderDistribution() {
  view().innerHTML = `
  <div class="card card-body">
    <div class="steps">
      <div class="step"><div class="n">1</div><b>NGO raises a request</b><p>Stored in <span class="mono">food_request</span> with category, quantity, and deadline.</p></div>
      <div class="step"><div class="n">2</div><b>Smart FEFO match</b><p>Window-function query picks earliest-expiring usable batches automatically.</p></div>
      <div class="step"><div class="n">3</div><b>Atomic dispatch</b><p>All allocations execute inside stored procedure <span class="mono">sp_fefo_dispatch</span>.</p></div>
      <div class="step"><div class="n">4</div><b>Triggers do the rest</b><p>Stock reduced, request status updated, audit trail written atomically.</p></div>
    </div>
  </div>
  <section class="grid g-2">
    <div class="card">
      <div class="card-head"><div><h2>NGO requests</h2><div class="sub">From view v_request_progress</div></div>
        <div class="actions"><div class="chips" id="reqChips"><button class="chip ${S.reqFilter === 'open' ? 'on' : ''}" data-f="open">Open</button><button class="chip ${S.reqFilter === 'all' ? 'on' : ''}" data-f="all">All</button></div>
        <button class="btn btn-primary btn-sm" id="newReq"><i data-lucide="plus"></i>New request</button></div></div>
      <div class="req-list" id="reqList"><div class="loading"><div class="spinner"></div>Loading requests...</div></div>
    </div>
    <div class="card" id="matchCard"></div>
  </section>
  <div class="card">
    <div class="card-head"><div><h2>Distribution history</h2><div class="sub">4-table JOIN: distribution · batch · product · ngo</div></div></div>
    <div id="histTable"><div class="loading"><div class="spinner"></div>Loading history...</div></div>
  </div>`;

  await Promise.all([reqList(), matchPanel(), histTable()]);

  $('#reqChips').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    S.reqFilter = b.dataset.f;
    document.querySelectorAll('#reqChips .chip').forEach((c) => c.classList.toggle('on', c === b));
    reqList();
    icons();
  };
  $('#newReq').onclick = newRequestModal;
}

async function reqList() {
  try {
    const rows = await api(`api/distribution.php?action=requests&filter=${S.reqFilter}`);
    $('#reqList').innerHTML = rows.map((r) => {
      const pct = Math.min(100, Math.round((Number(r.qty_fulfilled) / Number(r.qty_needed)) * 100));
      const open = ['Pending', 'Partially Fulfilled'].includes(r.status);
      const due = r.days_to_deadline < 0 ? `Overdue by ${-r.days_to_deadline}d` : r.days_to_deadline === 0 ? 'Due today' : `Due in ${r.days_to_deadline}d`;
      return `<div class="req ${S.selectedReq === r.request_id ? 'selected' : ''}">
        <div><div class="who">${esc(r.ngo)}</div><div class="what">#${r.request_id} · ${esc(r.category)} · ${due}</div></div>
        <div class="row-actions">${open ? `<button class="btn btn-primary btn-sm" data-match="${r.request_id}"><i data-lucide="sparkles"></i>Smart match</button><button class="icon-btn" data-cancel="${r.request_id}" title="Cancel request" aria-label="Cancel request"><i data-lucide="x-circle"></i></button>` : ''}</div>
        <div class="prog"><div class="progress"><span style="width:${pct}%"></span></div><div class="prog-text"><span>${fmt(r.qty_fulfilled)} of ${fmt(r.qty_needed)} kg delivered</span>${pill(r.status)}</div></div>
      </div>`;
    }).join('') || '<div class="empty">No requests match. Create one to try the FEFO matcher.</div>';

    $('#reqList').querySelectorAll('[data-match]').forEach((b) => b.onclick = async () => {
      S.selectedReq = +b.dataset.match;
      await reqList();
      await matchPanel();
      icons();
    });

    $('#reqList').querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
      try {
        await api('api/distribution.php', { action: 'cancel', request_id: +b.dataset.cancel });
        if (S.selectedReq === +b.dataset.cancel) S.selectedReq = null;
        toast('Request cancelled');
        await reqList();
        await matchPanel();
        icons();
      } catch (err) {
        toast('Error', err.message, true);
      }
    });
  } catch (err) {
    $('#reqList').innerHTML = `<div class="error-box">Error: ${esc(err.message)}</div>`;
  }
}

async function matchPanel() {
  const card = $('#matchCard');
  if (!S.selectedReq) {
    card.innerHTML = `<div class="card-head"><div><h2>FEFO allocation plan</h2><div class="sub">First-Expiry-First-Out</div></div></div>
      <div class="match-empty"><i data-lucide="sparkles"></i><b style="color:var(--text)">Select a request</b><span class="small">Press “Smart match” on any open request to see which batches should go first.</span></div>`;
    return;
  }

  card.innerHTML = `<div class="card-head"><div><h2>Loading FEFO plan...</h2></div></div><div class="loading"><div class="spinner"></div>Computing running totals...</div>`;

  try {
    const data = await api(`api/distribution.php?action=fefo&request_id=${S.selectedReq}`);
    const r = data.request;
    const plan = data.plan || [];
    const total = plan.reduce((a, p) => a + Number(p.allocate), 0);

    card.innerHTML = `<div class="card-head"><div><h2>Plan for ${esc(r.ngo)}</h2><div class="sub">Request #${r.request_id} · needs ${fmt(r.qty_remaining)} kg of ${esc(r.category)}</div></div>
      <div class="actions"><button class="btn btn-primary btn-sm" id="dispatch" ${plan.length ? '' : 'disabled'}><i data-lucide="truck"></i>Dispatch ${fmt(total)} kg</button></div></div>
      ${plan.length ? table(plan, [
        { h: 'Batch', r: (p) => `<div class="cell-strong mono">${p.batch_code}</div><div class="cell-sub">${esc(p.warehouse)}</div>` },
        { h: 'Product', k: 'product' },
        { h: 'Expires', r: (p) => `<div>${niceDate(p.expiry_date)}</div><div class="cell-sub">${daysText(p.days_left)}</div>` },
        { h: 'Allocate', num: true, r: (p) => `<span class="cell-strong">${fmt(p.allocate)}</span><span class="cell-sub"> / ${fmt(p.qty_available)}</span>` },
      ]) : `<div class="empty">No usable stock left in ${esc(r.category)} — every batch is expired or depleted.</div>`}
      ${plan.length && total < Number(r.qty_remaining) ? `<div class="card-body small" style="color:var(--critical)">Only ${fmt(total)} kg available — the request will be marked Partially Fulfilled.</div>` : ''}
      <details class="card-body" style="border-top:1px solid var(--border)"><summary class="small" style="cursor:pointer;font-weight:600;color:var(--primary)">Show FEFO logic</summary>
        <div style="margin-top:12px;font-size:var(--text-xs);color:var(--muted)">Executes via MySQL stored procedure <span class="mono">CALL sp_fefo_dispatch(${r.request_id}, 'Auto-FEFO');</span> inside a database transaction with rollback protection.</div>
      </details>`;

    const d = $('#dispatch');
    if (d) d.onclick = async () => {
      try {
        await api('api/distribution.php', {
          action: 'dispatch',
          request_id: r.request_id,
          volunteer: 'Auto-FEFO'
        });
        toast(`Dispatched ${fmt(total)} kg to ${r.ngo}`, 'Stored procedure committed transaction in MySQL.');
        await renderDistribution();
        icons();
      } catch (e) {
        toast('Transaction failed', e.message, true);
      }
    };
  } catch (err) {
    card.innerHTML = `<div class="error-box">Failed to generate match: ${esc(err.message)}</div>`;
  }
}

async function histTable() {
  try {
    const rows = await api('api/distribution.php?action=history');
    $('#histTable').innerHTML = table(rows, [
      { h: 'Date', r: (r) => niceDate(r.distributed_on) },
      { h: 'NGO', r: (r) => `<span class="cell-strong">${esc(r.ngo)}</span>` },
      { h: 'Product', r: (r) => `${esc(r.product)} <span class="mono muted small">${r.batch_code}</span>` },
      { h: 'Qty', num: true, r: (r) => `${fmt(r.qty)} ${r.unit}` },
      { h: 'Request', r: (r) => r.request_id ? `<span class="tag">#${r.request_id}</span>` : '<span class="muted">Walk-in</span>' },
      { h: 'Volunteer', k: 'volunteer' },
    ]);
  } catch (err) {
    $('#histTable').innerHTML = `<div class="error-box">Error loading history: ${esc(err.message)}</div>`;
  }
}

async function newRequestModal() {
  try {
    const meta = await api('api/distribution.php?action=new_request_meta');
    const ngos = meta.ngos || [];
    const cats = meta.categories || [];
    const t = meta.default_date || '';

    openModal('New food request', `
      <form id="f" class="form-grid">
        <label class="field span-2">NGO<select name="ngo">${opts(ngos, 'ngo_id', (n) => n.name)}</select></label>
        <label class="field span-2">Food category<select name="cat">${opts(cats, 'category_id', (c) => c.name)}</select></label>
        <label class="field">Quantity needed (kg)<input name="qty" type="number" step="0.5" value="60" required /></label>
        <label class="field">Needed by<input name="by" type="date" value="${t}" required /></label>
        <div class="span-2 form-actions" style="margin-top:0"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary"><i data-lucide="check"></i>Create request</button></div>
      </form>`, (root) => {
      const f = $('#f', root);
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const res = await api('api/distribution.php', {
            action: 'new_request',
            ngo_id: +f.ngo.value,
            category_id: +f.cat.value,
            qty: +f.qty.value,
            needed_by: f.by.value
          });
          S.selectedReq = res.request_id;
          S.reqFilter = 'open';
          closeModal();
          toast('Request created', 'Showing its FEFO match now.');
          await renderDistribution();
          icons();
        } catch (err) {
          toast('Rejected by database', err.message, true);
        }
      };
    });
  } catch (err) {
    toast('Error loading form', err.message, true);
  }
}

/* ---------- NGOs ---------- */
async function renderNgos() {
  try {
    const rows = await api('api/ngos.php');
    view().innerHTML = `
    <div class="card"><div class="card-head"><div><h2>${rows.length} partner NGOs</h2><div class="sub">Ranked by meals served with RANK() OVER (…) in MySQL</div></div>
      <div class="actions"><button class="btn btn-primary btn-sm" id="addNgo"><i data-lucide="plus"></i>Register NGO</button></div></div>
      <div class="card-body"><div class="ngo-grid">${rows.map((n) => `
        <div class="card ngo-card">
          <div class="top"><div class="avatar">${esc(n.name.split(' ').map((w) => w[0]).slice(0, 2).join(''))}</div>
            <div style="min-width:0;flex:1"><div class="cell-strong">${esc(n.name)}</div><div class="cell-sub">${esc(n.city)} · ${n.beneficiaries} beneficiaries</div></div><span class="tag">#${n.rnk}</span></div>
          <div class="ngo-stats"><div><b>${fmt(n.kg_received, 0)}</b><span>kg received</span></div><div><b>${fmt(n.meals_served, 0)}</b><span>meals</span></div><div><b>${n.open_req}</b><span>open req.</span></div></div>
        </div>`).join('')}</div></div></div>`;

    $('#addNgo').onclick = () => openModal('Register NGO', `
      <form id="f" class="form-grid">
        <label class="field span-2">Organisation name<input name="name" value="Seva Sadan Trust" required /></label>
        <label class="field">Registration no. (unique)<input name="reg" value="DL-NGO-2024-${Math.floor(1000 + Math.random() * 8999)}" required /></label>
        <label class="field">City<input name="city" value="Delhi" required /></label>
        <label class="field">Contact person<input name="cp" value="Meera Joshi" required /></label>
        <label class="field">Phone (10 digits)<input name="ph" value="9876543210" required /></label>
        <label class="field">Beneficiaries<input name="ben" type="number" value="120" required /></label>
        <div class="span-2 small muted">Integrity rule: Invalid phone length or duplicate registration triggers CHECK / UNIQUE constraint errors.</div>
        <div class="span-2 form-actions" style="margin-top:0"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary"><i data-lucide="check"></i>Register</button></div>
      </form>`, (root) => {
      const f = $('#f', root);
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('api/ngos.php', {
            action: 'register',
            name: f.name.value,
            reg: f.reg.value,
            cp: f.cp.value,
            ph: f.ph.value,
            city: f.city.value,
            ben: +f.ben.value
          });
          closeModal();
          toast('NGO registered', 'Trigger trg_audit_ngo recorded audit entry in MySQL.');
          await renderNgos();
          icons();
        } catch (err) {
          toast('Rejected by database', err.message, true);
        }
      };
    });
  } catch (err) {
    view().innerHTML = `<div class="error-box">Failed to load NGOs: ${esc(err.message)}</div>`;
  }
}

/* ---------- Reports ---------- */
const REPORTS = [
  { t: 'Near-expiry stock by warehouse', d: 'What must move out of each warehouse in the next 7 days.', c: ['JOIN', 'WHERE', 'DATEDIFF()'] },
  { t: 'Value at risk by category', d: 'Money that will be lost if near-expiry stock is not moved.', c: ['GROUP BY', 'SUM', 'HAVING'] },
  { t: 'Wastage percentage by category', d: 'Share of received food that ended up wasted.', c: ['CASE', 'Aggregate', 'Multi-JOIN'] },
  { t: 'NGO leaderboard', d: 'Food and meals delivered to each NGO, with rank.', c: ['LEFT JOIN', 'RANK()', 'Window'] },
  { t: 'Products never donated', d: 'Items that have never reached an NGO — candidates for outreach.', c: ['NOT EXISTS', 'Subquery'] },
  { t: 'Warehouse utilisation', d: 'Current stock against capacity for each warehouse.', c: ['LEFT JOIN', 'GROUP BY'] },
  { t: 'Supplier freshness score', d: 'Average shelf life left when stock arrives, per supplier.', c: ['AVG', 'DATEDIFF()', 'GROUP BY'] },
  { t: 'Overdue & urgent requests', d: 'Requests whose deadline is today or already passed.', c: ['VIEW', 'WHERE', 'date math'] },
  { t: 'Running stock per product (FEFO)', d: 'Cumulative quantity per product in pick order.', c: ['SUM() OVER', 'PARTITION BY'] },
  { t: 'Above-average donors', d: 'NGOs that received more than the average NGO.', c: ['Nested subquery', 'AVG'] },
];

async function renderReports() {
  view().innerHTML = `<section class="grid g-3-1" style="grid-template-columns:minmax(0,1fr) minmax(0,2.2fr)">
    <div class="card"><div class="card-head"><h2>Reports</h2><span class="sub">${REPORTS.length} queries</span></div><div class="report-list" id="repList"></div></div>
    <div class="card" id="repOut"><div class="loading"><div class="spinner"></div>Executing report query...</div></div></section>`;

  $('#repList').innerHTML = REPORTS.map((r, i) => `<button class="report-item ${i === S.report ? 'on' : ''}" data-i="${i}"><b>${r.t}</b><span class="cell-sub">${r.d}</span><span class="concepts">${r.c.map((c) => `<span class="tag">${c}</span>`).join('')}</span></button>`).join('');

  $('#repList').onclick = (e) => {
    const b = e.target.closest('.report-item');
    if (!b) return;
    S.report = +b.dataset.i;
    renderReports();
    icons();
  };

  const r = REPORTS[S.report];
  try {
    const res = await api(`api/reports.php?id=${S.report}`);
    $('#repOut').innerHTML = `<div class="card-head"><div><h2>${r.t}</h2><div class="sub">${r.d}</div></div>
      <div class="actions"><button class="btn btn-outline btn-sm" id="toConsole"><i data-lucide="terminal-square"></i>Edit in console</button></div></div>
      <div class="card-body">${sqlBlock(res.sql)}</div>
      ${resultTable(res)}
      <div class="result-meta"><span>${res.values ? res.values.length : 0} rows</span><span>${res.ms} ms</span></div>`;

    $('#toConsole').onclick = () => {
      S.consoleSql = res.sql;
      location.hash = 'console';
    };
  } catch (err) {
    $('#repOut').innerHTML = `<div class="card-head"><div><h2>${r.t}</h2></div></div><div class="card-body"><div class="error-box">${esc(err.message)}</div></div>`;
  }
}

/* ---------- SQL Console ---------- */
const SNIPPETS = [
  ['Expiring in 3 days', "SELECT product, batch_code, qty_available, days_left\nFROM v_batch_status\nWHERE days_left BETWEEN 0 AND 3 AND qty_available > 0\nORDER BY days_left;"],
  ['Test trigger (insufficient stock)', "-- Outgoing movement larger than available: trigger trg_check_stock blocks it\nINSERT INTO stock_movement(batch_id, movement_type, qty, note)\nVALUES (10, 'ISSUE', 99999, 'trigger test');"],
  ['Test trigger (expired food)', "-- Batch 3 (Paneer) is expired: trigger trg_no_expired_donation blocks this\nINSERT INTO distribution(batch_id, ngo_id, qty)\nVALUES (3, 1, 5);"],
  ['Call FEFO procedure', "CALL sp_fefo_dispatch(4, 'Rahul');"],
  ['Check audit log', "SELECT * FROM audit_log ORDER BY log_id DESC LIMIT 10;"],
];

async function renderConsole() {
  let tables = [];
  try {
    tables = await api('api/console.php');
  } catch (_) {}

  view().innerHTML = `
  <div class="card">
    <div class="card-head"><div><h2>Query editor (MySQL 8.0)</h2><div class="sub">Ctrl + Enter to run · executed directly against XAMPP MySQL database</div></div>
      <div class="actions"><button class="btn btn-primary btn-sm" id="runSql"><i data-lucide="play"></i>Run query</button></div></div>
    <div class="card-body" style="display:grid;gap:12px">
      <textarea id="sqlIn" class="console-input" spellcheck="false">${esc(S.consoleSql)}</textarea>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="small muted" style="margin-right:4px">Examples:</span>${SNIPPETS.map((s, i) => `<button class="chip" data-sn="${i}">${s[0]}</button>`).join('')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="small muted" style="margin-right:4px">Tables &amp; views:</span>${(tables || []).map((t) => `<button class="table-chip" data-t="${t.name}">${t.name}</button>`).join('')}</div>
    </div>
  </div>
  <div class="card" id="sqlOut"><div class="empty">Results will appear here. Press 'Run query' or hit Ctrl+Enter.</div></div>`;

  const ta = $('#sqlIn');
  const exec = async () => {
    const sql = ta.value.trim();
    if (!sql) return;
    S.consoleSql = ta.value;
    $('#sqlOut').innerHTML = `<div class="loading"><div class="spinner"></div>Running query against MySQL...</div>`;

    try {
      const res = await api('api/console.php', { sql });
      if (res.columns) {
        $('#sqlOut').innerHTML = `${resultTable(res)}<div class="result-meta"><span>${res.values ? res.values.length : 0} rows</span><span>${res.ms} ms</span></div>`;
      } else {
        $('#sqlOut').innerHTML = `<div class="card-body"><b>Statement executed successfully.</b> <span class="muted">${res.affected ?? 0} row(s) affected · ${res.ms} ms</span></div>`;
      }
    } catch (err) {
      $('#sqlOut').innerHTML = `<div class="card-body"><div class="error-box"><b>MySQL Error:</b> ${esc(err.message)}</div></div>`;
    }
  };

  $('#runSql').onclick = exec;
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      exec();
    }
  });

  view().querySelectorAll('[data-sn]').forEach((b) => b.onclick = () => {
    ta.value = SNIPPETS[+b.dataset.sn][1];
    exec();
  });
  view().querySelectorAll('[data-t]').forEach((b) => b.onclick = () => {
    ta.value = `SELECT * FROM ${b.dataset.t} LIMIT 20;`;
    exec();
  });
}

/* ---------- Schema & ER Diagram ---------- */
async function renderSchema() {
  S.ddlType = S.ddlType || 'table';

  view().innerHTML = `<div class="loading"><div class="spinner"></div>Loading MySQL schema & catalog metadata...</div>`;

  try {
    const data = await api('api/schema.php');
    const counts = data.counts || {};
    const tables = data.tables || {};
    const ddlList = data.ddl || [];

    view().innerHTML = `
    <section class="kpis">
      <div class="card kpi"><span class="label"><i data-lucide="table-2"></i>Tables</span><span class="value">${counts.table || 0}</span><span class="hint">Normalised to 3NF</span></div>
      <div class="card kpi"><span class="label"><i data-lucide="zap"></i>Triggers</span><span class="value">${counts.trigger || 0}</span><span class="hint">Business rules in MySQL</span></div>
      <div class="card kpi"><span class="label"><i data-lucide="eye"></i>Views</span><span class="value">${counts.view || 0}</span><span class="hint">Computed status &amp; impact</span></div>
      <div class="card kpi"><span class="label"><i data-lucide="list-tree"></i>Indexes</span><span class="value">${counts.index || 0}</span><span class="hint">On expiry &amp; foreign keys</span></div>
    </section>
    <div class="card"><div class="card-head"><div><h2>Entity–Relationship diagram</h2><div class="sub">Generated live from MySQL INFORMATION_SCHEMA · arrows point from foreign key to referenced primary key</div></div>
      <div class="actions"><a class="btn btn-outline btn-sm" href="./sql/annsetu_mysql.sql" target="_blank" rel="noopener noreferrer"><i data-lucide="file-code-2"></i>MySQL script</a></div></div>
      <div class="er-wrap">${erDiagram(tables)}</div></div>
    <section class="grid g-2">
      <div class="card"><div class="card-head"><h2>DDL from MySQL</h2></div><div class="card-body">
        <div class="ddl-tabs chips" id="ddlTabs">${['table', 'view', 'trigger', 'index'].map((t) => `<button class="chip ${S.ddlType === t ? 'on' : ''}" data-t="${t}">${t[0].toUpperCase() + t.slice(1)}s</button>`).join('')}</div>
        <div id="ddl" style="display:grid;gap:10px;max-height:560px;overflow:auto"></div></div></div>
      <div class="card"><div class="card-head"><h2>Design notes</h2></div><div class="card-body" style="display:grid;gap:14px;font-size:var(--text-sm)">
        ${[
          ['Normalisation (3NF)', 'Category, supplier, warehouse and product details live in their own tables. Batch only stores foreign keys, avoiding data duplication.'],
          ['Batch-level expiry', 'The same product arrives across multiple dates; expiry belongs to <span class="mono">batch</span>, not <span class="mono">product</span>.'],
          ['Derived data is not stored', 'Days-left and status are computed dynamically by <span class="mono">v_batch_status</span> view to prevent stale data.'],
          ['Integrity inside MySQL', 'CHECK constraints, UNIQUE constraints, FOREIGN KEYs with ON DELETE CASCADE, and triggers that enforce business logic.'],
          ['Ledger pattern', '<span class="mono">stock_movement</span> records every stock modification (IN, ISSUE, DONATION, WASTE) for full traceability.'],
          ['ACID transactions', 'FEFO allocations are dispatched inside an atomic transaction block via <span class="mono">sp_fefo_dispatch</span>.'],
        ].map(([h, p]) => `<div><b>${h}</b><p class="muted" style="margin-top:2px">${p}</p></div>`).join('')}
      </div></div>
    </section>`;

    const renderDdl = () => {
      const filtered = ddlList.filter((o) => o.type === S.ddlType);
      $('#ddl').innerHTML = filtered.length ? filtered.map((o) => sqlBlock(o.sql)).join('') : `<div class="empty">No ${S.ddlType}s found.</div>`;
    };
    renderDdl();

    $('#ddlTabs').onclick = (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      S.ddlType = b.dataset.t;
      document.querySelectorAll('#ddlTabs .chip').forEach((c) => c.classList.toggle('on', c === b));
      renderDdl();
    };
  } catch (err) {
    view().innerHTML = `<div class="error-box">Failed to load schema: ${esc(err.message)}</div>`;
  }
}

function erDiagram(tableMap) {
  const POS = {
    category: [20, 40], supplier: [20, 200], warehouse: [20, 360],
    product: [310, 40], batch: [310, 220],
    stock_movement: [600, 40], distribution: [600, 260],
    food_request: [890, 40], ngo: [890, 260], audit_log: [890, 480]
  };
  const W = 240, HH = 32, RH = 21;
  const T = {};

  Object.keys(POS).forEach((t) => {
    const meta = tableMap[t] || { cols: [], fks: [] };
    T[t] = { cols: meta.cols, fks: meta.fks, x: POS[t][0], y: POS[t][1], h: HH + meta.cols.length * RH + 8 };
  });

  const rowY = (t, col) => {
    const i = (T[t]?.cols || []).findIndex((c) => c.name === col);
    return (T[t]?.y || 0) + HH + (i >= 0 ? i : 0) * RH + RH / 2 + 4;
  };

  let edges = '', boxes = '';
  Object.entries(T).forEach(([t, o]) => o.fks.forEach((fk) => {
    const p = T[fk.table];
    if (!p) return;
    const y1 = rowY(t, fk.from), y2 = rowY(fk.table, fk.to || 'id');
    let d;
    if (p.x === o.x) {
      const x = o.x;
      d = `M${x},${y1} C${x - 45},${y1} ${x - 45},${y2} ${x},${y2}`;
    } else if (p.x < o.x && o.x - p.x <= 300) {
      d = `M${o.x},${y1} C${o.x - 30},${y1} ${p.x + W + 30},${y2} ${p.x + W},${y2}`;
    } else if (p.x > o.x) {
      d = `M${o.x + W},${y1} C${o.x + W + 30},${y1} ${p.x - 30},${y2} ${p.x},${y2}`;
    } else {
      const cx = o.x - 18, px = p.x + W + 18;
      d = `M${o.x},${y1} L${cx},${y1} L${cx},16 L${px},16 L${px},${y2} L${p.x + W},${y2}`;
    }
    edges += `<path d="${d}" fill="none" stroke="#7ea3ec" stroke-width="1.6" marker-end="url(#arr)"/><circle cx="${d.match(/M([\d.]+),([\d.]+)/)[1]}" cy="${y1}" r="3" fill="#1d5bd8"/>`;
  }));

  Object.entries(T).forEach(([t, o]) => {
    const fkCols = new Set(o.fks.map((f) => f.from));
    boxes += `<g><rect x="${o.x}" y="${o.y}" width="${W}" height="${o.h}" rx="9" fill="#fff" stroke="#cdd7e7"/>
      <path d="M${o.x},${o.y + 9} a9,9 0 0 1 9,-9 h${W - 18} a9,9 0 0 1 9,9 v${HH - 9} h-${W} z" fill="${t === 'batch' || t === 'distribution' ? '#1d5bd8' : '#0b2a66'}"/>
      <text x="${o.x + 12}" y="${o.y + 21}" fill="#fff" font-size="13" font-weight="600">${t}</text>
      ${o.cols.map((c, i) => {
        const y = o.y + HH + i * RH + RH / 2 + 8;
        return `
        <text x="${o.x + 12}" y="${y}" font-size="12" fill="${c.pk ? '#1d5bd8' : '#0e1c36'}" font-weight="${c.pk ? 600 : 400}">${c.name}</text>
        <text x="${o.x + W - 12}" y="${y}" font-size="10.5" fill="#8b98ae" text-anchor="end">${c.pk ? 'PK ' : ''}${fkCols.has(c.name) ? 'FK ' : ''}${(c.type || '').toLowerCase()}</text>`;
      }).join('')}</g>`;
  });

  return `<svg viewBox="0 0 1150 670" width="1150" height="670" role="img" aria-label="Entity relationship diagram">
    <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1d5bd8"/></marker></defs>
    ${edges}${boxes}</svg>`;
}

/* ---------- Audit Log ---------- */
async function renderAudit() {
  try {
    const data = await api('api/audit.php');
    const logs = data.logs || [];
    const mv = data.ledger || [];

    view().innerHTML = `<section class="grid g-2">
      <div class="card"><div class="card-head"><div><h2>audit_log</h2><div class="sub">Written automatically by triggers in MySQL</div></div></div>
        ${table(logs, [{ h: 'When', r: (r) => `<span class="small mono">${r.logged_at}</span>` }, { h: 'Table', r: (r) => `<span class="tag">${r.table_name}</span>` }, { h: 'Action', r: (r) => `<b class="small">${r.action}</b>` }, { h: 'Details', r: (r) => `<span class="small">${esc(r.details)}</span>` }])}</div>
      <div class="card"><div class="card-head"><div><h2>stock_movement ledger</h2><div class="sub">Every stock change, newest first</div></div></div>
        ${table(mv, [{ h: 'Date', r: (r) => `<span class="small">${niceDate(r.moved_on)}</span>` }, { h: 'Type', r: (r) => `<span class="pill ${({ IN: 's-Pending', ISSUE: 's-Near', DONATION: 's-Fresh', WASTE: 's-Expired' })[r.movement_type]}">${r.movement_type}</span>` }, { h: 'Batch', r: (r) => `<span class="small">${esc(r.product)}</span> <span class="mono muted small">${r.batch_code}</span>` }, { h: 'Qty', num: true, r: (r) => fmt(r.qty) }])}</div>
    </section>`;
  } catch (err) {
    view().innerHTML = `<div class="error-box">Failed to load audit trail: ${esc(err.message)}</div>`;
  }
}

/* ---------- API Log Drawer ---------- */
function renderLog() {
  $('#logList').innerHTML = S.log.map((l) => `
    <div class="log-entry">
      <div class="when"><span class="ctx"><b style="color:var(--primary)">${l.method}</b> ${esc(l.url)}</span><span>${l.ms} ms · ${l.t}</span></div>
      ${l.req ? `<div style="font-size:11px;margin-top:4px;color:var(--text-sub)">Request:</div><pre class="code">${esc(l.req)}</pre>` : ''}
      ${l.res ? `<div style="font-size:11px;margin-top:4px;color:var(--text-sub)">Response:</div><pre class="code">${esc(l.res)}</pre>` : ''}
    </div>`).join('') || '<div class="empty">No API calls recorded yet.</div>';
}

const toggleDrawer = (on) => {
  $('#drawer').classList.toggle('open', on);
  $('#scrim').classList.toggle('on', on);
  if (on) renderLog();
};

/* ---------- Global Initialization ---------- */
$('#logBtn').onclick = () => toggleDrawer(true);
$('#closeDrawer').onclick = () => toggleDrawer(false);
$('#scrim').onclick = () => { toggleDrawer(false); $('#sidebar').classList.remove('open'); };
$('#menuBtn').onclick = () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('on'); };
$('#modalWrap').addEventListener('click', (e) => { if (e.target.id === 'modalWrap' || e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); toggleDrawer(false); } });

$('#resetDb').onclick = () => {
  toast('Database Reset', 'Persistent MySQL mode: to re-initialize sample data, re-run sql/annsetu_mysql.sql in phpMyAdmin.', false);
};

async function boot() {
  $('#engineInfo').textContent = 'MySQL 8.0 · XAMPP';
  $('#today').textContent = 'Date: ' + new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  window.addEventListener('hashchange', route);
  await route();
}

icons();
boot();
