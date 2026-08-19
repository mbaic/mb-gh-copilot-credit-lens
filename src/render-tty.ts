// Pure terminal renderer for the dashboard. The webview's job, done in ANSI.
//
// renderDashboard() is a pure function: it takes the exact DashboardData that
// aggregate() already produces and returns a string. It performs no I/O and
// emits nothing itself — the caller writes the result to stdout or to the
// Copilot CLI's UI writer. That purity is what lets both front-ends (the
// standalone `ccl` binary and the `/credits` extension) share one renderer.
//
// Safety rule (the terminal analogue of the webview's textContent rule): every
// log-derived string is sanitised of control characters before printing, so a
// crafted session log can never inject escape sequences into the user's
// terminal. All styling is emitted by this module, never interpolated from data.

import { Bucket, DashboardData } from './aggregate';

export interface RenderOptions {
  /** Total render width in columns. */
  width: number;
  /** Emit ANSI colour codes. */
  color: boolean;
  /** Max rows in by-model / by-workspace lists; 0 = all. */
  top: number;
}

const RESET = '\x1b[0m';
const STYLE: Record<string, string> = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

/** Render the full dashboard for a period as a printable string. */
export function renderDashboard(data: DashboardData, opts: RenderOptions): string {
  const width = clampWidth(opts.width);
  const c = makeColorizer(opts.color);
  const rule = c('dim', '─'.repeat(width));
  const out: string[] = [];

  const periodLabel = data.periods.find((p) => p.id === data.period)?.label ?? data.period;
  const scanned = data.lastScanAt ? `scanned ${shortLocal(data.lastScanAt)}` : 'not scanned yet';
  out.push(
    fitRow(
      c('bold', `GitHub Copilot Credit Lens — ${periodLabel}`),
      c('dim', scanned),
      width,
      lenOf(`GitHub Copilot Credit Lens — ${periodLabel}`),
      lenOf(scanned)
    )
  );
  out.push(rule);

  // KPI strip.
  out.push(
    `${c('dim', ' Credits (period)')}  ${c('bold', fmtCredits(data.kpis.creditsPeriod))}` +
      `   ${c('dim', 'Today')} ${fmtCredits(data.kpis.creditsToday)}` +
      `   ${c('dim', 'Requests')} ${data.kpis.requests}` +
      `   ${c('dim', 'Top')} ${sanitize(data.kpis.topModel)}` +
      `   ${trustChip(data.trust, c)}`
  );
  out.push(rule);

  // Daily credits bars.
  out.push(c('bold', ' Daily credits'));
  if (data.daily.length === 0) {
    out.push(c('dim', '   (no usage in this period)'));
  } else {
    const maxDaily = Math.max(...data.daily.map((d) => d.credits), 0);
    const labelW = 5; // MM-DD
    const valueW = Math.max(...data.daily.map((d) => fmtCredits(d.credits).length), 5);
    const barW = Math.max(8, width - labelW - valueW - 6);
    for (const d of data.daily) {
      const label = d.date.slice(5); // MM-DD
      const value = fmtCredits(d.credits).padStart(valueW);
      out.push(`  ${label} ${c('dim', '▏')}${c('cyan', bar(d.credits, maxDaily, barW))} ${value}`);
    }
  }
  out.push(rule);

  // By model.
  out.push(`${c('bold', ' By model')}${c('dim', '                         credits (requests)')}`);
  out.push(...bucketLines(data.byModel, opts.top, width, c, data.unknownModels));
  out.push(rule);

  // By source (compact, one line if it fits).
  out.push(c('bold', ' By source'));
  for (const b of limit(data.bySource, opts.top)) {
    out.push(bucketLine(b, maxCredits(data.bySource), width, c, false));
  }
  out.push(rule);

  // By workspace (table).
  out.push(`${c('bold', ' By workspace')}${c('dim', '   (name · credits · requests · tokens)')}`);
  if (data.byWorkspace.length === 0) {
    out.push(c('dim', '   (none)'));
  } else {
    for (const b of limit(data.byWorkspace, opts.top)) {
      const name = sanitize(b.label);
      out.push(
        `  ${truncate(name, Math.max(12, width - 34)).padEnd(Math.max(12, width - 34))} ` +
          `${fmtCredits(b.credits).padStart(10)} ${String(b.requests).padStart(7)} ${humanInt(b.tokens).padStart(8)}`
      );
    }
  }
  out.push(rule);

  // Reconciling footer. Only show the "+ estimated = total" arithmetic when
  // estimates are actually included in the total; otherwise estimates are a
  // separate, clearly-excluded figure so the math always ties out honestly.
  const estReqWord = data.estimatedRequestCount === 1 ? 'request' : 'requests';
  const reconcile = data.includeEstimated
    ? `${c('dim', ' Exact')} ${fmtCredits(data.totals.exactCredits)} ${c('dim', '+ estimated')} ` +
      `${fmtCredits(data.totals.fallbackCredits)} ${c('dim', '=')} ${c('bold', fmtCredits(data.kpis.creditsPeriod))} ${c('dim', 'credits')}`
    : `${c('dim', ' Exact')} ${c('bold', fmtCredits(data.totals.exactCredits))} ${c('dim', 'credits')}` +
      (data.totals.fallbackCredits > 0
        ? c('dim', `   (+ ${fmtCredits(data.totals.fallbackCredits)} estimated, excluded)`)
        : '');
  const cost =
    data.usdPerCredit > 0
      ? `   ${c('dim', '·')}   ${c('dim', '≈')} $${(data.kpis.creditsPeriod * data.usdPerCredit).toFixed(2)} ${c('dim', `@ $${data.usdPerCredit}/credit`)}`
      : '';
  out.push(reconcile + cost);
  out.push(
    `${c('dim', ' ')}${data.kpis.requests} requests · ${humanInt(data.totals.inputTokens)} in · ` +
      `${humanInt(data.totals.outputTokens)} out · ${humanInt(data.totals.cachedTokens)} cached` +
      (data.estimatedRequestCount > 0 ? c('dim', `    (${data.estimatedRequestCount} estimated ${estReqWord})`) : '')
  );
  if (!data.includeEstimated && data.estimatedRequestCount > 0) {
    out.push(c('dim', ' Estimates are excluded from the total above. Use --estimated to include them.'));
  }
  if (data.unknownModels.length > 0) {
    out.push(c('yellow', ` ⚠ Unknown model(s): ${sanitize(data.unknownModels.join(', '))} (estimated with the default multiplier)`));
  }

  return out.join('\n') + '\n';
}

/** A list of bucket rows with a bar and `credits (requests)` label. */
function bucketLines(buckets: Bucket[], top: number, width: number, c: Colorizer, unknown: string[]): string[] {
  if (buckets.length === 0) {
    return [c('dim', '   (none)')];
  }
  const max = maxCredits(buckets);
  const unknownSet = new Set(unknown);
  return limit(buckets, top).map((b) => bucketLine(b, max, width, c, unknownSet.has(b.label)));
}

function bucketLine(b: Bucket, max: number, width: number, c: Colorizer, flagged: boolean): string {
  const label = sanitize(b.label);
  const nameW = Math.max(14, Math.floor(width * 0.28));
  const barW = Math.max(6, Math.floor(width * 0.32));
  const name = truncate(label, nameW).padEnd(nameW);
  const value = `${fmtCredits(b.credits)} (${b.requests})`;
  const warn = flagged ? c('yellow', '  ⚠ unknown') : '';
  return `  ${name} ${c('cyan', bar(b.credits, max, barW))} ${value}${warn}`;
}

// ---- helpers ----------------------------------------------------------------

type Colorizer = (style: keyof typeof STYLE, text: string) => string;

function makeColorizer(enabled: boolean): Colorizer {
  if (!enabled) {
    return (_style, text) => text;
  }
  return (style, text) => `${STYLE[style]}${text}${RESET}`;
}

function trustChip(trust: DashboardData['trust'], c: Colorizer): string {
  switch (trust) {
    case 'exact':
      return c('green', '● exact');
    case 'mixed':
      return c('yellow', '● mixed');
    case 'estimated':
      return c('red', '● estimated');
    default:
      return c('dim', '● no data');
  }
}

/** Eighth-block bar scaled to `max`, `width` cells wide. */
function bar(value: number, max: number, width: number): string {
  if (max <= 0 || value <= 0) {
    return '';
  }
  const blocks = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
  const units = (value / max) * width * 8;
  const full = Math.floor(units / 8);
  const rem = Math.round(units % 8);
  let s = '█'.repeat(Math.min(full, width));
  if (full < width && rem > 0) {
    s += blocks[rem - 1];
  }
  return s || '▏';
}

function maxCredits(buckets: Bucket[]): number {
  return buckets.reduce((m, b) => Math.max(m, b.credits), 0);
}

function limit<T>(items: T[], top: number): T[] {
  return top > 0 ? items.slice(0, top) : items;
}

function fmtCredits(value: number): string {
  return value.toFixed(4);
}

/** Compact integer: 1234567 -> "1.23M". */
function humanInt(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Strip C0/C1 control characters (incl. ESC) from log-derived text. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .trim() || '—';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Visible length, ignoring ANSI escape sequences. */
function lenOf(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Left + right text on one line padded to width (uses pre-measured lengths). */
function fitRow(left: string, right: string, width: number, leftLen: number, rightLen: number): string {
  const gap = Math.max(1, width - leftLen - rightLen);
  return ` ${left}${' '.repeat(gap)}${right}`;
}

function clampWidth(width: number): number {
  if (!width || width < 40) {
    return 80;
  }
  return Math.min(width, 200);
}

/** Local "YYYY-MM-DD HH:MM" from an ISO timestamp. */
function shortLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
