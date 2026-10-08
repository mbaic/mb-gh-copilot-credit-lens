// Pure aggregation: turn ledger entries + a selected period into the shape the
// dashboard renders. No VS Code, no I/O — easy to reason about and to test.

import { PeriodId, ResetMarker, UsageEntry } from './types';
import { isKnownModel } from './rates';

export interface Bucket {
  label: string;
  credits: number;
  requests: number;
  tokens: number;
}

export interface DashboardData {
  generatedAt: string;
  period: PeriodId;
  includeEstimated: boolean;
  lastScanAt: string | null;
  trust: 'exact' | 'mixed' | 'estimated' | 'none';
  kpis: {
    creditsPeriod: number;
    /** creditsPeriod × (1 + otherUsageBufferPercent/100): the user-calibrated
     *  "likely account total". Equals creditsPeriod when the buffer is 0. */
    assumedAccountTotal: number;
    creditsToday: number;
    requests: number;
    topModel: string;
  };
  daily: { date: string; credits: number }[];
  byModel: Bucket[];
  bySource: Bucket[];
  byWorkspace: Bucket[];
  totals: {
    exactCredits: number;
    /** Estimated credits for the requests that had NO exact value. Adds to
     *  exactCredits to reconcile with creditsPeriod when estimates are included. */
    fallbackCredits: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };
  estimatedRequestCount: number;
  /** Models seen in this period that aren't in the rate table (estimates use the
   *  default multiplier). Surfaced so new GitHub models are noticed automatically. */
  unknownModels: string[];
  /** USD per AI Credit (GitHub usage-based billing: 1 credit = $0.01). Configurable. */
  usdPerCredit: number;
  /** Experimental: percent the headline is scaled by to cover usage local files
   *  can't see. Display-only; never applied to breakdowns, tokens or exports. */
  otherUsageBufferPercent: number;
  periods: { id: PeriodId; label: string }[];
}

export const PERIODS: { id: PeriodId; label: string }[] = [
  { id: 'currentMonth', label: 'Current period' },
  { id: 'last3Months', label: 'Last 3 months' },
  { id: 'last6Months', label: 'Last 6 months' },
  { id: 'last9Months', label: 'Last 9 months' },
  { id: 'last12Months', label: 'Last 12 months' },
  { id: 'sinceReset', label: 'Since last reset' },
  { id: 'allTime', label: 'All time' }
];

const SOURCE_LABELS: Record<string, string> = {
  chat: 'Chat sessions',
  debug: 'Agent (debug logs)',
  cli: 'Copilot CLI'
};

/** The period's own lower bound before applying the billing-start floor. */
function naturalStart(period: PeriodId, markers: readonly ResetMarker[], now: Date): number | null {
  switch (period) {
    case 'currentMonth':
      // GitHub resets Copilot allowances at 00:00:00 UTC on the 1st, so the
      // boundary must be computed in UTC — not the local calendar month.
      return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    case 'last3Months':
      return now.getTime() - 90 * DAY_MS;
    case 'last6Months':
      return now.getTime() - 180 * DAY_MS;
    case 'last9Months':
      return now.getTime() - 270 * DAY_MS;
    case 'last12Months':
      return now.getTime() - 365 * DAY_MS;
    case 'sinceReset': {
      const latest = latestMarker(markers);
      return latest ? new Date(latest.timestamp).getTime() : null;
    }
    case 'allTime':
    default:
      return null;
  }
}

/**
 * Inclusive lower bound (epoch ms) for a period, clamped so nothing earlier than
 * the billing start date is ever counted. "All time" therefore means "since the
 * billing start"; rolling windows never reach before it either.
 */
export function periodStart(
  period: PeriodId,
  markers: readonly ResetMarker[],
  now: Date,
  billingStartMs: number | null = null
): number | null {
  const natural = naturalStart(period, markers, now);
  if (billingStartMs === null) {
    return natural;
  }
  return natural === null ? billingStartMs : Math.max(natural, billingStartMs);
}

/** Per-source figures behind resolveOverlaps(), for the Output-channel
 *  breakdown that explains where the headline total comes from. */
export interface OverlapStats {
  raw: Record<string, { credits: number; requests: number }>;
  /** Chat turns whose window also has debug-log calls. */
  coveredTurns: number;
  coveredChatCredits: number;
  coveredDebugCredits: number;
  /** Credits added where a turn's chat total exceeded its debug-log calls. */
  topUpCredits: number;
  /** Chat turns with no debug-log calls (kept as-is). */
  chatOnlyTurns: number;
  chatOnlyCredits: number;
  /** CLI session totals dropped because the session also has debug-log rows. */
  droppedCliCredits: number;
}

/**
 * Collapse usage that more than one local source recorded, so nothing is
 * counted twice. The ledger keeps every source's rows; this runs on read.
 *
 * - Debug-log rows (one per model call) always stay: they are the most granular.
 * - Chat turns are matched to their session's debug log (the debug-log folder
 *   is named after the chat session id) by time window: a turn runs from its
 *   start to the next turn's start. Where the window has debug-log calls, the
 *   chat turn is replaced by them — and if the turn's own billed total is
 *   higher (the debug log missed calls), the difference is kept as a
 *   request-less top-up so the window counts the larger of two exact figures.
 *   Turns the debug log never saw (logging off, or pruned by Copilot's
 *   50-session retention) are kept whole.
 * - A CLI session total is dropped when the same session also has debug-log
 *   rows (Copilot CLI sessions run from inside VS Code write both).
 */
export function resolveOverlaps(entries: readonly UsageEntry[], stats?: OverlapStats): UsageEntry[] {
  const debugCalls = new Map<string, { t: number; credits: number }[]>();
  for (const e of entries) {
    if (stats) {
      const r = (stats.raw[e.source] ??= { credits: 0, requests: 0 });
      r.credits += e.creditsExact ?? 0;
      r.requests += e.requests ?? 1;
    }
    if (e.source === 'debug') {
      const list = debugCalls.get(e.sessionId) ?? [];
      list.push({ t: Date.parse(e.timestamp), credits: e.creditsExact ?? 0 });
      debugCalls.set(e.sessionId, list);
    }
  }

  // Chat rows grouped into turn windows: session -> turn start -> rows. A
  // session-level remainder row shares its last turn's start.
  const turns = new Map<string, Map<number, UsageEntry[]>>();
  for (const e of entries) {
    if (e.source === 'chat') {
      const bySession = turns.get(e.sessionId) ?? new Map<number, UsageEntry[]>();
      const start = Date.parse(e.timestamp);
      bySession.set(start, [...(bySession.get(start) ?? []), e]);
      turns.set(e.sessionId, bySession);
    }
  }

  const out: UsageEntry[] = [];
  for (const e of entries) {
    if (e.source === 'debug') {
      out.push(e);
    } else if (e.source === 'cli') {
      if (debugCalls.has(e.sessionId)) {
        if (stats) {
          stats.droppedCliCredits += e.creditsExact ?? 0;
        }
      } else {
        out.push(e);
      }
    } else if (e.source !== 'chat') {
      out.push(e);
    }
  }

  turns.forEach((bySession, sessionId) => {
    const starts = [...bySession.keys()].sort((a, b) => a - b);
    const calls = debugCalls.get(sessionId) ?? [];
    starts.forEach((start, i) => {
      const rows = bySession.get(start) ?? [];
      const chatCredits = rows.reduce((sum, r) => sum + (r.creditsExact ?? 0), 0);
      const end = i + 1 < starts.length ? starts[i + 1] : Infinity;
      const inWindow = calls.filter((c) => c.t >= start && c.t < end);
      if (inWindow.length === 0) {
        out.push(...rows);
        if (stats) {
          stats.chatOnlyTurns++;
          stats.chatOnlyCredits += chatCredits;
        }
        return;
      }
      const debugCredits = inWindow.reduce((sum, c) => sum + c.credits, 0);
      const gap = chatCredits - debugCredits;
      if (gap > 0.0001) {
        const turn = rows.find((r) => (r.requests ?? 1) > 0) ?? rows[0];
        out.push({
          ...turn,
          id: `${turn.id}:topup`,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          creditsExact: round4(gap),
          creditsEstimated: 0,
          isEstimated: false,
          requests: 0
        });
      }
      if (stats) {
        stats.coveredTurns++;
        stats.coveredChatCredits += chatCredits;
        stats.coveredDebugCredits += debugCredits;
        stats.topUpCredits += Math.max(0, gap);
      }
    });
  });
  return out;
}

/** Overlap figures for entries since `startMs`, rounded for display. */
export function overlapStats(entries: readonly UsageEntry[], startMs: number): OverlapStats {
  const stats: OverlapStats = {
    raw: {},
    coveredTurns: 0,
    coveredChatCredits: 0,
    coveredDebugCredits: 0,
    topUpCredits: 0,
    chatOnlyTurns: 0,
    chatOnlyCredits: 0,
    droppedCliCredits: 0
  };
  // Approximate at the period boundary: rows before startMs are ignored.
  resolveOverlaps(entries.filter((e) => Date.parse(e.timestamp) >= startMs), stats);
  return stats;
}

/** De-duplicated entries that fall within the selected period (and on/after
 *  the billing start). */
export function filterByPeriod(
  entries: readonly UsageEntry[],
  period: PeriodId,
  markers: readonly ResetMarker[],
  now: Date,
  billingStartMs: number | null = null
): UsageEntry[] {
  const unique = resolveOverlaps(entries);
  const start = periodStart(period, markers, now, billingStartMs);
  if (start === null) {
    return unique;
  }
  return unique.filter((e) => new Date(e.timestamp).getTime() >= start);
}

/** Build the full dashboard payload for a period and credit-counting mode. */
export function aggregate(
  entries: readonly UsageEntry[],
  period: PeriodId,
  includeEstimated: boolean,
  markers: readonly ResetMarker[],
  lastScanAt: string | null,
  now: Date = new Date(),
  workspaceNames: Record<string, string> = {},
  billingStartMs: number | null = null,
  usdPerCredit = 0,
  otherUsageBufferPercent = 0
): DashboardData {
  const scoped = filterByPeriod(entries, period, markers, now, billingStartMs);
  const value = (e: UsageEntry): number =>
    e.creditsExact !== null ? e.creditsExact : includeEstimated ? e.creditsEstimated : 0;

  const model = new Map<string, Bucket>();
  const source = new Map<string, Bucket>();
  const workspace = new Map<string, Bucket>();
  const dayCredits = new Map<string, number>();
  const totals = { exactCredits: 0, fallbackCredits: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  const todayKey = dateKey(now);
  let creditsPeriod = 0;
  let creditsToday = 0;
  let estimatedRequestCount = 0;
  let exactCount = 0;
  let requests = 0;

  for (const e of scoped) {
    const credits = value(e);
    requests += requestCount(e);
    creditsPeriod += credits;
    const day = dateKey(new Date(e.timestamp));
    if (day === todayKey) {
      creditsToday += credits;
    }
    dayCredits.set(day, (dayCredits.get(day) ?? 0) + credits);

    addTo(model, e.model || 'unknown', credits, e);
    addTo(source, SOURCE_LABELS[e.source] ?? e.source, credits, e);
    addTo(workspace, resolveWorkspaceLabel(e, workspaceNames), credits, e);

    if (e.creditsExact !== null) {
      totals.exactCredits += e.creditsExact;
      exactCount++;
    } else {
      estimatedRequestCount += requestCount(e);
      totals.fallbackCredits += e.creditsEstimated;
    }
    totals.inputTokens += e.inputTokens;
    totals.outputTokens += e.outputTokens;
    totals.cachedTokens += e.cachedTokens;
  }

  const byModel = sortBuckets(model);
  const unknownModels = byModel
    .map((b) => b.label)
    .filter((label) => label !== 'unknown' && !isKnownModel(label));
  const trust: DashboardData['trust'] =
    scoped.length === 0 ? 'none' : estimatedRequestCount === 0 ? 'exact' : exactCount === 0 ? 'estimated' : 'mixed';

  return {
    generatedAt: now.toISOString(),
    period,
    includeEstimated,
    lastScanAt,
    trust,
    kpis: {
      creditsPeriod: round4(creditsPeriod),
      assumedAccountTotal: round4(creditsPeriod * (1 + Math.max(0, otherUsageBufferPercent) / 100)),
      creditsToday: round4(creditsToday),
      requests,
      topModel: byModel.length ? byModel[0].label : '—'
    },
    daily: [...dayCredits.entries()]
      .map(([date, credits]) => ({ date, credits: round4(credits) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    byModel,
    bySource: sortBuckets(source),
    byWorkspace: sortBuckets(workspace),
    totals: {
      exactCredits: round4(totals.exactCredits),
      fallbackCredits: round4(totals.fallbackCredits),
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cachedTokens: totals.cachedTokens
    },
    estimatedRequestCount,
    unknownModels,
    usdPerCredit,
    otherUsageBufferPercent: Math.max(0, otherUsageBufferPercent),
    periods: PERIODS
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Best human-readable workspace label: a rebuilt name wins, then the name
 *  resolved at parse time, then the raw key (a hash) as a last resort. */
function resolveWorkspaceLabel(e: UsageEntry, names: Record<string, string>): string {
  const mapped = names[e.workspaceKey];
  if (mapped && mapped !== e.workspaceKey) {
    return mapped;
  }
  if (e.workspaceName && e.workspaceName !== e.workspaceKey) {
    return e.workspaceName;
  }
  return e.workspaceKey;
}

function addTo(map: Map<string, Bucket>, label: string, credits: number, e: UsageEntry): void {
  const bucket = map.get(label) ?? { label, credits: 0, requests: 0, tokens: 0 };
  bucket.credits += credits;
  bucket.requests += requestCount(e);
  bucket.tokens += e.inputTokens + e.outputTokens;
  map.set(label, bucket);
}

/** Requests an entry represents (CLI session totals carry their own count). */
function requestCount(e: UsageEntry): number {
  return e.requests ?? 1;
}

function sortBuckets(map: Map<string, Bucket>): Bucket[] {
  return [...map.values()]
    .map((b) => ({ ...b, credits: round4(b.credits) }))
    .sort((a, b) => b.credits - a.credits || b.requests - a.requests);
}

function latestMarker(markers: readonly ResetMarker[]): ResetMarker | undefined {
  return [...markers].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
}

/** UTC YYYY-MM-DD key, matching the UTC day GitHub uses for billing. */
function dateKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
