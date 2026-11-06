const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  view: "overview",
  dashboard: null,
  evaluation: null,
  matches: null,
  audit: null,
  mapData: null,
  mapConfig: null,
  mapCenter: { lat: 18.5204, lon: 73.8567 },
  mapZoom: 12,
  userLocation: null,
  simulation: null,
  simulationWorkers: 4,
  simulationPumpId: null,
  simulationTimer: null,
  expiryFilter: "all",
};

const viewMeta = {
  overview: ["Overview", "Operations"],
  retail: ["Retail", "Inventory"],
  demand: ["Demand", "Recipient network"],
  matching: ["Match desk", "Recommendations"],
  logistics: ["Fulfilment", "Deliveries"],
  map: ["Network map", "Live locations"],
  analytics: ["Analytics", "Impact"],
  activity: ["Activity", "Recent changes"],
  model: ["Data model", "ER schema"],
};

// Read-only schema reference for sql/annsetu_python_mysql.sql.
const schemaTables = [
  {name:'organization',domain:'Organizations',columns:[['id','bigint','PK'],['name','varchar(150)'],['kind','varchar(20)'],['synthetic','boolean'],['created_at','datetime']],constraints:['organization kind identifies retailer, recipient, logistics, or admin']},
  {name:'store',domain:'Retail & inventory',columns:[['id','bigint','PK'],['organization_id','bigint','FK'],['name','varchar(150)'],['city','varchar(100)'],['lat','decimal(9,6)'],['lon','decimal(9,6)']],constraints:['belongs to an organization']},
  {name:'category',domain:'Retail & inventory',columns:[['id','bigint','PK'],['name','varchar(100)','UQ'],['storage','varchar(20)']],constraints:['storage is ambient, chilled, or frozen']},
  {name:'product',domain:'Retail & inventory',columns:[['id','bigint','PK'],['store_id','bigint','FK'],['sku','varchar(40)'],['name','varchar(150)'],['category_id','bigint','FK'],['unit','varchar(20)'],['unit_price','decimal(12,2)'],['safety_stock','decimal(12,3)']],constraints:['SKU is unique per store']},
  {name:'batch',domain:'Retail & inventory',columns:[['id','bigint','PK'],['product_id','bigint','FK'],['lot_code','varchar(60)'],['received_on','date'],['expiry_date','date'],['quantity','decimal(12,3)'],['reserved','decimal(12,3)'],['source','varchar(20)']],constraints:['lot code is unique per product','reserved quantity cannot exceed on-hand quantity']},
  {name:'sale',domain:'Retail & inventory',columns:[['id','bigint','PK'],['product_id','bigint','FK'],['sold_on','date'],['quantity','decimal(12,3)'],['source','varchar(20)'],['source_row_key','char(64)','UQ']],constraints:['source row key prevents duplicate imports']},
  {name:'recipient',domain:'Recipient network',columns:[['id','bigint','PK'],['organization_id','bigint','FK'],['name','varchar(150)'],['city','varchar(100)'],['lat','decimal(9,6)'],['lon','decimal(9,6)'],['capacity_kg','decimal(12,3)'],['cold_storage','boolean']],constraints:['recipient capacity must be positive']},
  {name:'demand',domain:'Recipient network',columns:[['id','bigint','PK'],['recipient_id','bigint','FK'],['category_id','bigint','FK'],['quantity','decimal(12,3)'],['needed_by','date'],['status','varchar(30)'],['declared','boolean']],constraints:['status tracks open, partially fulfilled, fulfilled, or cancelled demand']},
  {name:'forecast',domain:'Forecast & fulfilment',columns:[['id','bigint','PK'],['product_id','bigint','FK'],['generated_at','datetime'],['horizon_days','int'],['predicted_daily','decimal(12,4)'],['forecast_method','varchar(100)'],['data_cutoff','date']],constraints:['stores the recent-sales demand baseline']},
  {name:'allocation',domain:'Forecast & fulfilment',columns:[['id','bigint','PK'],['demand_id','bigint','FK'],['status','varchar(20)'],['created_at','datetime'],['estimated_km','decimal(12,3)'],['transport_cost','decimal(12,2)'],['handling_cost','decimal(12,2)']],constraints:['status tracks proposed, approved, delivered, or cancelled']},
  {name:'allocation_line',domain:'Forecast & fulfilment',columns:[['id','bigint','PK'],['allocation_id','bigint','FK'],['batch_id','bigint','FK'],['quantity','decimal(12,3)']],constraints:['one line per batch in an allocation']},
  {name:'delivery',domain:'Forecast & fulfilment',columns:[['id','bigint','PK'],['allocation_id','bigint','FK/UQ'],['status','varchar(20)'],['completed_at','datetime']],constraints:['one delivery record per allocation']},
  {name:'audit',domain:'Operations history',columns:[['id','bigint','PK'],['occurred_at','datetime'],['actor','varchar(100)'],['action','varchar(80)'],['entity','varchar(80)'],['entity_id','bigint'],['details','text']],constraints:['records operational changes']},
];
const schemaDomains = [
  {name:'Organizations',tables:['organization']},
  {name:'Retail & inventory',tables:['store','category','product','batch','sale']},
  {name:'Recipient network',tables:['recipient','demand']},
  {name:'Forecast & fulfilment',tables:['forecast','allocation','allocation_line','delivery']},
  {name:'Operations history',tables:['audit']},
];
const schemaRelations = [
  ['organization','id','store','organization_id'],['organization','id','recipient','organization_id'],
  ['store','id','product','store_id'],['category','id','product','category_id'],
  ['product','id','batch','product_id'],['product','id','sale','product_id'],['product','id','forecast','product_id'],
  ['recipient','id','demand','recipient_id'],['category','id','demand','category_id'],
  ['demand','id','allocation','demand_id'],['allocation','id','allocation_line','allocation_id'],
  ['batch','id','allocation_line','batch_id'],['allocation','id','delivery','allocation_id'],
].map(([from,fromColumn,to,toColumn])=>({from,fromColumn,to,toColumn,optional:false}));
const schemaView = {
  name:'v_batch_available',
  columns:[['id','bigint'],['product_id','bigint'],['lot_code','varchar(60)'],['expiry_date','date'],['quantity','decimal(12,3)'],['reserved','decimal(12,3)'],['available','derived decimal'],['store_id','bigint'],['unit','varchar(20)'],['category','varchar(100)'],['storage','varchar(20)']],
  description:'Read-only join of batch, product, and category. available = quantity - reserved.',
};
const iconPaths = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  inventory: '<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  community: '<path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20"/><circle cx="10" cy="8" r="3"/><path d="M17 11a3 3 0 1 0-1-5.8M20 20v-1.5a3.5 3.5 0 0 0-2.7-3.4"/>',
  matching: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 6h8M7.5 7.5l3.2 8M16.5 7.5l-3.2 8"/>',
  truck: '<path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"/><circle cx="7.5" cy="19" r="1.8"/><circle cx="17.5" cy="19" r="1.8"/>',
  analytics: '<path d="M3 19V5M3 19h18"/><path d="m6 15 4-4 3 2 6-7"/><path d="M16 6h3v3"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9A7 7 0 0 1 18 6.5L20 12M4 12l2 5.5A7 7 0 0 0 18.4 15"/>',
  sparkles: '<path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-2-5.8L4 11l6-2.2L12 3ZM19 14l1.2 2.8L23 18l-2.8 1.2L19 22l-1.2-2.8L15 18l2.8-1.2L19 14Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  package: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9"/>',
  scale: '<path d="M12 3v18M5 6h14M5 6l-3 6h6L5 6ZM19 6l-3 6h6l-3-6ZM7 21h10"/>',
  leaf: '<path d="M20 4c-8 0-14 3.8-14 10a6 6 0 0 0 6 6c6.2 0 10-6 8-16Z"/><path d="M5 21c2-5 6-8 11-11"/>',
  pin: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  shield: '<path d="M12 3 20 6v5c0 5-3.4 8.3-8 10-4.6-1.7-8-5-8-10V6l8-3Z"/><path d="m8.5 12 2.3 2.3 4.8-5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/>',
  warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  trend: '<path d="m4 16 5-5 4 3 7-8"/><path d="M15 6h5v5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
};

function icon(name, size = 16) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}">${iconPaths[name] || iconPaths.sparkles}</svg>`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function number(value, digits = 0) {
  return Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function money(value) {
  return `₹${number(value)}`;
}

function formatDate(value, options = { day: "numeric", month: "short" }) {
  if (!value) return "—";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return esc(value);
  return new Intl.DateTimeFormat("en-IN", { ...options, timeZone: "Asia/Kolkata" }).format(date);
}

function daysUntil(value) {
  const expiry = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((expiry - today) / 86400000);
}

async function api(url, method = "GET", body) {
  const response = await fetch(url, {
    method,
    headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.detail || `Request failed (${response.status})`);
  return payload;
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast${type === "error" ? " error" : ""}`;
  item.textContent = message;
  $("#toast-region").append(item);
  window.setTimeout(() => item.remove(), 3600);
}

function setHealth(healthy, detail = "") {
  const footer = $("#footer-health");
  const dot = $(".footer-status-dot");
  if (footer) footer.textContent = healthy ? `Database connected${detail ? ` · ${detail}` : ""}` : "Database unavailable";
  if (dot) dot.classList.toggle("is-error", !healthy);
  const stateTitle = $("#sidebar-state");
  if (stateTitle) stateTitle.textContent = healthy ? "Workspace connected" : "Connection unavailable";
  const sidebar = $("#sidebar-health");
  if (sidebar) sidebar.textContent = healthy ? `Database connected${detail ? ` · ${detail}` : ""}` : "Unable to reach database";
}

async function refreshData() {
  try {
    const [dashboard, evaluation] = await Promise.all([
      api("/api/dashboard"),
      api("/api/ml/evaluation").catch(() => null),
    ]);
    state.dashboard = dashboard;
    state.evaluation = evaluation;
    setHealth(true, "PostgreSQL");
    renderView();
    renderNotifications();
  } catch (error) {
    setHealth(false);
    if (!state.dashboard) {
      $("#view-content").innerHTML = `<section class="panel"><div class="empty-state"><div><strong>We couldn’t load this workspace</strong>${esc(error.message)}<br><button class="button button-secondary button-small" data-action="refresh" style="margin-top:12px">Try again</button></div></div></section>`;
    } else {
      toast(`Refresh failed: ${error.message}`, "error");
    }
  }
}

function setView(view, { updateHash = true } = {}) {
  if (!viewMeta[view]) return;
  state.view = view;
  if (updateHash) history.replaceState(null, "", `#${view}`);
  $$(".nav-item").forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#breadcrumb-current").textContent = viewMeta[view][0];
  $("#sidebar").classList.remove("is-open");
  $("#menu-toggle").setAttribute("aria-expanded", "false");
  renderView();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function heading(view) {
  const meta = viewMeta[view];
  const today = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date());
  const live = `<div class="eyebrow"><span class="live-dot"></span>${esc(meta[1])}<span>·</span>${esc(today)}</div>`;
  let actions = "";
  if (view === "overview" || view === "retail") {
    actions = `<button class="button" data-action="refresh">${icon("refresh", 14)} Refresh</button><button class="button" data-action="record-sale">${icon("scale", 14)} Record sale</button><button class="button button-primary" data-action="receive-stock">${icon("package", 14)} Receive stock</button>`;
  } else if (view === "matching") {
    actions = `<button class="button" data-action="refresh">${icon("refresh", 14)} Refresh</button><button class="button button-primary" data-action="find-matches">${icon("sparkles", 14)} Find matches</button>`;
  } else if (view === "activity") {
    actions = `<button class="button" data-action="refresh-audit">${icon("refresh", 14)} Refresh log</button>`;
  } else if (view === "model") {
    actions = `<span class="small-chip neutral">Read-only reference</span>`;
  } else if (view === "map") {
    actions = "";
  } else if (view === "simulation") {
    actions = `<button class="button" data-action="simulation-refresh">${icon("refresh", 14)} Refresh</button>`;
  } else {
    actions = `<button class="button" data-action="refresh">${icon("refresh", 14)} Refresh data</button>`;
  }
  return `<div class="heading-copy">${live}<h1>${esc(meta[0])}</h1>${meta[2] ? `<p class="page-subtitle">${esc(meta[2])}</p>` : ""}</div><div class="heading-actions">${actions}</div>`;
}

function metricCard(label, value, unit, foot, iconName, tone = "") {
  return `<article class="metric-card"><div class="metric-label">${esc(label)}<span class="metric-icon ${tone}">${icon(iconName, 14)}</span></div><div class="metric-value">${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}</div><div class="metric-foot">${foot}</div></article>`;
}

function panelHeader(title, description, iconName, right = "") {
  return `<div class="panel-heading"><div><h2 class="panel-title"><span class="panel-title-icon">${icon(iconName, 14)}</span>${esc(title)}</h2>${description ? `<p class="panel-description">${esc(description)}</p>` : ""}</div>${right ? `<div class="panel-actions">${right}</div>` : ""}</div>`;
}

function threeDayForecast(product) {
  const forecasts = state.dashboard?.forecasts || [];
  const found = forecasts.find(row => row.product_id === product.id && row.horizon_days === 3);
  if (!found) return null;
  if (found.predicted_quantity != null) return Number(found.predicted_quantity);
  if (found.forecast_demand != null) return Number(found.forecast_demand);
  return found.predicted_daily == null ? null : Number(found.predicted_daily) * 3;
}

function potentialSurplus(product) {
  const demand = threeDayForecast(product);
  return demand == null ? null : Math.max(0, Number(product.stock) - demand - Number(product.safety_stock || 0));
}

function batchRisk(batch) {
  const days = daysUntil(batch.expiry_date);
  if (days <= 0) return ["Expired", "urgent", days];
  if (days === 1) return ["1 day left", "urgent", days];
  if (days <= 3) return [`${days} days left`, "warning", days];
  return ["Usable", "neutral", days];
}

function statusPill(value) {
  const status = String(value || "open").toLowerCase();
  const tone = status === "delivered" || status === "fulfilled" ? "" : status === "approved" || status === "partially_fulfilled" ? "warning" : status === "cancelled" || status === "failed" ? "urgent" : "neutral";
  return `<span class="status-pill ${tone}">${esc(status.replaceAll("_", " "))}</span>`;
}

function auditDetails(value) {
  if (value == null) return "No details recorded";
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.details === "string") return value.details;
  return JSON.stringify(value);
}

function auditActor(record) {
  if (record.actor) return record.actor;
  if (record.actor_user_id != null) return `User ${record.actor_user_id}`;
  return "Actor not recorded";
}

function productTable(products, compact = false) {
  const latest = [...products].sort((a, b) => Number(a.id) - Number(b.id));
  return `<div class="table-wrap"><table><thead><tr><th>Product / SKU</th><th>On hand</th><th>3 day forecast</th><th>Potential surplus</th><th>Review</th></tr></thead><tbody>${latest.map(product => {
    const forecast = threeDayForecast(product);
    const surplus = potentialSurplus(product);
    const stateLabel = surplus == null ? "Forecast needed" : surplus > 0 ? "Review surplus" : product.stock < (forecast || 0) ? "Tight supply" : "Monitor";
    const tone = surplus > 0 ? "warning" : surplus == null ? "neutral" : "";
    return `<tr data-search="${esc(`${product.name} ${product.sku} ${product.category}`.toLowerCase())}"><td><span class="cell-primary">${esc(product.name)}</span><span class="cell-secondary">${esc(product.sku)} · ${esc(product.category)}</span></td><td class="numeric">${number(product.stock, 1)} ${esc(product.unit)}</td><td class="numeric">${forecast == null ? "—" : `${number(forecast, 1)} ${esc(product.unit)}`}</td><td class="numeric">${surplus == null ? "—" : `${number(surplus, 1)} ${esc(product.unit)}`}</td><td><span class="small-chip ${tone}">${stateLabel}</span></td></tr>`;
  }).join("")}</tbody></table></div>${compact ? `<div class="table-footer"><span>Current on-hand stock · prediction is model output</span><button class="text-link" data-action="view" data-view="retail">Inventory details ${icon("arrow", 12)}</button></div>` : ""}`;
}

function expiryRows(batches, limit = 5) {
  const ordered = [...batches].sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)));
  const visible = ordered.filter(batch => state.expiryFilter === "all" || (state.expiryFilter === "urgent" ? daysUntil(batch.expiry_date) <= 3 : daysUntil(batch.expiry_date) > 3)).slice(0, limit);
  if (!visible.length) return `<div class="empty-state">No batches match this expiry filter.</div>`;
  return visible.map(batch => {
    const [label, tone, days] = batchRisk(batch);
    const initials = String(batch.product || "P").trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
    return `<div class="expiry-row" data-search="${esc(`${batch.lot_code} ${batch.product} ${batch.category}`.toLowerCase())}" data-expiry-days="${days}"><span class="product-icon">${esc(initials)}</span><span class="expiry-copy"><strong>${esc(batch.product)} <span class="cell-secondary">· ${esc(batch.lot_code)}</span></strong><small>${number(batch.available, 1)} ${esc(batch.unit)} available · Expires ${formatDate(batch.expiry_date, { day: "numeric", month: "short", year: "numeric" })}</small></span><span class="expiry-qty"><span class="small-chip ${tone}">${esc(label)}</span><small>FEFO order</small></span></div>`;
  }).join("");
}

function demandCards(demands, compact = false) {
  if (!demands.length) return `<div class="empty-state"><div><strong>No open recipient needs</strong>New declared requirements will appear here when available in the workspace data.</div></div>`;
  return `<div class="demand-stack">${demands.map(demand => `<article class="demand-card" data-search="${esc(`${demand.recipient} ${demand.category} ${demand.status}`.toLowerCase())}"><div><h3>${esc(demand.recipient)} · ${esc(demand.category)}</h3><p>Needed by ${formatDate(demand.needed_by || demand.needed_until, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · ${demand.declared ? "Declared need" : "Forecast need"}</p><div class="demand-meta">${statusPill(demand.status)}<span class="small-chip neutral">${demand.declared ? "Recipient declared" : "Forecast"}</span></div></div><div class="demand-amount"><strong>${number(demand.quantity, 1)}</strong><small>${esc(demand.unit || "kg")} requested</small></div></article>`).join("")}</div>${compact && demands.length > 2 ? `<div class="table-footer"><span>${demands.length} open needs in current data</span><button class="text-link" data-action="view" data-view="demand">View recipient demand ${icon("arrow", 12)}</button></div>` : ""}`;
}

function allocationCards(allocations, actions = true) {
  if (!allocations.length) return `<div class="empty-state"><div><strong>No allocations yet</strong>Reviewed proposals and completed handoffs will appear in this list.</div></div>`;
  return `<div class="allocation-list">${allocations.map(allocation => {
    const stateName = String(allocation.status || "proposed");
    const action = actions && stateName === "proposed" ? `<button class="button button-secondary button-small" data-action="approve" data-id="${Number(allocation.id)}">Approve & reserve</button>` : actions && stateName === "approved" ? `<button class="button button-primary button-small" data-action="deliver" data-id="${Number(allocation.id)}">Confirm delivery</button>` : "";
    return `<article class="allocation-card" data-search="${esc(`${allocation.id} ${allocation.recipient} ${stateName}`.toLowerCase())}"><div><div class="allocation-title">Allocation #${Number(allocation.id)} ${statusPill(stateName)}</div><p class="allocation-sub">${esc(allocation.recipient || "Recipient")} · ${number(allocation.demand_kg, 1)} kg declared demand · ${formatDate(allocation.created_at, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</p></div><div class="allocation-actions">${action}</div></article>`;
  }).join("")}</div>`;
}

function pipeline(dashboard) {
  const allocations = dashboard.allocations || [];
  const counts = {
    stock: dashboard.batches?.filter(batch => Number(batch.available) > 0).length || 0,
    demand: dashboard.demands?.length || 0,
    review: allocations.filter(row => row.status === "proposed").length,
    delivered: allocations.filter(row => row.status === "delivered").length,
  };
  const steps = [
    ["01 · INVENTORY", counts.stock, "available batches"],
    ["02 · NEEDS", counts.demand, "open recipient needs"],
    ["03 · REVIEW", counts.review, "proposals awaiting review"],
    ["04 · DELIVERED", counts.delivered, "confirmed allocations"],
  ];
  return `<div class="timeline">${steps.map((step, i) => `<div class="timeline-step${(i === 0 && counts.stock > 0) || (i === 1 && counts.demand > 0) || (i === 2 && counts.review > 0) || (i === 3 && counts.delivered > 0) ? " active" : ""}"><strong>${step[0]}</strong><small>${number(step[1])} ${step[2]}</small></div>`).join("")}</div>`;
}

function stockChart(products) {
  const rows = products.slice(0, 7);
  if (!rows.length) return `<div class="empty-state">No product inventory is available.</div>`;
  const max = Math.max(1, ...rows.map(p => Math.max(Number(p.stock), threeDayForecast(p) || 0))) * 1.15;
  const width = 520, labelW = 105, plotW = 350, rowH = 27, top = 9;
  const ticks = [0, .25, .5, .75, 1];
  const grid = ticks.map(tick => `<line class="gridline" x1="${labelW + tick * plotW}" y1="${top - 4}" x2="${labelW + tick * plotW}" y2="${top + rows.length * rowH - 2}"/><text x="${labelW + tick * plotW}" y="${top + rows.length * rowH + 12}" text-anchor="middle">${number(max * tick, 0)}</text>`).join("");
  const bars = rows.map((product, i) => {
    const y = top + i * rowH;
    const stock = Math.max(0, Number(product.stock));
    const forecast = Math.max(0, threeDayForecast(product) || 0);
    return `<text x="0" y="${y + 10}">${esc(product.name.slice(0, 15))}</text><rect class="bar-stock" x="${labelW}" y="${y}" width="${Math.max(2, stock / max * plotW)}" height="7" rx="3"/><rect class="bar-forecast" x="${labelW}" y="${y + 10}" width="${Math.max(2, forecast / max * plotW)}" height="7" rx="3"/>`;
  }).join("");
  return `<div class="chart-wrap"><svg class="svg-chart" viewBox="0 0 ${width} ${top + rows.length * rowH + 25}" role="img" aria-label="Available stock compared with three day forecast by product">${grid}${bars}</svg><div class="chart-legend"><span class="legend-item"><i class="legend-dot" style="background:#40cf9a"></i>Available stock</span><span class="legend-item"><i class="legend-dot" style="background:#576b87"></i>3 day forecast</span><span class="panel-kicker">Units vary by SKU</span></div></div>`;
}

function renderOverview(d) {
  const m = d.metrics || {};
  const expiring = (d.batches || []).filter(batch => daysUntil(batch.expiry_date) <= 3 && Number(batch.available) > 0);
  const expiringKg = expiring.filter(batch => batch.unit === "kg").reduce((sum, batch) => sum + Number(batch.available || 0), 0);
  const recent = (d.allocations || []).slice(0, 4);
  const e = d.economics || {};
  return `<section class="metric-grid">
      ${metricCard("Available inventory batches", number(m.active_batches), "batches", "Stock with usable, unreserved quantity", "inventory")}
      ${metricCard("Near expiry · 3 days", number(expiringKg, 1), "kg", `${expiring.length} batches · kg-denominated lots`, "clock", "warning")}
      ${metricCard("Open recipient demand", number(m.open_demand_kg, 1), "kg", `${(d.demands || []).length} declared needs in this view`, "community")}
      ${metricCard("Confirmed deliveries", number(m.delivered_kg, 1), "kg", `${recent.filter(row => row.status === "delivered").length} recent delivered allocation${recent.filter(row => row.status === "delivered").length === 1 ? "" : "s"}`, "leaf")}
    </section>
    <section class="panel">${panelHeader("Redistribution pipeline", "Live counts from inventory, recipient needs, proposals, and confirmed allocations.", "matching", `<span class="panel-kicker">${(d.allocations || []).length} recent allocations</span>`)}${pipeline(d)}</section>
    <section class="panel-grid" style="margin-top:13px">
      <article class="panel">${panelHeader("Inventory & demand outlook", "Available stock compared with the latest 3 day model forecast.", "analytics", `<button class="text-link" data-action="view" data-view="retail">Full inventory ${icon("arrow", 12)}</button>`)}${productTable(d.products || [], true)}</article>
      <article class="panel">${panelHeader("Expiry watch", "Earliest expiry first · available quantity excludes reservations.", "clock", `<button class="text-link" data-action="view" data-view="retail">Review batches ${icon("arrow", 12)}</button>`)}<div class="expiry-list">${expiryRows(d.batches || [], 4)}</div>${expiring.length ? `<div class="urgency-banner">${icon("warning", 14)} ${expiring.length} available batch${expiring.length === 1 ? "" : "es"} expire within three days.</div>` : ""}</article>
    </section>
    <section class="panel-grid equal" style="margin-top:13px">
      <article class="panel">${panelHeader("Recipient needs", "Declared requirements currently open for fulfilment.", "community", `<button class="text-link" data-action="view" data-view="demand">Demand view ${icon("arrow", 12)}</button>`)}${demandCards((d.demands || []).slice(0, 3), true)}</article>
      <article class="panel">${panelHeader("Delivery impact", "Economic estimates use delivered allocation records only.", "leaf", `<span class="small-chip neutral">Assumptions shown</span>`)}<div class="surplus-list"><div class="surplus-row"><div class="surplus-main"><strong>Recipient procurement savings</strong><small>Illustrative estimate</small></div><div class="surplus-value">${money(e.procurement_savings)}</div></div><div class="surplus-row"><div class="surplus-main"><strong>Avoided disposal</strong><small>Illustrative estimate</small></div><div class="surplus-value">${money(e.avoided_disposal)}</div></div><div class="surplus-row"><div class="surplus-main"><strong>Transport & handling</strong><small>Estimated delivered cost</small></div><div class="surplus-value">${money(e.transport_and_handling)}</div></div><div class="surplus-row"><div class="surplus-main"><strong>Net economic benefit</strong><small>Estimated from current assumptions</small></div><div class="surplus-value">${money(e.net_benefit)}</div></div></div><div class="impact-callout">${icon("shield", 16)}<span><strong>Human review stays in the loop</strong><small>Recommendations are suggestions. Inventory is reserved only after approval, and impact changes after a delivery is confirmed.</small></span></div></article>
    </section>
    <section class="panel" style="margin-top:13px">${panelHeader("Recent allocation activity", "Latest proposals and completed handoffs returned by the dashboard API.", "activity", `<button class="text-link" data-action="view" data-view="logistics">Open fulfilment ${icon("arrow", 12)}</button>`)}${allocationCards(recent, false)}</section>`;
}

function renderRetail(d) {
  const p = d.products || [];
  const expiring = (d.batches || []).filter(batch => daysUntil(batch.expiry_date) <= 3 && Number(batch.available) > 0);
  const ml = state.evaluation;
  const mlSummary = ml ? `Synthetic holdout WAPE ${number(ml.random_forest?.wape_pct, 2)}% · lag 7 baseline ${number(ml.baseline_lag_7?.wape_pct, 2)}%.` : "Forecast evaluation is not available.";
  const tabs = `<div class="filter-group" role="group" aria-label="Filter expiry batches"><button class="filter-chip${state.expiryFilter === "all" ? " is-active" : ""}" data-action="expiry-filter" data-filter="all">All batches</button><button class="filter-chip${state.expiryFilter === "urgent" ? " is-active" : ""}" data-action="expiry-filter" data-filter="urgent">Due ≤ 3 days</button><button class="filter-chip${state.expiryFilter === "later" ? " is-active" : ""}" data-action="expiry-filter" data-filter="later">Later</button></div>`;
  return `<section class="metric-grid">${metricCard("Products tracked", number(p.length), "SKUs", "Current store catalogue", "package")}${metricCard("Available batches", number((d.batches || []).filter(batch => Number(batch.available) > 0).length), "lots", "After stock reservations", "inventory")}${metricCard("Expiry review", number(expiring.length), "batches", "Available lots expiring within 3 days", "clock", expiring.length ? "warning" : "")}${metricCard("Demand model", ml ? `${number(ml.random_forest?.wape_pct, 1)}%` : "—", "WAPE", "Synthetic validation · not a store guarantee", "analytics")}</section>
    <section class="panel">${panelHeader("Product outlook", "Use the latest model run to compare stock with expected demand. Surplus is a review signal, not a donation commitment.", "analytics", `<button class="button button-secondary button-small" data-action="forecast">${icon("sparkles", 12)} Run forecast</button>`)}${productTable(p)}<div class="table-footer"><span>${esc(mlSummary)}</span><span>${ml ? `${number(ml.rows)} synthetic observations` : "Evaluation unavailable"}</span></div></section>
    <section class="panel" style="margin-top:13px">${panelHeader("Batch expiry watch", "FEFO order · physical quantity minus reserved stock.", "clock", `<button class="button button-primary button-small" data-action="receive-stock">${icon("package", 12)} Receive batch</button>`)}<div class="filter-row">${tabs}<span class="panel-kicker">${expiring.length} batches expiring within 3 days</span></div><div class="table-wrap"><table><thead><tr><th>Batch / lot</th><th>Product</th><th>Available</th><th>Reserved</th><th>Expiry</th><th>Review</th></tr></thead><tbody>${(d.batches || []).filter(batch => state.expiryFilter === "all" || (state.expiryFilter === "urgent" ? daysUntil(batch.expiry_date) <= 3 : daysUntil(batch.expiry_date) > 3)).map(batch => { const [label, tone] = batchRisk(batch); return `<tr class="batch-row" data-search="${esc(`${batch.lot_code} ${batch.product} ${batch.sku || ""} ${batch.category}`.toLowerCase())}"><td><span class="cell-primary">${esc(batch.lot_code)}</span><span class="cell-secondary">Batch ${Number(batch.batch_id)}</span></td><td><span class="cell-primary">${esc(batch.product)}</span><span class="cell-secondary">${esc(batch.category)} · ${esc(batch.storage)}</span></td><td class="numeric">${number(batch.available, 1)} ${esc(batch.unit)}</td><td class="numeric">${number(batch.reserved, 1)} ${esc(batch.unit)}</td><td>${formatDate(batch.expiry_date, { day: "numeric", month: "short", year: "numeric" })}</td><td><span class="small-chip ${tone}">${esc(label)}</span></td></tr>`; }).join("")}</tbody></table></div></section>
    <section class="panel-grid equal" style="margin-top:13px"><article class="panel">${panelHeader("Receive stock", "Add a new lot with its expiry date and unit quantity.", "package")}<p class="page-subtitle">Inventory changes are recorded against the selected product. Use the receive action to submit through the existing inventory API.</p><button class="button button-primary" data-action="receive-stock" style="margin-top:14px">${icon("package", 13)} Receive inventory</button></article><article class="panel">${panelHeader("Sales data", "Record individual sales or import a CSV / Excel workbook.", "scale")}<p class="page-subtitle">The forecast learns from recorded sales history. Use the provided template to match the accepted SKU, date, and quantity columns.</p><div class="panel-actions" style="margin-top:14px"><button class="button button-secondary" data-action="record-sale">${icon("scale", 13)} Record sale</button><button class="button" data-action="import-sales">${icon("upload", 13)} Import file</button></div></article></section>`;
}

function renderDemand(d) {
  const demands = d.demands || [];
  const total = demands.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const recipients = new Set(demands.map(row => row.recipient)).size;
  return `<section class="metric-grid">${metricCard("Open requirements", number(demands.length), "needs", "From the current demand response", "community")}${metricCard("Quantity requested", number(total, 1), "kg", "Sum of open declared requirements", "scale")}${metricCard("Recipient organizations", number(recipients), "groups", "Distinct recipients represented", "community")}${metricCard("Need type", `${demands.filter(row => row.declared).length}/${demands.length}`, "declared", "Non-declared forecasts are labeled separately", "shield")}</section>
    <section class="panel">${panelHeader("Open recipient requirements", "Requests returned by the existing dashboard API. This local build can review needs but has no demand create or edit endpoint.", "community", `<span class="small-chip neutral">Read-only source data</span>`)}${demandCards(demands)}</section>
    <section class="panel-grid equal" style="margin-top:13px"><article class="panel">${panelHeader("Allocation coverage", "Open needs can be reviewed in the matching workspace.", "matching")}<p class="page-subtitle">Recommendations compare recipient category and storage constraints with unreserved batches and expiry dates.</p><button class="button button-primary" data-action="view" data-view="matching" style="margin-top:14px">Open match desk ${icon("arrow", 12)}</button></article><article class="panel">${panelHeader("Recipient data", "Fields available to this interface.", "shield")}<div class="surplus-list"><div class="surplus-row"><div class="surplus-main"><strong>Organization and category</strong><small>Recipient name, category, open status</small></div><span class="small-chip">Available</span></div><div class="surplus-row"><div class="surplus-main"><strong>Needed by</strong><small>Requested delivery window</small></div><span class="small-chip">Available</span></div><div class="surplus-row"><div class="surplus-main"><strong>Capacity / storage</strong><small>Used by the match engine for eligibility</small></div><span class="small-chip neutral">Not returned in dashboard</span></div></div></article></section>`;
}

function renderMatches() {
  if (state.matches === null) {
    return `<section class="panel">${panelHeader("Eligibility based on live records", "The match endpoint checks open needs, category, storage compatibility, available stock, and batch expiry.", "matching")}<div class="match-layout"><div class="empty-state"><div><strong>Ready to find eligible matches</strong>Run the match check to request fresh recommendations from the existing API. This preview does not reserve stock.</div><button class="button button-primary" data-action="find-matches" style="margin-top:13px">${icon("sparkles", 13)} Find matches</button></div><aside class="panel match-detail-panel">${panelHeader("Human review workflow", "Every proposal requires an explicit approval before stock is reserved.", "shield")}<div class="timeline"><div class="timeline-step active"><strong>01 · SUGGEST</strong><small>Preview only</small></div><div class="timeline-step"><strong>02 · PROPOSE</strong><small>Reviewer creates</small></div><div class="timeline-step"><strong>03 · APPROVE</strong><small>Reserves stock</small></div><div class="timeline-step"><strong>04 · DELIVER</strong><small>Confirms impact</small></div></div><div class="rationale-box"><h3>${icon("shield", 14)} Guardrails</h3><p>Suggestions exclude expired or reserved stock. Matching remains category and storage aware. A human approves each proposal before inventory changes.</p></div></aside></div></section>`;
  }
  const matches = state.matches;
  const allocations = (state.dashboard?.allocations || []).slice(0, 4);
  return `<section class="metric-grid">${metricCard("Eligible suggestions", number(matches.length), "matches", "Returned by the live match endpoint", "matching")}${metricCard("Open needs", number(state.dashboard?.demands?.length || 0), "requests", "Current declared recipient requirements", "community")}${metricCard("Available batches", number((state.dashboard?.batches || []).filter(batch => Number(batch.available) > 0 && daysUntil(batch.expiry_date) >= 0).length), "lots", "Unexpired and not fully reserved", "inventory")}${metricCard("Approval control", "Human", "in the loop", "No recommendation commits stock by itself", "shield")}</section>
    <section class="match-layout"><div><div class="filter-row"><div><h2 class="panel-title">Live match queue <span class="small-chip">${matches.length} returned</span></h2><p class="panel-description">Candidates returned by the API · ranked by expiry order</p></div><button class="button button-small" data-action="find-matches">${icon("refresh", 12)} Refresh</button></div><div class="match-queue">${matches.length ? matches.map((match, index) => `<article class="match-card" data-search="${esc(`${match.product} ${match.recipient} ${match.category} ${match.batch}`.toLowerCase())}"><div class="match-card-header"><div class="match-pair"><strong>${esc(match.product)} <span style="color:#7f91a7;font-weight:400">→</span> ${esc(match.recipient)}</strong><small>${esc(match.category)} · batch ${esc(match.batch)} · expires ${formatDate(match.expiry_date, { day: "numeric", month: "short" })}</small></div><div class="match-quantity">${number(match.quantity, 1)}<small>kg suggested</small></div></div><div class="match-details"><span class="small-chip">Category compatible</span><span class="small-chip">Expiry safe</span><span class="small-chip neutral">No stock reserved</span></div><p class="match-explanation">${esc(match.explanation)}</p><div class="match-card-footer"><span class="distance-label">${icon("pin", 12)} ${number(match.estimated_km, 1)} km estimated · ${money(match.estimated_transport_cost)} transport est.</span><button class="button button-secondary button-small" data-action="propose" data-index="${index}">Create proposal ${icon("arrow", 11)}</button></div></article>`).join("") : `<div class="empty-state"><div><strong>No eligible suggestions returned</strong>Check open needs, stock availability, storage compatibility, and expiry dates.</div></div>`}</div></div><aside class="panel match-detail-panel">${panelHeader("Review before proposal", "Recommendations include an explanation from the service.", "shield")}<div class="route-visual"><span class="route-line"></span><span class="route-point start"></span><span class="route-point end"></span><span class="route-estimate">Distance is an estimate</span><div class="route-endpoints"><div><strong>Green Basket Market</strong><small>Store origin</small></div><div style="text-align:right"><strong>${matches.length ? esc(matches[0].recipient) : "Recipient site"}</strong><small>Suggested destination</small></div></div></div><div class="rationale-box"><h3>${icon("sparkles", 14)} Match explanation</h3><p>${matches.length ? esc(matches[0].explanation) : "No eligible suggestions in the current response."} Distance uses the backend estimate; route optimization and live fleet positions are not exposed by this API.</p></div><div class="review-actions"><button class="button button-primary" data-action="view" data-view="demand">Review recipient needs</button></div>${allocations.length ? `<div style="margin-top:16px">${panelHeader("Recent allocations", "Approval and delivery status from the dashboard.", "activity")}${allocationCards(allocations)}</div>` : ""}</aside></section>`;
}

function renderLogistics(d) {
  const allocations = d.allocations || [];
  const count = (status) => allocations.filter(row => row.status === status).length;
  const deliveredKg = allocations.filter(row => row.status === "delivered").reduce((sum, row) => sum + Number(row.demand_kg || 0), 0);
  return `<section class="metric-grid">${metricCard("Awaiting approval", number(count("proposed")), "proposals", "Stock is not reserved until approval", "clock", count("proposed") ? "warning" : "")}${metricCard("Ready for handoff", number(count("approved")), "approved", "Approved allocations available to deliver", "truck")}${metricCard("Delivered allocations", number(count("delivered")), "records", "Recent allocation records returned", "check")}${metricCard("Delivered quantity", number(deliveredKg, 1), "kg", "Recent delivered demand quantity", "leaf")}</section>
    <section class="panel">${panelHeader("Handoff status", "State is based on allocation records; there is no separate fleet or route feed in this API.", "truck", `<span class="small-chip neutral">No live fleet telemetry</span>`)}${pipeline(d)}<div class="rationale-box"><h3>${icon("pin", 14)} Route data availability</h3><p>Candidate distances are available from the matching endpoint. The backend does not expose vehicle assignments, route geometry, or a delivery list, so this view shows allocation state without inventing fleet data.</p></div></section>
    <section class="panel" style="margin-top:13px">${panelHeader("Allocation handoffs", "Proposed → approved (stock reserved) → delivered. Failed handoffs release reserved stock.", "activity", `<span class="panel-kicker">${allocations.length} recent records</span>`)}${allocationCards(allocations)}</section>
    <section class="panel-grid equal" style="margin-top:13px"><article class="panel">${panelHeader("Dispatch checklist", "Before confirming a delivery.", "shield")}<div class="surplus-list"><div class="surplus-row"><div class="surplus-main"><strong>Proposal is approved</strong><small>Approval transaction reserves matching inventory.</small></div><span class="small-chip">Required</span></div><div class="surplus-row"><div class="surplus-main"><strong>Correct recipient and quantity</strong><small>Confirm the allocation details with the recipient.</small></div><span class="small-chip">Review</span></div><div class="surplus-row"><div class="surplus-main"><strong>Confirm delivered status</strong><small>Delivery confirmation updates inventory and impact.</small></div><span class="small-chip">Action</span></div></div></article><article class="panel">${panelHeader("Create an allocation proposal", "Start from the current match recommendations.", "matching")}<p class="page-subtitle">The proposal action carries the selected demand ID, batch ID, and quantity to the existing API. Approval is an explicit second step.</p><button class="button button-primary" data-action="view" data-view="matching" style="margin-top:14px">Open match desk ${icon("arrow", 12)}</button></article></section>`;
}

function impactLineChart(d) {
  const delivered = Number(d.metrics?.delivered_kg || 0);
  const econ = d.economics || {};
  const values = [Number(econ.procurement_savings || 0), Number(econ.avoided_disposal || 0), Number(econ.transport_and_handling || 0), Number(econ.net_benefit || 0)];
  const max = Math.max(1, ...values) * 1.15;
  const points = values.map((value, i) => `${42 + i * 130},${117 - value / max * 75}`).join(" ");
  const labels = ["Savings", "Disposal", "Handling", "Net benefit"];
  return `<div class="chart-wrap"><svg class="svg-chart" viewBox="0 0 470 150" role="img" aria-label="Illustrative economic impact values"><line class="gridline" x1="20" y1="40" x2="450" y2="40"/><line class="gridline" x1="20" y1="78" x2="450" y2="78"/><line class="gridline" x1="20" y1="116" x2="450" y2="116"/><polyline class="line-impact" points="${points}"/>${values.map((value, i) => `<circle class="dot-impact" cx="${42 + i * 130}" cy="${117 - value / max * 75}" r="4"/><text x="${42 + i * 130}" y="145" text-anchor="middle">${labels[i]}</text><text x="${42 + i * 130}" y="${108 - value / max * 75}" text-anchor="middle">${money(value)}</text>`).join("")}</svg></div><div class="panel-kicker">${number(delivered, 1)} kg delivered · estimates use the assumptions returned by the API</div>`;
}

function renderAnalytics(d) {
  const e = d.economics || {};
  const evals = state.evaluation;
  return `<section class="metric-grid">${metricCard("Food delivered", number(d.metrics?.delivered_kg, 1), "kg", "Confirmed deliveries in the current database", "leaf")}${metricCard("Recipient savings", money(e.procurement_savings), "estimated", "Illustrative procurement value per kg", "analytics")}${metricCard("Disposal avoided", money(e.avoided_disposal), "estimated", "Illustrative disposal cost per kg", "package")}${metricCard("Net economic benefit", money(e.net_benefit), "estimated", `Transport & handling ${money(e.transport_and_handling)}`, "trend")}</section>
    <section class="panel-grid"><article class="panel">${panelHeader("Economic impact", "Values calculated from confirmed delivered quantities.", "analytics", `<span class="small-chip neutral">Assumptions shown</span>`)}${impactLineChart(d)}<div class="impact-callout">${icon("warning", 15)}<span><strong>Use as a pilot estimate</strong><small>${esc(e.assumption || "Economic values use illustrative assumptions until measured costs are connected.")}</small></span></div></article><article class="panel">${panelHeader("Stock versus 3 day demand", "Latest forecast and on-hand quantities by product.", "inventory")}${stockChart(d.products || [])}</article></section>
    <section class="panel" style="margin-top:13px">${panelHeader("Forecast evaluation", "Synthetic holdout results are shown to make model limitations visible.", "sparkles", `<span class="small-chip warning">Synthetic data only</span>`)}${evals ? `<div class="surplus-list"><div class="surplus-row"><div class="surplus-main"><strong>Random Forest · holdout WAPE</strong><small>Chronological final 30 days held out</small></div><div class="surplus-value">${number(evals.random_forest?.wape_pct, 2)}%</div></div><div class="surplus-row"><div class="surplus-main"><strong>Lag 7 baseline · holdout WAPE</strong><small>Comparison baseline</small></div><div class="surplus-value">${number(evals.baseline_lag_7?.wape_pct, 2)}%</div></div><div class="surplus-row"><div class="surplus-main"><strong>Evaluation history</strong><small>${number(evals.rows)} synthetic daily observations · ${number(evals.sku_count)} SKUs</small></div><span class="small-chip neutral">${esc(evals.date_start)} – ${esc(evals.date_end)}</span></div></div><p class="panel-description" style="margin-top:11px">${esc(evals.limitations || "These metrics are not a guarantee of real-store forecast quality.")}</p>` : `<div class="empty-state">Forecast evaluation is unavailable from the API.</div>`}</section>`;
}

async function loadAudit() {
  try {
    state.audit = await api("/api/audit");
    renderView();
  } catch (error) {
    toast(`Activity log failed to load: ${error.message}`, "error");
  }
}

function renderActivity() {
  const records = state.audit;
  if (records === null) {
    return `<section class="panel"><div class="empty-state"><div><strong>Loading activity</strong>Retrieving the latest audit records.</div></div></section>`;
  }
  if (!records.length) return `<section class="panel">${panelHeader("Recent activity", "No audit events were returned.", "activity")}<div class="empty-state">The activity log is empty.</div></section>`;
  return `<section class="panel">${panelHeader("Recent activity", "Latest records returned from the audit endpoint.", "activity", `<span class="small-chip neutral">${records.length} events</span>`)}<div class="activity-list">${records.map(record => { const details = auditDetails(record.details); const actor = auditActor(record); return `<article class="activity-row" data-search="${esc(`${actor} ${record.action} ${record.entity} ${details}`.toLowerCase())}"><span class="activity-marker"></span><div class="activity-main"><strong>${esc(record.action)} · ${esc(record.entity)}${record.entity_id ? ` #${Number(record.entity_id)}` : ""}</strong><small>${esc(details)} <span class="activity-actor">· ${esc(actor)}</span></small></div><time class="activity-time">${formatDate(record.occurred_at, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</time></article>`; }).join("")}</div></section>`;
}

function renderSchema() {
  const tableCount = schemaTables.length;
  const fieldCount = schemaTables.reduce((sum, table) => sum + table.columns.length, 0);
  const domains = schemaDomains.map(domain => `<article class="panel schema-domain" aria-label="${esc(domain.name)} entities"><div class="schema-domain-head"><span class="schema-domain-dot"></span><div><h3>${esc(domain.name)}</h3><small>${domain.tables.length} entities</small></div></div><div class="schema-entity-list">${domain.tables.map((name, index) => `<button type="button" class="schema-entity" data-action="open-entity" data-entity="${name}" data-search="${esc(name)}"><span class="schema-entity-name">${esc(name)}</span><span class="schema-entity-meta">${schemaTables.find(table => table.name === name)?.columns.length || 0} fields</span>${index < domain.tables.length - 1 ? '<span class="schema-flow" aria-hidden="true"></span>' : ''}</button>`).join("")}</div></article>`).join("");
  const entities = schemaTables.map(table => `<details class="schema-table-card" id="schema-${table.name}" data-search="${esc(`${table.name} ${table.domain} ${table.columns.map(column => column[0]).join(" ")}`.toLowerCase())}"><summary><span><strong>${esc(table.name)}</strong><small>${esc(table.domain)}</small></span><span class="schema-table-count">${table.columns.length} fields <span aria-hidden="true">⌄</span></span></summary><div class="schema-table-content"><div class="schema-columns">${table.columns.map(([name, type, key]) => `<div class="schema-column"><code>${esc(name)}</code><span>${esc(type)}</span>${key ? `<b class="schema-key">${esc(key)}</b>` : ""}</div>`).join("")}</div>${table.constraints.length ? `<div class="schema-constraints"><strong>Rules & indexes</strong><ul>${table.constraints.map(rule => `<li>${esc(rule)}</li>`).join("")}</ul></div>` : ""}</div></details>`).join("");
  const relations = schemaRelations.map(relation => `<tr data-search="${esc(`${relation.from} ${relation.to} ${relation.toColumn}`.toLowerCase())}"><td><button type="button" class="schema-link" data-action="open-entity" data-entity="${relation.from}">${esc(relation.from)}<small>.${esc(relation.fromColumn)}</small></button></td><td><span class="schema-cardinality" aria-label="one to many">1 → many</span></td><td><button type="button" class="schema-link" data-action="open-entity" data-entity="${relation.to}">${esc(relation.to)}<small>.${esc(relation.toColumn)}</small></button></td><td>${relation.optional ? '<span class="small-chip neutral">Optional</span>' : '<span class="small-chip">Required</span>'}</td></tr>`).join("");
  const viewFields = schemaView.columns.map(([name, type]) => `<span class="schema-view-field"><code>${esc(name)}</code><small>${esc(type)}</small></span>`).join("");
  return `<section class="metric-grid">${metricCard("Schema tables", number(tableCount), "entities", "Across five domains", "database")}${metricCard("Columns", number(fieldCount), "fields", "Persisted model", "inventory")}${metricCard("Foreign keys", number(schemaRelations.length), "relationships", "Required and optional", "matching")}${metricCard("Database view", "1", "derived", "Available batch stock", "analytics")}</section>
    <section class="panel schema-intro">${panelHeader("Entity relationship model", "Tables, keys and links.", "database", `<a class="button button-small" href="/static/annsetu-er-model.svg" download="annsetu-er-model.svg">Download ER diagram</a>`)}<div class="schema-figure-scroll"><figure class="schema-figure"><img src="/static/annsetu-er-model.svg" alt="AnnSetu entity relationship diagram with ${tableCount} PostgreSQL tables and ${schemaRelations.length} foreign-key relationships."><figcaption>${tableCount} tables · ${schemaRelations.length} foreign-key links · <a href="/static/annsetu-er-model.svg" target="_blank" rel="noreferrer">Open full size</a></figcaption></figure></div><div class="schema-legend"><span><b>PK</b> Primary key</span><span><b>FK</b> Foreign key</span><span><b>UQ</b> Unique</span><span><i></i> Optional</span></div><div class="schema-domain-grid">${domains}</div><div class="schema-flow-caption">Entity groups and foreign-key links.</div></section>
    <section class="panel" style="margin-top:13px">${panelHeader("Entity relationships", "Every declared foreign key, shown as parent key → referencing field.", "matching", `<span class="panel-kicker">${schemaRelations.length} links</span>`)}<div class="table-wrap schema-relations-wrap"><table class="schema-relations"><thead><tr><th>Parent</th><th>Cardinality</th><th>Child reference</th><th>Nullability</th></tr></thead><tbody>${relations}</tbody></table></div></section>
    <section class="panel" style="margin-top:13px">${panelHeader("Complete table catalog", `${tableCount} tables · ${fieldCount} columns · keys, data types, and important constraints.`, "inventory", `<button class="button button-small" type="button" data-action="schema-expand">Expand all</button><button class="button button-small" type="button" data-action="schema-collapse">Collapse all</button>`)}<div class="schema-table-list">${entities}</div></section>
    <section class="panel schema-view-panel" style="margin-top:13px">${panelHeader(`Derived view · ${schemaView.name}`, schemaView.description, "analytics", `<span class="small-chip neutral">Read-only</span>`)}<div class="schema-view-fields">${viewFields}</div><p class="schema-note">This view joins batch, product, and category records; <code>available</code> is computed as <code>quantity − reserved</code>.</p></section>
    <p class="schema-source-note">Source: <code>sql/annsetu_python_mysql.sql</code>. This page documents the XAMPP schema and does not query schema metadata from the running database.</p>`;
}

function renderMap() {
  const data = state.mapData;
  const recipients = data?.recipients || [];
  const categories = data?.categories || [];
  const demandCount = (data?.demands || []).length;
  const availableKg = (data?.stores || []).reduce((sum, store) => sum + Number(store.available_kg || 0), 0);
  return `<section class="map-layout">
    <div class="panel map-panel">
      <div class="map-toolbar"><div><strong>Pune network</strong><small id="map-status">${data ? "Live locations" : "Loading locations…"}</small></div><div class="map-tools"><button class="button button-small" data-action="map-locate">${icon("pin", 13)} Locate me</button><button class="map-zoom" data-action="map-zoom-out" aria-label="Zoom out">−</button><button class="map-zoom" data-action="map-zoom-in" aria-label="Zoom in">+</button></div></div>
      <div id="network-map" class="network-map" role="region" aria-label="Map of AnnSetu stores, recipients, and demand"><div class="map-loading">Map loading…</div></div>
      <div class="map-legend"><span><i class="map-dot store"></i>Store</span><span><i class="map-dot recipient"></i>Recipient</span><span><i class="map-dot demand"></i>Open need</span><span><i class="map-dot current"></i>Your location</span><small>© OpenStreetMap contributors</small></div>
    </div>
    <aside class="map-side">
      <section class="panel map-summary"><div class="map-summary-grid"><div><small>Available stock</small><strong>${number(availableKg, 1)} <em>kg</em></strong></div><div><small>Open needs</small><strong>${number(demandCount)}</strong></div></div></section>
      <section class="panel map-demand-panel">${panelHeader("Simulate demand", "", "community")}
        <form id="map-demand-form" class="compact-form">
          <label class="form-field"><span>Recipient</span><select name="recipient_id" required>${recipients.map(site => `<option value="${site.id}">${esc(site.name)}</option>`).join("")}</select></label>
          <label class="form-field"><span>Category</span><select name="category_id" required>${categories.map(category => `<option value="${category.id}">${esc(category.name)}</option>`).join("")}</select></label>
          <label class="form-field"><span>Quantity</span><input name="quantity" type="number" min="1" max="500" step="1" value="20" required></label>
          <button class="button button-primary" type="submit">Add need</button>
        </form>
        <p class="map-privacy-note">Your location stays on this device.</p>
      </section>
      <section class="panel map-sites">${panelHeader("Network sites", "", "pin")}
        <div class="map-site-list">${[...(data?.stores || []).map(x => ({...x,kind:"store",value:`${number(x.available_kg,1)} kg` })),...recipients.map(x => ({...x,kind:"recipient",value:`${number(x.capacity_kg,0)} kg capacity`}))].map(site => `<div class="map-site-row"><i class="map-dot ${site.kind}"></i><span><strong>${esc(site.name)}</strong><small>${esc(site.city)}</small></span><b>${esc(site.value)}</b></div>`).join("") || `<div class="empty-state">No sites yet</div>`}</div>
      </section>
    </aside>
  </section>`;
}

function renderSimulation() {
  const sim = state.simulation;
  const run = sim?.run;
  const metrics = sim?.metrics || {};
  const active = run?.status === "running" || run?.status === "queued";
  const recipients = state.mapData?.recipients || [];
  const status = run?.status || "Ready";
  const progress = metrics.total ? Math.round((metrics.completed + metrics.failed + metrics.skipped) / metrics.total * 100) : 0;
  const events = sim?.events || [];
  const eventRows = events.slice().reverse().map(e => {
    const r=e.result||{};
    const detail=e.event_type==="allocate" ? `${number(r.allocated_kg,1)} kg${r.reason?` · ${esc(r.reason)}`:""}` : e.event_type==="dispatch" ? (r.skipped?"No stock reserved":`${number(r.delivered_kg,1)} kg delivered`) : e.event_type==="sale" ? `${esc(r.sku||"")} · ${number(r.quantity,1)} units` : e.event_type==="forecast" ? `${number(r.forecast_rows,0)} predictions` : (r.status||"Route update");
    return `<tr><td>${String(e.sequence_no+1).padStart(2,"0")}</td><td>${esc(e.event_type.replaceAll("_"," "))}</td><td>${esc(detail)}</td><td><span class="event-state ${esc(e.status)}">${esc(e.status)}</span></td><td>${formatDate(e.completed_at||e.scheduled_at,{hour:"numeric",minute:"2-digit",second:"2-digit"})}</td></tr>`;
  }).join("");
  return `<section class="simulation-grid">
    <section class="panel simulation-setup">${panelHeader("Scenario controls", "Scheduled workload", "activity")}
      <form id="simulation-form" class="form-grid simulation-form">
        <label class="form-field full"><span>Recipient site</span><select name="recipient_id" required>${recipients.map(site=>`<option value="${site.id}">${esc(site.name)} · ${esc(site.city)}</option>`).join("")}</select></label>
        <label class="form-field"><span>Demand · kg</span><input type="number" name="demand_kg" min="1" max="500" value="20" required></label>
        <label class="form-field"><span>Sales events</span><input type="number" name="sale_events" min="4" max="64" value="16" required></label>
        <label class="form-field"><span>Allocation attempts</span><input type="number" name="allocation_attempts" min="2" max="32" value="8" required></label>
        <label class="form-field"><span>Concurrent workers</span><select name="workers"><option value="1">1 · serial</option><option value="2">2</option><option value="4" selected>4</option><option value="8">8</option></select></label>
        <div class="simulation-controls full"><button class="button button-primary" type="submit" ${active?"disabled":""}>${active?"Simulation running":"Run simulation"}</button>${active?`<button class="button" type="button" data-action="simulation-stop" data-id="${run.id}">Stop</button>`:""}${run&&!active?`<button class="button" type="button" data-action="simulation-clear" data-id="${run.id}">Clear run</button>`:""}</div>
      </form>
      <div class="simulation-checks"><span><i class="event-check"></i>Schedule queue</span><span><i class="event-check"></i>Row locks</span><span><i class="event-check"></i>Forecast inference</span><span><i class="event-check"></i>Delivery ledger</span></div>
    </section>
    <section class="panel simulation-monitor">${panelHeader("Run monitor", run?`Run #${run.id} · ${esc(run.scenario)}`:"No run yet", "sparkles", `<span class="event-state ${esc(run?.status||"queued")}">${esc(status)}</span>`)}
      ${run?`<div class="simulation-progress"><span><i style="width:${progress}%"></i></span><b>${progress}%</b></div><div class="metric-grid simulation-metrics">${metricCard("Events",`${number(metrics.completed)}/${number(metrics.total)}`,"done",`${number(metrics.failed)} failed · ${number(metrics.skipped)} skipped`,"activity")}${metricCard("Allocation wins",number(metrics.allocations_won),`of ${number(metrics.allocation_attempts)}`,`${number(metrics.allocated_kg,1)} kg reserved`,"matching")}${metricCard("Delivered",number(metrics.delivered_kg,1),"kg","Committed stock reduction","truck")}${metricCard("Forecast",number(metrics.forecasts),"runs","Random Forest","analytics")}</div>`:`<div class="empty-state simulation-empty">Choose a recipient and run the scenario.</div>`}
    </section>
    <section class="panel simulation-events">${panelHeader("Event stream", `${events.length} scheduled`, "clock", run?`<span class="small-chip neutral">${number(run.config?.sale_events)} sales · ${number(run.config?.allocation_attempts)} contenders</span>`:"")}
      ${events.length?`<div class="table-wrap"><table class="simulation-table"><thead><tr><th>#</th><th>Event</th><th>Result</th><th>Status</th><th>Time</th></tr></thead><tbody>${eventRows}</tbody></table></div>`:`<div class="empty-state">Scheduled events appear here as they run.</div>`}
    </section>
  </section>`;
}

async function loadMapData() {
  try {
    const [data,config]=await Promise.all([api("/api/map"),api("/api/map/config")]);
    state.mapData=data; state.mapConfig=config;
    if(state.view==="map"){ $("#view-content").innerHTML=renderMap(); applySearch($("#global-search").value); drawMap(); }
    if(state.view==="simulation"){ $("#view-content").innerHTML=renderSimulation(); applySearch($("#global-search").value); }
  } catch(error) { if(state.view==="map"||state.view==="simulation") toast(`Network data unavailable: ${error.message}`,"error"); }
}

async function loadSimulation() {
  try {
    const result=await api("/api/simulations");
    state.simulation=result.simulation;
    if(state.view==="simulation"){ $("#view-content").innerHTML=renderSimulation(); applySearch($("#global-search").value); }
    if(state.view==="simulation"&&state.simulation?.run?.status==="running") pumpSimulation(state.simulation.run.id,state.simulationWorkers);
  } catch(error) { if(state.view==="simulation") toast(`Simulation unavailable: ${error.message}`,"error"); }
}

function tileWorld(lat,lon,zoom) {
  const size=256*2**zoom, safeLat=Math.max(-85.0511,Math.min(85.0511,lat)), rad=safeLat*Math.PI/180;
  return {x:(lon+180)/360*size,y:(1-Math.asinh(Math.tan(rad))/Math.PI)/2*size};
}
function worldGeo(x,y,zoom) {
  const size=256*2**zoom, lon=x/size*360-180, n=Math.PI-2*Math.PI*y/size;
  return {lat:180/Math.PI*Math.atan(Math.sinh(n)),lon};
}
function drawMap() {
  const surface=$("#network-map"), data=state.mapData;
  if(!surface||!data)return;
  const width=surface.clientWidth||720,height=surface.clientHeight||420,z=state.mapZoom,world=tileWorld(state.mapCenter.lat,state.mapCenter.lon,z),left=world.x-width/2,top=world.y-height/2,tileCount=2**z;
  surface.replaceChildren();
  const layer=document.createElement("div"); layer.className="map-tiles"; surface.append(layer);
  const minX=Math.floor(left/256),maxX=Math.floor((left+width)/256),minY=Math.floor(top/256),maxY=Math.floor((top+height)/256);
  for(let ty=minY;ty<=maxY;ty++)for(let tx=minX;tx<=maxX;tx++){
    if(ty<0||ty>=tileCount)continue;
    const img=document.createElement("img"); img.className="map-tile"; img.alt=""; img.draggable=false; img.referrerPolicy="strict-origin-when-cross-origin";
    img.src=(state.mapConfig?.tile_url||"https://tile.openstreetmap.org/{z}/{x}/{y}.png").replace("{z}",z).replace("{x}",((tx%tileCount)+tileCount)%tileCount).replace("{y}",ty);
    img.style.left=`${tx*256-left}px`;img.style.top=`${ty*256-top}px`;layer.append(img);
  }
  const markers=[];
  for(const store of data.stores||[])if(store.latitude!=null&&store.longitude!=null)markers.push({kind:"store",lat:Number(store.latitude),lon:Number(store.longitude),label:store.name,detail:`${number(store.available_kg,1)} kg available`});
  for(const recipient of data.recipients||[])if(recipient.latitude!=null&&recipient.longitude!=null)markers.push({kind:"recipient",lat:Number(recipient.latitude),lon:Number(recipient.longitude),label:recipient.name,detail:`${number(recipient.capacity_kg,0)} kg capacity`});
  for(const demand of data.demands||[])if(demand.latitude!=null&&demand.longitude!=null)markers.push({kind:"demand",lat:Number(demand.latitude),lon:Number(demand.longitude),label:`${demand.category} need`,detail:`${number(demand.quantity,1)} ${demand.unit} · ${demand.recipient}`});
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.classList.add("map-routes");svg.setAttribute("viewBox",`0 0 ${width} ${height}`);svg.setAttribute("aria-hidden","true");
  for(const store of markers.filter(m=>m.kind==="store"))for(const recipient of markers.filter(m=>m.kind==="recipient")){
    const a=tileWorld(store.lat,store.lon,z),b=tileWorld(recipient.lat,recipient.lon,z),x1=a.x-left,y1=a.y-top,x2=b.x-left,y2=b.y-top;
    if([x1,y1,x2,y2].every(v=>Number.isFinite(v))){const path=document.createElementNS(svg.namespaceURI,"path");path.setAttribute("d",`M${x1},${y1} L${x2},${y2}`);svg.append(path);}
  }
  surface.append(svg);
  for(const marker of markers){
    const p=tileWorld(marker.lat,marker.lon,z),x=p.x-left,y=p.y-top;if(x<-14||x>width+14||y<-14||y>height+14)continue;
    const button=document.createElement("button");button.type="button";button.className=`map-marker ${marker.kind}`;button.style.left=`${x}px`;button.style.top=`${y}px`;button.title=`${marker.label} · ${marker.detail}`;button.setAttribute("aria-label",button.title);button.innerHTML=marker.kind==="store"?"S":marker.kind==="recipient"?"R":"!";surface.append(button);
  }
  if(state.userLocation){const p=tileWorld(state.userLocation.lat,state.userLocation.lon,z),x=p.x-left,y=p.y-top;if(x>=0&&x<=width&&y>=0&&y<=height){const marker=document.createElement("i");marker.className="map-marker current";marker.style.left=`${x}px`;marker.style.top=`${y}px`;marker.title="Your location (shown on this device only)";surface.append(marker);}}
  const attribution=document.createElement("a");attribution.className="map-attribution";attribution.href="https://www.openstreetmap.org/copyright";attribution.target="_blank";attribution.rel="noreferrer";attribution.textContent=state.mapConfig?.attribution||"© OpenStreetMap contributors";surface.append(attribution);
  const status=$("#map-status");if(status)status.textContent=`${markers.length} network points · ${z}×`;
}

function locateUser() {
  if(!navigator.geolocation){toast("Location is not available in this browser","error");return;}
  const status=$("#map-status");if(status)status.textContent="Finding your location…";
  navigator.geolocation.getCurrentPosition(({coords})=>{state.userLocation={lat:coords.latitude,lon:coords.longitude};state.mapCenter={...state.userLocation};state.mapZoom=Math.max(state.mapZoom,13);drawMap();const node=$("#map-status");if(node)node.textContent="Your location · kept on this device";},error=>{if(status)status.textContent="Location unavailable";toast(error.code===1?"Allow location access to center the map.":"Could not get your location.","error");},{enableHighAccuracy:true,timeout:10000,maximumAge:60000});
}

async function pumpSimulation(runId,workers) {
  if(state.simulationPumpId===runId)return;
  state.simulationPumpId=runId;clearTimeout(state.simulationTimer);
  try {
    const result=await api(`/api/simulations/${runId}/tick?workers=${workers}`,"POST",{});
    state.simulation=result.simulation;
    if(state.view==="simulation"){$("#view-content").innerHTML=renderSimulation();applySearch($("#global-search").value);}
    if(state.simulation?.run?.status==="running"&&state.view==="simulation")state.simulationTimer=setTimeout(()=>{state.simulationPumpId=null;pumpSimulation(runId,workers);},450);
    else {state.simulationPumpId=null;await refreshData();await loadMapData();if(state.view==="simulation")toast(`Simulation ${state.simulation?.run?.status||"finished"}`);}
  } catch(error) {state.simulationPumpId=null;toast(`Simulation step failed: ${error.message}`,"error");}
}

async function runSimulation(form) {
  const values=Object.fromEntries(new FormData(form));
  state.simulationWorkers=Number(values.workers||4);
  try {
    const started=await api("/api/simulations","POST",{demand_kg:Number(values.demand_kg),sale_events:Number(values.sale_events),allocation_attempts:Number(values.allocation_attempts),recipient_id:Number(values.recipient_id)});
    await loadSimulation();
    pumpSimulation(started.run_id,state.simulationWorkers);
  } catch(error){toast(`Could not start simulation: ${error.message}`,"error");}
}

function renderView() {
  $("#page-heading").innerHTML = heading(state.view);
  const d = state.dashboard;
  if (!["activity", "model", "map", "simulation"].includes(state.view) && !d) return;
  const content = state.view === "overview" ? renderOverview(d)
    : state.view === "retail" ? renderRetail(d)
      : state.view === "demand" ? renderDemand(d)
        : state.view === "matching" ? renderMatches()
          : state.view === "logistics" ? renderLogistics(d)
            : state.view === "analytics" ? renderAnalytics(d)
              : state.view === "activity" ? renderActivity()
                : state.view === "map" ? renderMap()
                  : state.view === "simulation" ? renderSimulation() : renderSchema();
  $("#view-content").innerHTML = content;
  applySearch($("#global-search").value);
  if (state.view === "activity" && state.audit === null) loadAudit();
  if (state.view === "map" && !state.mapData) loadMapData();
  if (state.view === "simulation" && (!state.mapData || state.simulation===null)) { loadMapData(); loadSimulation(); }
  if (state.view === "map" && state.mapData) drawMap();
}

function renderNotifications() {
  const d = state.dashboard;
  if (!d) return;
  const expiring = (d.batches || []).filter(batch => daysUntil(batch.expiry_date) <= 3 && Number(batch.available) > 0);
  const proposed = (d.allocations || []).filter(allocation => allocation.status === "proposed");
  const notices = [
    ...expiring.map(batch => ({ urgent: daysUntil(batch.expiry_date) <= 1, text: `${batch.product} · lot ${batch.lot_code} expires ${daysUntil(batch.expiry_date) <= 0 ? "today" : formatDate(batch.expiry_date)}.` })),
    ...proposed.map(allocation => ({ urgent: false, text: `Allocation #${allocation.id} is awaiting approval for ${allocation.recipient}.` })),
  ].slice(0, 6);
  $("#notification-dot").hidden = notices.length === 0;
  $("#notification-popover").innerHTML = `<h3>Workspace notifications</h3>${notices.length ? notices.map(item => `<div class="notification-item"><i class="${item.urgent ? "is-urgent" : ""}"></i><span>${esc(item.text)}</span></div>`).join("") : `<div class="notification-empty">No current expiry or approval alerts.</div>`}`;
}

function applySearch(value) {
  const query = String(value || "").trim().toLowerCase();
  $$("#view-content [data-search]").forEach(element => {
    element.hidden = Boolean(query) && !(element.dataset.search || element.textContent).toLowerCase().includes(query);
  });
}

function productOptions(selected = "") {
  return (state.dashboard?.products || []).map(product => `<option value="${Number(product.id)}" ${String(product.id) === String(selected) ? "selected" : ""}>${esc(product.name)} · ${esc(product.sku)} (${esc(product.unit)})</option>`).join("");
}

function openModal(type) {
  const titles = {
    batch: ["Receive inventory", "Create a new product batch in the current store inventory."],
    sale: ["Record a sale", "Add a sales observation to the selected SKU."],
    import: ["Import sales data", "Upload a CSV or the AnnSetu Excel input workbook."],
    confirm: ["Confirm delivery", "This will mark the approved allocation delivered, release reserved stock, and update impact totals."],
  };
  const [title, description] = titles[type];
  let body = "";
  if (type === "batch") body = `<form id="record-form" data-form="batch"><div class="form-grid"><div class="form-field full"><label for="product-id">Product</label><select id="product-id" name="product_id" required>${productOptions()}</select></div><div class="form-field"><label for="lot-code">Batch / lot code</label><input id="lot-code" name="lot_code" required maxlength="80" placeholder="e.g. TOM-2403"></div><div class="form-field"><label for="batch-quantity">Quantity</label><input id="batch-quantity" name="quantity" type="number" step="0.1" min="0.1" required placeholder="0.0"></div><div class="form-field full"><label for="expiry-date">Expiry date</label><input id="expiry-date" name="expiry_date" type="date" min="${new Date().toISOString().slice(0, 10)}" required><span class="form-hint">Expired stock can’t be received.</span></div></div><div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Receive batch</button></div></form>`;
  else if (type === "sale") body = `<form id="record-form" data-form="sale"><div class="form-grid"><div class="form-field full"><label for="sale-product">Product</label><select id="sale-product" name="product_id" required>${productOptions()}</select></div><div class="form-field"><label for="sale-quantity">Quantity sold</label><input id="sale-quantity" name="quantity" type="number" step="0.1" min="0.1" required placeholder="0.0"></div><div class="form-field"><label for="sold-on">Sale date</label><input id="sold-on" name="sold_on" type="date" value="${new Date().toISOString().slice(0, 10)}" required></div></div><div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Save sale</button></div></form>`;
  else if (type === "import") body = `<div class="empty-state"><div><strong>Choose a sales file</strong>CSV requires columns <code>sku</code>, <code>sold_on</code>, and <code>quantity</code>. Excel imports use the Sales Import worksheet.<br><a class="text-link" href="/data/templates/sales.csv" download style="margin-top:10px">Download CSV template ${icon("arrow", 11)}</a></div></div><div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="button" data-action="choose-file">${icon("upload", 13)} Choose CSV / Excel</button></div>`;
  else body = `<div class="modal-note">Delivery confirmation is recorded in the database and updates inventory and impact totals.</div><div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="button" data-action="confirm-delivery" data-id="${Number(state.pendingDelivery)}">Confirm delivered</button></div>`;
  $("#modal-root").innerHTML = `<div class="modal-backdrop" role="presentation" data-action="backdrop-close"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><div><h2 id="modal-title">${esc(title)}</h2><p>${esc(description)}</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>${body}</section></div>`;
  const first = $(".modal input, .modal select");
  first?.focus();
}

function closeModal() {
  $("#modal-root").innerHTML = "";
}

async function submitForm(form) {
  const type = form.dataset.form;
  const data = Object.fromEntries(new FormData(form).entries());
  data.product_id = Number(data.product_id);
  data.quantity = Number(data.quantity);
  const button = $("button[type=submit]", form);
  button.disabled = true;
  try {
    if (type === "batch") {
      await api("/api/inventory/batches", "POST", data);
      toast("Inventory batch received.");
    } else {
      await api("/api/sales", "POST", data);
      toast("Sale recorded.");
    }
    closeModal();
    await refreshData();
  } catch (error) {
    button.disabled = false;
    toast(error.message, "error");
  }
}

async function importFile(file) {
  if (!file) return;
  try {
    let result;
    if (file.name.toLowerCase().endsWith(".xlsx")) {
      const form = new FormData();
      form.append("file", file);
      result = await api("/api/import/excel", "POST", form);
    } else {
      result = await api("/api/import/sales", "POST", { csv: await file.text() });
    }
    closeModal();
    toast(`${number(result.imported)} sales imported · ${number(result.duplicates_skipped)} duplicates skipped.`);
    await refreshData();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    $("#sales-file").value = "";
  }
}

async function findMatches() {
  const button = $("[data-action=find-matches]");
  if (button) button.disabled = true;
  try {
    const result = await api("/api/matches", "POST", {});
    state.matches = result.matches || [];
    renderView();
    toast(`${number(state.matches.length)} eligible suggestion${state.matches.length === 1 ? "" : "s"} returned.`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function createProposal(index) {
  const match = state.matches?.[index];
  if (!match) return;
  try {
    const result = await api("/api/allocations/propose", "POST", {
      demand_id: match.demand_id,
      batch_id: match.batch_id,
      quantity: match.quantity,
    });
    toast(`Proposal #${result.allocation_id} created and waiting for approval.`);
    await refreshData();
    setView("logistics");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function approveAllocation(id) {
  try {
    await api("/api/allocations/approve", "POST", { allocation_id: Number(id) });
    toast(`Allocation #${id} approved and stock reserved.`);
    await refreshData();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deliverAllocation(id) {
  state.pendingDelivery = Number(id);
  openModal("confirm");
}

async function confirmDelivery(id) {
  try {
    await api("/api/deliveries", "POST", { allocation_id: Number(id), status: "delivered" });
    closeModal();
    toast(`Allocation #${id} marked delivered.`);
    await refreshData();
  } catch (error) {
    closeModal();
    toast(error.message, "error");
  }
}

async function runForecast() {
  const button = $("[data-action=forecast]");
  if (button) button.disabled = true;
  try {
    const result = await api("/api/forecast", "POST", {});
    await refreshData();
    toast(`Forecast generated for ${number(result.forecasts?.length || 0)} SKU and horizon combinations.`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

document.addEventListener("click", async event => {
  const viewTarget = event.target.closest("[data-view]");
  if (viewTarget) {
    event.preventDefault();
    setView(viewTarget.dataset.view);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "backdrop-close" && event.target.closest(".modal")) return;
  if (action === "backdrop-close" || action === "close-modal") closeModal();
  else if (action === "refresh") refreshData();
  else if (action === "refresh-audit") loadAudit();
  else if (action === "receive-stock") openModal("batch");
  else if (action === "record-sale") openModal("sale");
  else if (action === "import-sales") openModal("import");
  else if (action === "choose-file") $("#sales-file").click();
  else if (action === "find-matches") findMatches();
  else if (action === "propose") createProposal(Number(button.dataset.index));
  else if (action === "approve") approveAllocation(button.dataset.id);
  else if (action === "deliver") deliverAllocation(button.dataset.id);
  else if (action === "confirm-delivery") confirmDelivery(button.dataset.id);
  else if (action === "forecast") runForecast();
  else if (action === "expiry-filter") {
    state.expiryFilter = button.dataset.filter;
    renderView();
  } else if (action === "map-locate") locateUser();
  else if (action === "map-zoom-in") { state.mapZoom=Math.min(18,state.mapZoom+1);drawMap(); }
  else if (action === "map-zoom-out") { state.mapZoom=Math.max(3,state.mapZoom-1);drawMap(); }
  else if (action === "simulation-refresh") { await loadMapData();await loadSimulation(); }
  else if (action === "simulation-stop") {
    try { await api(`/api/simulations/${button.dataset.id}/cancel`,"POST",{});clearTimeout(state.simulationTimer);state.simulationPumpId=null;await loadSimulation();toast("Simulation stopped"); }
    catch(error){toast(error.message,"error");}
  } else if (action === "simulation-clear") {
    if(!confirm("Clear this run and its synthetic records?"))return;
    try { await api(`/api/simulations/${button.dataset.id}`,"DELETE");state.simulation=null;await refreshData();await loadMapData();await loadSimulation();toast("Simulation data cleared"); }
    catch(error){toast(error.message,"error");}
  } else if (action === "schema-expand") $$(".schema-table-card").forEach(card => { card.open = true; });
  else if (action === "schema-collapse") $$(".schema-table-card").forEach(card => { card.open = false; });
  else if (action === "open-entity") {
    const card = $(`#schema-${CSS.escape(button.dataset.entity)}`);
    if (card) { card.open = true; card.scrollIntoView({ behavior: "smooth", block: "center" }); card.querySelector("summary").focus({ preventScroll: true }); }
  }
});

document.addEventListener("submit", event => {
  if(event.target.id==="simulation-form"){
    event.preventDefault();if(event.target.reportValidity())runSimulation(event.target);return;
  }
  if(event.target.id==="map-demand-form"){
    event.preventDefault();if(!event.target.reportValidity())return;
    const values=Object.fromEntries(new FormData(event.target));
    api("/api/map/simulated-demand","POST",{recipient_id:Number(values.recipient_id),category_id:Number(values.category_id),quantity:Number(values.quantity)})
      .then(()=>{toast("Synthetic need added to the map");loadMapData();refreshData();})
      .catch(error=>toast(`Could not add demand: ${error.message}`,"error"));return;
  }
  if (event.target.id === "record-form") {
    event.preventDefault();
    if (event.target.reportValidity()) submitForm(event.target);
  }
});

$("#sales-file").addEventListener("change", event => importFile(event.target.files?.[0]));
$("#global-search").addEventListener("input", event => applySearch(event.target.value));
$("#mobile-refresh").addEventListener("click", refreshData);
$("#dismiss-notice").addEventListener("click", () => $("#data-notice").remove());
$("#notifications-button").addEventListener("click", event => {
  const button = event.currentTarget;
  const popover = $("#notification-popover");
  popover.hidden = !popover.hidden;
  button.setAttribute("aria-expanded", String(!popover.hidden));
});
$("#menu-toggle").addEventListener("click", event => {
  const open = $("#sidebar").classList.toggle("is-open");
  event.currentTarget.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", event => {
  if (event.target.closest("#notifications-button") || event.target.closest("#notification-popover")) return;
  $("#notification-popover").hidden = true;
  $("#notifications-button").setAttribute("aria-expanded", "false");
  if (window.innerWidth <= 640 && !event.target.closest("#sidebar") && !event.target.closest("#menu-toggle")) {
    $("#sidebar").classList.remove("is-open");
    $("#menu-toggle").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    $("#global-search").focus();
  }
  if (event.key === "Escape") {
    closeModal();
    $("#notification-popover").hidden = true;
    $("#sidebar").classList.remove("is-open");
  }
});

let mapPointer=null;
document.addEventListener("pointerdown",event=>{
  const surface=event.target.closest(".network-map");
  if(!surface||event.target.closest(".map-marker"))return;
  mapPointer={id:event.pointerId,x:event.clientX,y:event.clientY,center:{...state.mapCenter},zoom:state.mapZoom};surface.setPointerCapture(event.pointerId);
});
document.addEventListener("pointermove",event=>{
  if(!mapPointer||mapPointer.id!==event.pointerId)return;
  const world=tileWorld(mapPointer.center.lat,mapPointer.center.lon,mapPointer.zoom),scale=256*2**mapPointer.zoom;
  state.mapCenter=worldGeo(world.x-(event.clientX-mapPointer.x),world.y-(event.clientY-mapPointer.y),mapPointer.zoom);drawMap();
});
document.addEventListener("pointerup",event=>{if(mapPointer?.id===event.pointerId)mapPointer=null;});
document.addEventListener("wheel",event=>{
  if(!event.target.closest(".network-map"))return;
  event.preventDefault();state.mapZoom=Math.max(3,Math.min(18,state.mapZoom+(event.deltaY<0?1:-1)));drawMap();
},{passive:false});
window.addEventListener("resize",()=>{if(state.view==="map")drawMap();});

document.addEventListener("DOMContentLoaded", () => {
  $$('[data-icon]').forEach(element => {
    element.innerHTML = icon(element.dataset.icon, 16);
  });
  const route = location.hash.slice(1);
  if (viewMeta[route]) setView(route, { updateHash: false });
  else renderView();
  refreshData();
});
