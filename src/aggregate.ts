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
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
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

/** Entries that fall within the selected period (and on/after the billing start). */
export function filterByPeriod(
  entries: readonly UsageEntry[],
  period: PeriodId,
  markers: readonly ResetMarker[],
  now: Date,
  billingStartMs: number | null = null
): UsageEntry[] {
  const start = periodStart(period, markers, now, billingStartMs);
  if (start === null) {
    return entries.slice();
  }
  return entries.filter((e) => new Date(e.timestamp).getTime() >= start);
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
  usdPerCredit = 0
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

  for (const e of scoped) {
    const credits = value(e);
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
      estimatedRequestCount++;
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
      creditsToday: round4(creditsToday),
      requests: scoped.length,
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
  bucket.requests += 1;
  bucket.tokens += e.inputTokens + e.outputTokens;
  map.set(label, bucket);
}

function sortBuckets(map: Map<string, Bucket>): Bucket[] {
  return [...map.values()]
    .map((b) => ({ ...b, credits: round4(b.credits) }))
    .sort((a, b) => b.credits - a.credits || b.requests - a.requests);
}

function latestMarker(markers: readonly ResetMarker[]): ResetMarker | undefined {
  return [...markers].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
}

/** Local-time YYYY-MM-DD key. */
function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
