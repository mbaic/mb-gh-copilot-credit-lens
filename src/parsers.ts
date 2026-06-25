// JSONL parsing for all three local Copilot sources.
//
// Design rules (see .temp specs): treat schemas as evolving inputs. Unknown
// fields are ignored, missing fields tolerated, and a single malformed line
// never aborts the scan — it is skipped with a warning. Reading is incremental:
// we read only the bytes appended since the stored cursor.

import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import { DiscoveredFile } from './paths';
import { ParseResult, UsageEntry } from './types';
import { estimateCredits } from './rates';

const NANO_PER_AIU = 1_000_000_000;
const NEWLINE = 0x0a;

/** Read appended content of one file from a byte cursor and parse usage events. */
export async function parseFile(file: DiscoveredFile, fromCursor: number): Promise<ParseResult> {
  const warnings: string[] = [];
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file.filePath, 'r');
    const stat = await handle.stat();
    const size = stat.size;

    // If the cursor is past EOF the file was truncated/rotated — re-read fully.
    let start = fromCursor > size ? 0 : fromCursor;
    const length = size - start;
    if (length <= 0) {
      return { entries: [], newCursor: size, warnings };
    }

    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);

    // Only consume up to the last complete line; keep any partial tail for next scan.
    const lastNewline = buffer.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      return { entries: [], newCursor: start, warnings };
    }
    const text = buffer.subarray(0, lastNewline + 1).toString('utf8');
    const newCursor = start + lastNewline + 1;
    const fallbackTs = stat.mtime.toISOString();

    const entries: UsageEntry[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        warnings.push(`Skipped malformed JSON line in ${file.filePath}`);
        continue;
      }
      const entry = toEntry(obj, file, fallbackTs);
      if (entry) {
        entries.push(entry);
      }
    }
    return { entries, newCursor, warnings };
  } catch (err) {
    warnings.push(`Could not read ${file.filePath}: ${errorMessage(err)}`);
    return { entries: [], newCursor: fromCursor, warnings };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Convert one parsed JSON object into a UsageEntry, or null if it is not a
 *  usage event we recognise. */
function toEntry(obj: unknown, file: DiscoveredFile, fallbackTs: string): UsageEntry | null {
  if (!isRecord(obj)) {
    return null;
  }
  // Usage figures may sit at the top level or under a nested object. VS Code
  // agent debug logs put them under `attrs` (with type==="llm_request"); other
  // shapes use `usage`/`response`/`data`/`metrics`.
  const scopes: Record<string, unknown>[] = [obj];
  for (const key of ['attrs', 'usage', 'response', 'data', 'metrics']) {
    const nested = obj[key];
    if (isRecord(nested)) {
      scopes.push(nested);
      const deeper = nested['usage'];
      if (isRecord(deeper)) {
        scopes.push(deeper);
      }
    }
  }

  const model = pickString(scopes, ['model', 'modelId', 'model_id', 'modelName', 'resolvedModel']);
  const nanoAiu = pickNumber(scopes, ['copilotUsageNanoAiu', 'usageNanoAiu', 'nanoAiu', 'totalNanoAiu']);
  const inputTokens = pickNumber(scopes, [
    'inputTokens', 'promptTokens', 'input_tokens', 'prompt_tokens', 'promptTokenCount'
  ]);
  const outputTokens = pickNumber(scopes, [
    'outputTokens', 'completionTokens', 'output_tokens', 'completion_tokens', 'candidatesTokenCount'
  ]);
  const cachedTokens = pickNumber(scopes, [
    'cachedTokens', 'cacheReadTokens', 'cached_tokens', 'cacheReadInputTokens'
  ]);

  const hasUsageSignal =
    nanoAiu !== undefined || inputTokens !== undefined || outputTokens !== undefined;
  if (!model || !hasUsageSignal) {
    return null; // Not a usage event — ignore quietly.
  }

  const timestamp = normalizeTimestamp(
    pickRaw(scopes, ['ts', 'timestamp', 'time', 'createdAt', 'requestTime']),
    fallbackTs
  );

  const creditsExact = nanoAiu === undefined ? null : round4(nanoAiu / NANO_PER_AIU);
  const creditsEstimated = round4(estimateCredits(model));

  const id = hashId([
    file.source,
    file.sessionId,
    timestamp,
    model,
    String(inputTokens ?? ''),
    String(outputTokens ?? ''),
    String(nanoAiu ?? '')
  ]);

  return {
    id,
    timestamp,
    source: file.source,
    sessionId: file.sessionId,
    model,
    workspaceKey: file.workspaceKey,
    workspaceName: file.workspaceName,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedTokens: cachedTokens ?? 0,
    creditsExact,
    creditsEstimated,
    isEstimated: creditsExact === null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickRaw(scopes: Record<string, unknown>[], keys: string[]): unknown {
  for (const scope of scopes) {
    for (const key of keys) {
      if (scope[key] !== undefined && scope[key] !== null) {
        return scope[key];
      }
    }
  }
  return undefined;
}

function pickString(scopes: Record<string, unknown>[], keys: string[]): string {
  const raw = pickRaw(scopes, keys);
  return typeof raw === 'string' ? raw : '';
}

function pickNumber(scopes: Record<string, unknown>[], keys: string[]): number | undefined {
  const raw = pickRaw(scopes, keys);
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  return undefined;
}

/** Accept epoch milliseconds, epoch seconds, or an ISO string. Implausible
 *  values (e.g. monotonic/relative numbers) fall back to the file's mtime so a
 *  bad timestamp never lands an entry in 1970 and skews period filtering. */
function normalizeTimestamp(raw: unknown, fallback: string): string {
  let ms: number | undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    ms = raw < 1e12 ? raw * 1000 : raw;
  } else if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      ms = parsed;
    }
  }
  if (ms !== undefined) {
    const year = new Date(ms).getUTCFullYear();
    if (year >= 2015 && year <= 2100) {
      return new Date(ms).toISOString();
    }
  }
  return fallback;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function hashId(parts: string[]): string {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
