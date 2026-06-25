// Best-effort bridge from the Copilot CLI's live session metrics to UsageEntry.
//
// When the `/credits` command runs *inside* a live Copilot CLI session, the host
// exposes per-model usage for the current (not-yet-finished) session over an RPC
// channel (`session.rpc.usage.getMetrics()`). The on-disk events.jsonl only gains
// the session's numbers once it ends, so this fills the gap for the in-flight
// session.
//
// Everything here is defensive: the RPC shape is treated as an evolving input
// (invariant #4). If the RPC is absent, throws, or returns an unexpected shape,
// we return [] and the dashboard still renders entirely from the ledger. This
// module is the ONLY place coupled to the host's metrics shape, so drift is a
// one-file fix. It is never imported by the VS Code extension.

import * as crypto from 'crypto';
import { UsageEntry } from './types';
import { estimateCredits } from './rates';

const NANO_PER_AIU = 1_000_000_000;

/** Structural, permissive view of the host session object (no SDK dependency). */
interface SessionLike {
  rpc?: { usage?: { getMetrics?: () => unknown } };
}

/**
 * Read the live session's per-model metrics and map them to UsageEntry rows.
 * Returns [] on any error or unrecognised shape — never throws.
 */
export async function liveSessionEntries(session: unknown, sessionId = 'live-session'): Promise<UsageEntry[]> {
  try {
    const getMetrics = (session as SessionLike)?.rpc?.usage?.getMetrics;
    if (typeof getMetrics !== 'function') {
      return [];
    }
    const metrics = await getMetrics();
    return mapMetrics(metrics, sessionId);
  } catch {
    return [];
  }
}

/** Map a metrics payload into one UsageEntry per model, tolerating field drift. */
export function mapMetrics(metrics: unknown, sessionId: string): UsageEntry[] {
  const models = extractModelMap(metrics);
  const out: UsageEntry[] = [];
  const timestamp = new Date().toISOString();

  for (const [model, raw] of Object.entries(models)) {
    if (!isRecord(raw)) {
      continue;
    }
    const usage = isRecord(raw.usage) ? raw.usage : raw;
    const inputTokens = num(usage, ['inputTokens', 'input_tokens', 'promptTokens']);
    const outputTokens = num(usage, ['outputTokens', 'output_tokens', 'completionTokens']);
    const cachedTokens = num(usage, ['cacheReadTokens', 'cachedTokens', 'cache_read_input_tokens']);
    const nanoAiu = num(raw, ['totalNanoAiu', 'copilotUsageNanoAiu', 'usageNanoAiu']);
    const requestCount = num(isRecord(raw.requests) ? raw.requests : raw, ['count', 'requests', 'requestCount']);

    const hasSignal = nanoAiu !== undefined || inputTokens !== undefined || outputTokens !== undefined;
    if (!model || !hasSignal) {
      continue;
    }

    const creditsExact = nanoAiu === undefined ? null : round4(nanoAiu / NANO_PER_AIU);
    out.push({
      id: hashId(['cli', sessionId, model, 'live']),
      timestamp,
      source: 'cli',
      sessionId,
      model,
      workspaceKey: 'cli',
      workspaceName: 'CLI (live)',
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cachedTokens: cachedTokens ?? 0,
      creditsExact,
      creditsEstimated: round4(estimateCredits(model) * Math.max(1, requestCount ?? 1)),
      isEstimated: creditsExact === null
    });
  }
  return out;
}

/** Find the per-model map under any of the likely keys, or treat the root as it. */
function extractModelMap(metrics: unknown): Record<string, unknown> {
  if (!isRecord(metrics)) {
    return {};
  }
  for (const key of ['modelMetrics', 'models', 'byModel', 'perModel']) {
    const nested = metrics[key];
    if (isRecord(nested)) {
      return nested;
    }
  }
  // Some shapes put model entries directly at the root.
  const looksLikeModelMap = Object.values(metrics).every((v) => isRecord(v));
  return looksLikeModelMap ? metrics : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(scope: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = scope[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
  }
  return undefined;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function hashId(parts: string[]): string {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}
