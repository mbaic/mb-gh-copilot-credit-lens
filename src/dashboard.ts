// The dashboard webview: an HTML shell plus a self-contained inline script that
// renders the data pushed from the extension. No external scripts, no CDN, no
// charting library — bars are hand-built HTML/CSS. All dynamic text is written
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
<div id="tip" class="tip"></div>

<header class="topbar">
  <div class="brand">
    <span class="dot"></span>
    <h1>GitHub Copilot Credit Lens</h1>
  </div>
  <div class="topbar-right">
    <span id="trust" class="chip" title="Data trust: Exact = every request had an exact billing value; Mixed = some were estimated; Estimated = all estimated.">—</span>
    <span id="lastSync" class="muted"></span>
    <button id="syncBtn" class="btn" title="Re-scan your local Copilot logs for new usage and refresh the data.">Sync now</button>
  </div>
</header>

<section class="controls">
  <label class="field" title="Choose the reporting period the whole dashboard is filtered to.">
    <span>Period</span>
    <select id="period"></select>
  </label>
  <label class="field check" title="When on, requests that had no exact billing value contribute an estimated credit (from the model rate table) to the totals. When off, only exact credits are counted.">
    <input type="checkbox" id="includeEstimated" />
    <span>Include estimated credits</span>
  </label>
  <div class="spacer"></div>
  <button id="resetBtn" class="btn ghost" title="Add a reset marker at 'now'. Pick the 'Since last reset' period to view from here. Does not delete any data.">Reset period</button>
  <button id="exportBtn" class="btn ghost" title="Export the selected period's entries to a CSV file.">Export CSV</button>
</section>

<section class="kpis">
  <div class="kpi" title="Total credits (AIU) attributed to the selected period. Includes estimates only when 'Include estimated credits' is on.">
    <div class="kpi-label">Credits this period</div><div id="kpiPeriod" class="kpi-value">0</div></div>
  <div class="kpi" title="Credits used so far today (your local date).">
    <div class="kpi-label">Credits today</div><div id="kpiToday" class="kpi-value">0</div></div>
  <div class="kpi" title="Number of model requests counted in the selected period.">
    <div class="kpi-label">Requests</div><div id="kpiRequests" class="kpi-value">0</div></div>
  <div class="kpi" title="The model with the most credits in the selected period.">
    <div class="kpi-label">Top model</div><div id="kpiModel" class="kpi-value small">—</div></div>
</section>

<section class="card">
  <div class="card-head">
    <h2 title="Credits per calendar day in the selected period. Bar height = credits that day.">Credits per day</h2>
    <span class="legend">hover a bar for date &amp; exact credits</span>
  </div>
  <div id="daily" class="chart"></div>
</section>

<div class="grid-2">
  <section class="card">
    <div class="card-head">
      <h2 title="Credits and request count per model. Bar length is proportional to credits.">By model</h2>
      <span class="legend">credits (requests)</span>
      <div class="spacer"></div>
      <select id="modelLimit" class="mini" title="How many models to list (by credits).">
        <option value="5">Top 5</option><option value="10">Top 10</option><option value="0">All</option>
      </select>
    </div>
    <div id="byModel" class="bars"></div>
  </section>
  <section class="card">
    <div class="card-head">
      <h2 title="Where usage came from: Agent (debug logs) = VS Code agent/chat sessions with file logging; Chat sessions; Copilot CLI.">By source</h2>
      <span class="legend">credits (requests)</span>
    </div>
    <div id="bySource" class="bars"></div>
  </section>
</div>

<section class="card">
  <div class="card-head">
    <h2 title="Credits, requests and tokens per VS Code workspace/project. Use 'Rebuild Workspace Names' if any show as a hash.">By workspace</h2>
    <div class="spacer"></div>
    <select id="wsLimit" class="mini" title="How many workspaces to list (by credits).">
      <option value="5">Top 5</option><option value="10">Top 10</option><option value="0">All</option>
    </select>
  </div>
  <table class="table">
    <thead><tr><th>Workspace</th><th class="num">Credits</th><th class="num">Requests</th><th class="num">Tokens</th></tr></thead>
    <tbody id="byWorkspace"></tbody>
  </table>
</section>

<section class="card">
  <h2 title="Token and credit totals for the selected period.">Token totals (period)</h2>
  <div class="totals">
    <div title="Sum of input (prompt) tokens."><span class="muted">Input tokens</span><b id="tIn">0</b></div>
    <div title="Sum of output (completion) tokens."><span class="muted">Output tokens</span><b id="tOut">0</b></div>
    <div title="Sum of cached tokens (read from cache)."><span class="muted">Cached tokens</span><b id="tCached">0</b></div>
    <div title="Credits billed exactly (from copilotUsageNanoAiu)."><span class="muted">Exact credits</span><b id="tExact">0</b></div>
    <div title="Estimated credits for the requests that had NO exact value."><span class="muted">+ Estimated (no exact)</span><b id="tEst">0</b></div>
    <div title="Exact + estimated. Equals 'Credits this period' when 'Include estimated credits' is on."><span class="muted">= Total w/ estimates</span><b id="tCombined">0</b></div>
  </div>
  <p id="estNote" class="muted note"></p>
  <p id="modelNote" class="muted note"></p>
</section>

<footer class="foot muted">Local-first · No API · No telemetry · Fully offline</footer>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let data = ${dataJson};
let modelLimit = 5;
let wsLimit = 5;
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
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 16px 20px 28px;
  font-family: var(--vscode-font-family, "Segoe UI", system-ui, sans-serif);
  font-size: 13px; color: var(--fg); background: var(--bg);
}
h1 { font-size: 16px; margin: 0; font-weight: 600; }
h2 { font-size: 12px; margin: 0; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.muted { color: var(--muted); }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.brand { display: flex; align-items: center; gap: 10px; }
.dot { width: 12px; height: 12px; border-radius: 3px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
.topbar-right { display: flex; align-items: center; gap: 12px; }
.chip { font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); cursor: help; }
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
select.mini { padding: 2px 6px; font-size: 11px; }
.spacer { flex: 1; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; cursor: help; }
.kpi-label { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
.kpi-value { font-size: 24px; font-weight: 600; }
.kpi-value.small { font-size: 15px; word-break: break-word; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
.card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.card-head h2 { cursor: help; }
.legend { font-size: 10px; color: var(--muted); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.chart { width: 100%; }
.daychart { display: flex; align-items: flex-end; gap: 3px; height: 168px; }
.day { flex: 1 1 0; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; cursor: default; }
.day .dayval { font-size: 9px; color: var(--muted); margin-bottom: 3px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.daybar { width: 78%; min-height: 2px; background: linear-gradient(180deg, var(--accent-2), var(--accent)); border-radius: 3px 3px 0 0; transition: filter .1s; }
.day:hover .daybar { filter: brightness(1.3); }
.dayaxis { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); margin-top: 6px; }
.bars { display: flex; flex-direction: column; gap: 8px; }
.bar-row { display: grid; grid-template-columns: 130px 1fr auto; align-items: center; gap: 10px; font-size: 12px; cursor: default; }
.bar-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-track { background: rgba(127,127,127,.18); border-radius: 4px; height: 14px; overflow: hidden; }
.bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); border-radius: 4px; }
.bar-value { font-variant-numeric: tabular-nums; color: var(--muted); }
.table { width: 100%; border-collapse: collapse; font-size: 12px; }
.table th, .table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.table th.num, .table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.table th { color: var(--muted); font-weight: 600; }
.totals { display: flex; gap: 22px; flex-wrap: wrap; }
.totals div { display: flex; flex-direction: column; gap: 2px; cursor: help; }
.totals b { font-size: 16px; font-variant-numeric: tabular-nums; }
.note { margin: 12px 0 0; font-size: 11px; }
.empty { color: var(--muted); font-style: italic; padding: 8px 0; }
.foot { text-align: center; font-size: 11px; margin-top: 18px; }
.tip { position: fixed; pointer-events: none; display: none; z-index: 50; max-width: 280px;
  background: var(--vscode-editorHoverWidget-background, #252526);
  color: var(--vscode-editorHoverWidget-foreground, var(--fg));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--border));
  border-radius: 5px; padding: 5px 8px; font-size: 11px; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
@media (max-width: 720px) { .kpis { grid-template-columns: repeat(2,1fr); } .grid-2 { grid-template-columns: 1fr; } }
`;

const CLIENT_SCRIPT = `
const fmt = (n) => (Math.round(n * 10000) / 10000).toLocaleString();
const fmtInt = (n) => Math.round(n).toLocaleString();
function fmtShort(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : (Math.round(n * 100) / 100).toLocaleString(); }
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function post(msg) { vscode.postMessage(msg); }
function shortWs(s) { return /^[0-9a-f]{16,}$/i.test(s) ? s.slice(0, 8) + '…' : s; }

const tipEl = () => document.getElementById('tip');
function showTip(e, text) { const t = tipEl(); t.textContent = text; t.style.display = 'block'; t.style.left = (e.clientX + 12) + 'px'; t.style.top = (e.clientY + 14) + 'px'; }
function hideTip() { tipEl().style.display = 'none'; }

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

function renderBars(containerId, buckets, limit) {
  const el = document.getElementById(containerId);
  clear(el);
  if (!buckets.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No data'; el.appendChild(e); return; }
  const shown = limit > 0 ? buckets.slice(0, limit) : buckets;
  const max = Math.max(...shown.map((b) => b.credits), 0.0001);
  for (const b of shown) {
    const row = document.createElement('div'); row.className = 'bar-row';
    row.title = b.label + ' — ' + fmt(b.credits) + ' credits, ' + fmtInt(b.requests) + ' requests, ' + fmtInt(b.tokens) + ' tokens';
    const label = document.createElement('span'); label.className = 'bar-label'; label.textContent = b.label;
    const track = document.createElement('div'); track.className = 'bar-track';
    const fill = document.createElement('div'); fill.className = 'bar-fill';
    fill.style.width = Math.max(2, (b.credits / max) * 100) + '%';
    track.appendChild(fill);
    const val = document.createElement('span'); val.className = 'bar-value'; val.textContent = fmt(b.credits) + ' (' + fmtInt(b.requests) + ')';
    row.appendChild(label); row.appendChild(track); row.appendChild(val);
    el.appendChild(row);
  }
  if (limit > 0 && buckets.length > limit) {
    const more = document.createElement('div'); more.className = 'empty';
    more.textContent = '+' + (buckets.length - limit) + ' more (choose “All”)';
    el.appendChild(more);
  }
}

function renderDaily(daily) {
  const el = document.getElementById('daily');
  clear(el);
  if (!daily.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No activity in this period'; el.appendChild(e); return; }
  const max = Math.max(...daily.map((d) => d.credits), 0.0001);
  const showVals = daily.length <= 16;
  const chart = document.createElement('div'); chart.className = 'daychart';
  for (const d of daily) {
    const col = document.createElement('div'); col.className = 'day';
    if (showVals && d.credits > 0) {
      const v = document.createElement('div'); v.className = 'dayval'; v.textContent = fmtShort(d.credits); col.appendChild(v);
    }
    const bar = document.createElement('div'); bar.className = 'daybar';
    bar.style.height = Math.max(2, (d.credits / max) * 100) + '%';
    col.appendChild(bar);
    const label = d.date + ' — ' + fmt(d.credits) + ' credits';
    col.addEventListener('mousemove', (e) => showTip(e, label));
    col.addEventListener('mouseleave', hideTip);
    chart.appendChild(col);
  }
  el.appendChild(chart);
  const axis = document.createElement('div'); axis.className = 'dayaxis';
  const a = document.createElement('span'); a.textContent = daily[0].date;
  const b = document.createElement('span'); b.textContent = daily[daily.length - 1].date;
  axis.appendChild(a); axis.appendChild(b);
  el.appendChild(axis);
}

function renderWorkspace(buckets, limit) {
  const body = document.getElementById('byWorkspace');
  clear(body);
  if (!buckets.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 4; td.className = 'empty'; td.textContent = 'No data'; tr.appendChild(td); body.appendChild(tr); return;
  }
  const shown = limit > 0 ? buckets.slice(0, limit) : buckets;
  for (const b of shown) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = shortWs(b.label);
    if (shortWs(b.label) !== b.label) { name.title = 'Unnamed workspace (no metadata on disk): ' + b.label; }
    tr.appendChild(name);
    [fmt(b.credits), fmtInt(b.requests), fmtInt(b.tokens)].forEach((text) => {
      const td = document.createElement('td'); td.className = 'num'; td.textContent = text; tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  if (limit > 0 && buckets.length > limit) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 4; td.className = 'empty'; td.textContent = '+' + (buckets.length - limit) + ' more (choose “All”)';
    tr.appendChild(td); body.appendChild(tr);
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
  renderBars('byModel', data.byModel, modelLimit);
  renderBars('bySource', data.bySource, 0);
  renderWorkspace(data.byWorkspace, wsLimit);

  const t = data.totals;
  const combined = Math.round((t.exactCredits + t.fallbackCredits) * 10000) / 10000;
  document.getElementById('tIn').textContent = fmtInt(t.inputTokens);
  document.getElementById('tOut').textContent = fmtInt(t.outputTokens);
  document.getElementById('tCached').textContent = fmtInt(t.cachedTokens);
  document.getElementById('tExact').textContent = fmt(t.exactCredits);
  document.getElementById('tEst').textContent = fmt(t.fallbackCredits);
  document.getElementById('tCombined').textContent = fmt(combined);

  document.getElementById('estNote').textContent = data.estimatedRequestCount > 0
    ? data.estimatedRequestCount + ' request(s) had no exact billing value — their credits are estimated. Exact (' + fmt(t.exactCredits) + ') + estimated (' + fmt(t.fallbackCredits) + ') = ' + fmt(combined) + ', which is “Credits this period” when “Include estimated credits” is on (currently ' + (data.includeEstimated ? 'on' : 'off — period shows exact only') + ').'
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
document.getElementById('modelLimit').addEventListener('change', (e) => { modelLimit = parseInt(e.target.value, 10); renderBars('byModel', data.byModel, modelLimit); });
document.getElementById('wsLimit').addEventListener('change', (e) => { wsLimit = parseInt(e.target.value, 10); renderWorkspace(data.byWorkspace, wsLimit); });

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
