// The dashboard webview: an HTML shell plus a self-contained inline script that
// renders the data pushed from the extension. No external scripts, no CDN, no
// charting library — bars are hand-built SVG/CSS. All dynamic text is written
// with textContent (never innerHTML), so untrusted log-derived strings cannot
// inject markup. Theme surfaces use VS Code theme variables (light/dark aware);
// the brand accent is Business Central green.

import { DashboardData } from './aggregate';

/** Messages the webview sends back to the extension. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'changePeriod'; period: string }
  | { type: 'toggleEstimated'; include: boolean }
  | { type: 'sync' }
  | { type: 'reset' }
  | { type: 'export' };

export function buildDashboardHtml(nonce: string, cspSource: string, initialData: DashboardData): string {
  const dataJson = JSON.stringify(initialData).replace(/</g, '\\u003c');
  const csp = [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Copilot Credit Lens</title>
<style>${STYLES}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="dot"></span>
    <h1>GitHub Copilot Credit Lens</h1>
  </div>
  <div class="topbar-right">
    <span id="trust" class="chip">—</span>
    <span id="lastSync" class="muted"></span>
    <button id="syncBtn" class="btn">Sync now</button>
  </div>
</header>

<section class="controls">
  <label class="field">
    <span>Period</span>
    <select id="period"></select>
  </label>
  <label class="field check">
    <input type="checkbox" id="includeEstimated" />
    <span>Include estimated credits</span>
  </label>
  <div class="spacer"></div>
  <button id="resetBtn" class="btn ghost">Reset period</button>
  <button id="exportBtn" class="btn ghost">Export CSV</button>
</section>

<section class="kpis">
  <div class="kpi"><div class="kpi-label">Credits this period</div><div id="kpiPeriod" class="kpi-value">0</div></div>
  <div class="kpi"><div class="kpi-label">Credits today</div><div id="kpiToday" class="kpi-value">0</div></div>
  <div class="kpi"><div class="kpi-label">Requests</div><div id="kpiRequests" class="kpi-value">0</div></div>
  <div class="kpi"><div class="kpi-label">Top model</div><div id="kpiModel" class="kpi-value small">—</div></div>
</section>

<section class="card">
  <h2>Credits per day</h2>
  <div id="daily" class="chart"></div>
</section>

<div class="grid-2">
  <section class="card"><h2>By model</h2><div id="byModel" class="bars"></div></section>
  <section class="card"><h2>By source</h2><div id="bySource" class="bars"></div></section>
</div>

<section class="card">
  <h2>By workspace</h2>
  <table class="table">
    <thead><tr><th>Workspace</th><th class="num">Credits</th><th class="num">Requests</th><th class="num">Tokens</th></tr></thead>
    <tbody id="byWorkspace"></tbody>
  </table>
</section>

<section class="card">
  <h2>Token totals (period)</h2>
  <div class="totals">
    <div><span class="muted">Input</span><b id="tIn">0</b></div>
    <div><span class="muted">Output</span><b id="tOut">0</b></div>
    <div><span class="muted">Cached</span><b id="tCached">0</b></div>
    <div><span class="muted">Exact credits</span><b id="tExact">0</b></div>
    <div><span class="muted">Estimated credits</span><b id="tEst">0</b></div>
  </div>
  <p id="estNote" class="muted note"></p>
  <p id="modelNote" class="muted note"></p>
</section>

<footer class="foot muted">Local-first · No API · No telemetry · Fully offline</footer>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let data = ${dataJson};
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
}

const STYLES = `
:root {
  --accent: #107C41;
  --accent-2: #1a9652;
  --bg: var(--vscode-editor-background);
  --fg: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground, #8a8a8a);
  --surface: var(--vscode-editorWidget-background, rgba(127,127,127,0.06));
  --border: var(--vscode-panel-border, rgba(127,127,127,0.25));
  --chart: ['#107C41'];
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 16px 20px 28px;
  font-family: var(--vscode-font-family, "Segoe UI", system-ui, sans-serif);
  font-size: 13px; color: var(--fg); background: var(--bg);
}
h1 { font-size: 16px; margin: 0; font-weight: 600; }
h2 { font-size: 12px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.muted { color: var(--muted); }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.brand { display: flex; align-items: center; gap: 10px; }
.dot { width: 12px; height: 12px; border-radius: 3px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
.topbar-right { display: flex; align-items: center; gap: 12px; }
.chip { font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); }
.chip.exact { background: rgba(16,124,65,.15); border-color: var(--accent); color: var(--accent-2); }
.chip.mixed { background: rgba(196,154,16,.15); border-color: #c49a10; }
.chip.estimated { background: rgba(196,109,16,.15); border-color: #c46d10; }
.btn { font: inherit; cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: #fff; padding: 5px 12px; border-radius: 5px; }
.btn:hover { background: var(--accent-2); }
.btn.ghost { background: transparent; color: var(--fg); border-color: var(--border); }
.btn.ghost:hover { border-color: var(--accent); color: var(--accent-2); }
.controls { display: flex; align-items: flex-end; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--muted); }
.field.check { flex-direction: row; align-items: center; gap: 6px; color: var(--fg); font-size: 13px; }
select { font: inherit; padding: 4px 8px; border-radius: 5px; background: var(--surface); color: var(--fg); border: 1px solid var(--border); }
.spacer { flex: 1; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.kpi-label { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
.kpi-value { font-size: 24px; font-weight: 600; }
.kpi-value.small { font-size: 15px; word-break: break-word; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.chart { width: 100%; }
.chart svg { width: 100%; height: 180px; display: block; }
.bars { display: flex; flex-direction: column; gap: 8px; }
.bar-row { display: grid; grid-template-columns: 120px 1fr auto; align-items: center; gap: 10px; font-size: 12px; }
.bar-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-track { background: rgba(127,127,127,.18); border-radius: 4px; height: 14px; overflow: hidden; }
.bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); border-radius: 4px; }
.bar-value { font-variant-numeric: tabular-nums; color: var(--muted); }
.table { width: 100%; border-collapse: collapse; font-size: 12px; }
.table th, .table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.table th.num, .table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.totals { display: flex; gap: 22px; flex-wrap: wrap; }
.totals div { display: flex; flex-direction: column; gap: 2px; }
.totals b { font-size: 16px; font-variant-numeric: tabular-nums; }
.note { margin: 12px 0 0; font-size: 11px; }
.empty { color: var(--muted); font-style: italic; padding: 8px 0; }
.foot { text-align: center; font-size: 11px; margin-top: 18px; }
@media (max-width: 720px) { .kpis { grid-template-columns: repeat(2,1fr); } .grid-2 { grid-template-columns: 1fr; } }
`;

const CLIENT_SCRIPT = `
const SVG_NS = 'http://www.w3.org/2000/svg';
const fmt = (n) => (Math.round(n * 10000) / 10000).toLocaleString();
const fmtInt = (n) => Math.round(n).toLocaleString();

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function post(msg) { vscode.postMessage(msg); }

function renderPeriods() {
  const sel = document.getElementById('period');
  clear(sel);
  for (const p of data.periods) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.label;
    if (p.id === data.period) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderBars(containerId, buckets) {
  const el = document.getElementById(containerId);
  clear(el);
  if (!buckets.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No data'; el.appendChild(e); return; }
  const max = Math.max(...buckets.map((b) => b.credits), 0.0001);
  for (const b of buckets.slice(0, 12)) {
    const row = document.createElement('div'); row.className = 'bar-row';
    const label = document.createElement('span'); label.className = 'bar-label'; label.textContent = b.label; label.title = b.label;
    const track = document.createElement('div'); track.className = 'bar-track';
    const fill = document.createElement('div'); fill.className = 'bar-fill';
    fill.style.width = Math.max(2, (b.credits / max) * 100) + '%';
    track.appendChild(fill);
    const val = document.createElement('span'); val.className = 'bar-value'; val.textContent = fmt(b.credits) + ' (' + b.requests + ')';
    row.appendChild(label); row.appendChild(track); row.appendChild(val);
    el.appendChild(row);
  }
}

function renderDaily(daily) {
  const el = document.getElementById('daily');
  clear(el);
  if (!daily.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No activity in this period'; el.appendChild(e); return; }
  const W = 100, H = 100, pad = 2;
  const max = Math.max(...daily.map((d) => d.credits), 0.0001);
  const n = daily.length;
  const bw = (W - pad * 2) / n;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'none');
  daily.forEach((d, i) => {
    const h = (d.credits / max) * (H - pad * 2);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', (pad + i * bw + bw * 0.12).toFixed(2));
    rect.setAttribute('y', (H - pad - h).toFixed(2));
    rect.setAttribute('width', (bw * 0.76).toFixed(2));
    rect.setAttribute('height', Math.max(0.4, h).toFixed(2));
    rect.setAttribute('fill', '#107C41');
    rect.setAttribute('rx', '0.6');
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = d.date + ': ' + fmt(d.credits);
    rect.appendChild(title);
    svg.appendChild(rect);
  });
  el.appendChild(svg);
}

function renderWorkspace(buckets) {
  const body = document.getElementById('byWorkspace');
  clear(body);
  if (!buckets.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 4; td.className = 'empty'; td.textContent = 'No data'; tr.appendChild(td); body.appendChild(tr); return;
  }
  for (const b of buckets) {
    const tr = document.createElement('tr');
    const cells = [b.label, fmt(b.credits), fmtInt(b.requests), fmtInt(b.tokens)];
    cells.forEach((text, idx) => {
      const td = document.createElement('td');
      if (idx > 0) td.className = 'num';
      td.textContent = text; tr.appendChild(td);
    });
    body.appendChild(tr);
  }
}

function render() {
  renderPeriods();
  document.getElementById('includeEstimated').checked = !!data.includeEstimated;

  const trust = document.getElementById('trust');
  trust.className = 'chip ' + data.trust;
  trust.textContent = { exact: 'Exact', mixed: 'Mixed', estimated: 'Estimated', none: 'No data' }[data.trust] || '—';

  document.getElementById('lastSync').textContent = data.lastScanAt ? 'Synced ' + new Date(data.lastScanAt).toLocaleString() : 'Not synced yet';
  document.getElementById('kpiPeriod').textContent = fmt(data.kpis.creditsPeriod);
  document.getElementById('kpiToday').textContent = fmt(data.kpis.creditsToday);
  document.getElementById('kpiRequests').textContent = fmtInt(data.kpis.requests);
  document.getElementById('kpiModel').textContent = data.kpis.topModel;

  renderDaily(data.daily);
  renderBars('byModel', data.byModel);
  renderBars('bySource', data.bySource);
  renderWorkspace(data.byWorkspace);

  document.getElementById('tIn').textContent = fmtInt(data.totals.inputTokens);
  document.getElementById('tOut').textContent = fmtInt(data.totals.outputTokens);
  document.getElementById('tCached').textContent = fmtInt(data.totals.cachedTokens);
  document.getElementById('tExact').textContent = fmt(data.totals.exactCredits);
  document.getElementById('tEst').textContent = fmt(data.totals.estimatedCredits);
  document.getElementById('estNote').textContent = data.estimatedRequestCount > 0
    ? data.estimatedRequestCount + ' request(s) had no exact billing value; their credits are estimated from the model rate table' + (data.includeEstimated ? ' and are included in totals above.' : ' and are excluded from the totals above.')
    : 'All requests in this period carried an exact billing value.';

  const unknown = data.unknownModels || [];
  document.getElementById('modelNote').textContent = unknown.length
    ? 'New/unknown model(s) detected (exact credits unaffected; estimates use the default 1× multiplier): ' + unknown.join(', ')
    : '';
}

document.getElementById('period').addEventListener('change', (e) => post({ type: 'changePeriod', period: e.target.value }));
document.getElementById('includeEstimated').addEventListener('change', (e) => post({ type: 'toggleEstimated', include: e.target.checked }));
document.getElementById('syncBtn').addEventListener('click', () => post({ type: 'sync' }));
document.getElementById('resetBtn').addEventListener('click', () => post({ type: 'reset' }));
document.getElementById('exportBtn').addEventListener('click', () => post({ type: 'export' }));

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'updateData') { data = msg.payload; render(); }
  else if (msg.type === 'syncStatus') {
    const btn = document.getElementById('syncBtn');
    btn.textContent = msg.running ? 'Syncing…' : 'Sync now';
    btn.disabled = !!msg.running;
  }
});

render();
post({ type: 'ready' });
`;
