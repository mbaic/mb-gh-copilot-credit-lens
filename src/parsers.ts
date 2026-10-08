// Parsing for all three local Copilot sources.
//
// Design rules: treat schemas as evolving inputs. Unknown fields are ignored,
// missing fields tolerated, and a single malformed line never aborts the scan —
// it is skipped with a warning.
//
// - Agent debug logs are append-only JSONL: read incrementally from a byte cursor.
// - Chat session files (VS Code >= 1.125) carry exact per-turn credits
//   (`copilotCredits`) but are rewritten in place (a full JSON document, or a
//   JSONL mutation log that patches it), so they are re-read as a whole snapshot
//   whenever their mtime changes and their entries are upserted by id.
// - Copilot CLI events.jsonl only persists billing in `session.shutdown`
//   (per-model totals) and `session.usage_checkpoint` (running total); per-call
//   `assistant.usage` events are ephemeral and never reach disk. Also a snapshot.

import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import { DiscoveredFile } from './paths';
import { ParseResult, UsageEntry } from './types';

const NANO_PER_AIU = 1_000_000_000;
const NEWLINE = 0x0a;

/** Parse one discovered file from its stored cursor, dispatching by source. */
export async function parseFile(file: DiscoveredFile, fromCursor: number): Promise<ParseResult> {
  switch (file.source) {
    case 'chat':
      return parseSnapshot(file, fromCursor, parseChatSession);
    case 'cli':
      return parseSnapshot(file, fromCursor, parseCliEvents);
    default:
      return parseAppended(file, fromCursor);
  }
}

/** Re-read a whole file when it changed since the last scan (cursor = mtime
 *  in ms, plus size so a same-millisecond rewrite is still noticed). */
async function parseSnapshot(
  file: DiscoveredFile,
  cursor: number,
  parse: (text: string, file: DiscoveredFile, fallbackTs: string, warnings: string[]) => UsageEntry[]
): Promise<ParseResult> {
  const warnings: string[] = [];
  try {
    const stat = await fsp.stat(file.filePath);
    const signature = Math.floor(stat.mtimeMs) * 1000 + (stat.size % 1000);
    if (signature === cursor) {
      return { entries: [], newCursor: cursor, warnings, snapshot: true };
    }
    const text = await fsp.readFile(file.filePath, 'utf8');
    const entries = parse(text, file, stat.mtime.toISOString(), warnings);
    return { entries, newCursor: signature, warnings, snapshot: true };
  } catch (err) {
    warnings.push(`Could not read ${file.filePath}: ${errorMessage(err)}`);
    return { entries: [], newCursor: cursor, warnings, snapshot: true };
  }
}

/** Read appended content of one file from a byte cursor and parse usage events. */
async function parseAppended(file: DiscoveredFile, fromCursor: number): Promise<ParseResult> {
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
    creditsExact
  };
}

// ── Chat sessions ────────────────────────────────────────────────────────────

/** Rebuild the serialized chat session from either storage format: a plain
 *  JSON document, or VS Code's JSONL mutation log (kind 0 = initial state,
 *  1 = set path, 2 = push to array at path (truncate to `i` first), 3 = delete). */
function readChatDocument(text: string, file: DiscoveredFile, warnings: string[]): unknown {
  if (file.filePath.endsWith('.json')) {
    try {
      return JSON.parse(text);
    } catch {
      warnings.push(`Skipped malformed chat session ${file.filePath}`);
      return undefined;
    }
  }
  let state: unknown;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let op: unknown;
    try {
      op = JSON.parse(line);
    } catch {
      warnings.push(`Skipped malformed JSON line in ${file.filePath}`);
      continue;
    }
    if (!isRecord(op)) {
      continue;
    }
    if (op.kind === 0) {
      state = op.v;
    } else if (Array.isArray(op.k) && op.k.length > 0 && isRecord(state)) {
      applyMutation(state, op.kind, op.k as (string | number)[], op.v, op.i);
    }
  }
  return state;
}

function applyMutation(root: Record<string, unknown>, kind: unknown, keys: (string | number)[], v: unknown, i: unknown): void {
  let parent: unknown = root;
  for (const key of keys.slice(0, -1)) {
    parent = (parent as Record<string | number, unknown> | undefined)?.[key];
    if (typeof parent !== 'object' || parent === null) {
      return; // path no longer exists — ignore this mutation
    }
  }
  const target = parent as Record<string | number, unknown>;
  const last = keys[keys.length - 1];
  if (kind === 1) {
    target[last] = v;
  } else if (kind === 3) {
    delete target[last];
  } else if (kind === 2) {
    const arr = Array.isArray(target[last]) ? (target[last] as unknown[]) : [];
    if (typeof i === 'number' && i >= 0) {
      arr.length = Math.min(arr.length, i);
    }
    if (Array.isArray(v)) {
      arr.push(...v);
    }
    target[last] = arr;
  }
}

/** One entry per chat turn that reports usage. `copilotCredits` is the exact,
 *  backend-billed cost VS Code shows on the turn; `sessionCopilotCredits`
 *  (when reported) also covers work billed outside a turn, e.g. compaction,
 *  and any surplus over the summed turns is booked as a request-less remainder. */
function parseChatSession(text: string, file: DiscoveredFile, fallbackTs: string, warnings: string[]): UsageEntry[] {
  const doc = readChatDocument(text, file, warnings);
  const requests = isRecord(doc) && Array.isArray(doc.requests) ? doc.requests : [];
  const entries: UsageEntry[] = [];
  let turnCredits = 0;
  let sessionCredits: number | undefined;

  for (const req of requests) {
    if (!isRecord(req)) {
      continue;
    }
    const meta = isRecord(req.result) && isRecord(req.result.metadata) ? req.result.metadata : {};
    const credits = finiteNumber(req.copilotCredits);
    const inputTokens = finiteNumber(req.promptTokens) ?? finiteNumber(meta.promptTokens);
    const outputTokens = finiteNumber(req.completionTokens) ?? finiteNumber(meta.outputTokens);
    const session = finiteNumber(req.sessionCopilotCredits);
    if (session !== undefined) {
      sessionCredits = Math.max(sessionCredits ?? 0, session);
    }
    if (credits === undefined && inputTokens === undefined && outputTokens === undefined) {
      continue; // no usage reported (pending, cancelled before a model call, …)
    }
    const model = chatModel(req, meta);
    const requestId = typeof req.requestId === 'string' ? req.requestId : String(entries.length);
    if (credits !== undefined) {
      turnCredits += credits;
    }
    entries.push({
      id: hashId(['chat', file.sessionId, requestId]),
      timestamp: normalizeTimestamp(req.timestamp, fallbackTs),
      source: 'chat',
      sessionId: file.sessionId,
      model,
      workspaceKey: file.workspaceKey,
      workspaceName: file.workspaceName,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cachedTokens: 0,
      creditsExact: credits ?? null
    });
  }

  const remainder = sessionCredits === undefined ? 0 : sessionCredits - turnCredits;
  if (remainder > 0.0001 && entries.length > 0) {
    const last = entries[entries.length - 1];
    entries.push({
      ...last,
      id: hashId(['chat', file.sessionId, 'session-remainder']),
      inputTokens: 0,
      outputTokens: 0,
      creditsExact: round4(remainder),
      requests: 0
    });
  }
  return entries;
}

/** The model that actually served the turn (Auto resolves to a concrete one),
 *  falling back to the picker's id without its vendor prefix. */
function chatModel(req: Record<string, unknown>, meta: Record<string, unknown>): string {
  if (typeof meta.resolvedModel === 'string' && meta.resolvedModel) {
    return meta.resolvedModel;
  }
  if (typeof req.modelId === 'string' && req.modelId) {
    return req.modelId.replace(/^[^/]+\//, '');
  }
  return 'unknown';
}

// ── Copilot CLI ──────────────────────────────────────────────────────────────

/** Per-model entries from the session's last `session.shutdown` (cumulative
 *  across resumes), plus any later `session.usage_checkpoint` surplus — the
 *  cost of a session that is still running or ended without a shutdown. The
 *  CLI does not persist per-call usage, so a session lands on one timestamp. */
function parseCliEvents(text: string, file: DiscoveredFile, fallbackTs: string, warnings: string[]): UsageEntry[] {
  let shutdown: Record<string, unknown> | undefined;
  let shutdownTs = fallbackTs;
  let checkpointNano: number | undefined;
  let checkpointTs = fallbackTs;
  let model = '';

  for (const rawLine of text.split(/\r?\n/)) {
    // Cheap pre-filter: events.jsonl is mostly conversation content.
    if (!/"session\.(shutdown|usage_checkpoint|start|model_change)"/.test(rawLine)) {
      continue;
    }
    let ev: unknown;
    try {
      ev = JSON.parse(rawLine);
    } catch {
      warnings.push(`Skipped malformed JSON line in ${file.filePath}`);
      continue;
    }
    if (!isRecord(ev) || !isRecord(ev.data)) {
      continue;
    }
    const ts = normalizeTimestamp(ev.timestamp, fallbackTs);
    switch (ev.type) {
      case 'session.shutdown':
        shutdown = ev.data;
        shutdownTs = ts;
        checkpointNano = undefined; // only checkpoints after the last shutdown matter
        if (typeof ev.data.currentModel === 'string') {
          model = ev.data.currentModel;
        }
        break;
      case 'session.usage_checkpoint':
        checkpointNano = finiteNumber(ev.data.totalNanoAiu);
        checkpointTs = ts;
        break;
      case 'session.start':
        model = typeof ev.data.selectedModel === 'string' ? ev.data.selectedModel : model;
        break;
      case 'session.model_change':
        model = typeof ev.data.newModel === 'string' ? ev.data.newModel : model;
        break;
    }
  }

  const entries: UsageEntry[] = [];
  let attributedNano = 0;
  const metrics = shutdown && isRecord(shutdown.modelMetrics) ? shutdown.modelMetrics : {};
  for (const [name, raw] of Object.entries(metrics)) {
    if (!isRecord(raw)) {
      continue;
    }
    const usage = isRecord(raw.usage) ? raw.usage : {};
    const count = isRecord(raw.requests) ? finiteNumber(raw.requests.count) : undefined;
    const nano = finiteNumber(raw.totalNanoAiu);
    if (nano !== undefined) {
      attributedNano += nano;
    }
    const requests = Math.max(0, Math.round(count ?? 1));
    entries.push({
      id: hashId(['cli', file.sessionId, name]),
      timestamp: shutdownTs,
      source: 'cli',
      sessionId: file.sessionId,
      model: name,
      workspaceKey: file.workspaceKey,
      workspaceName: file.workspaceName,
      inputTokens: finiteNumber(usage.inputTokens) ?? 0,
      outputTokens: finiteNumber(usage.outputTokens) ?? 0,
      cachedTokens: finiteNumber(usage.cacheReadTokens) ?? 0,
      creditsExact: nano === undefined ? null : round4(nano / NANO_PER_AIU),
      requests
    });
  }

  const totalNano = Math.max(finiteNumber(shutdown?.totalNanoAiu) ?? 0, checkpointNano ?? 0);
  const surplus = totalNano - attributedNano;
  if (surplus > 0) {
    entries.push({
      id: hashId(['cli', file.sessionId, 'session-remainder']),
      timestamp: checkpointNano !== undefined ? checkpointTs : shutdownTs,
      source: 'cli',
      sessionId: file.sessionId,
      model: model || 'unknown',
      workspaceKey: file.workspaceKey,
      workspaceName: file.workspaceName,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      creditsExact: round4(surplus / NANO_PER_AIU),
      requests: 0
    });
  }
  return entries;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
