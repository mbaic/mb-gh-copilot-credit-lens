// Shared data model for Copilot Credit Lens.
//
// Everything here is plain data — no VS Code or I/O imports — so it can be
// reused by the parsers, the ledger, the aggregator and the dashboard without
// pulling in the editor host. Keep it that way.

/** Where a usage record came from. */
export type SessionSource = 'chat' | 'debug' | 'cli';

/** A single normalized Copilot usage event stored in the ledger. */
export interface UsageEntry {
  /** Deterministic, globally-unique id — re-deriving it for the same event
   *  always yields the same value, which is what makes ingestion idempotent. */
  id: string;
  /** ISO-8601 timestamp of the event. */
  timestamp: string;
  source: SessionSource;
  sessionId: string;
  model: string;
  /** Stable key for the originating workspace (hash or path digest). */
  workspaceKey: string;
  /** Human-readable workspace name, resolved at parse time so it survives
   *  later deletion of the workspace metadata. */
  workspaceName: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Exact credits billed (copilotUsageNanoAiu / 1e9), or null when the source
   *  record carried no authoritative billing field. */
  creditsExact: number | null;
  /** Best-effort estimated credits derived from the model rate table. Always
   *  populated so the dashboard can offer an "include estimates" view. */
  creditsEstimated: number;
  /** True when creditsExact is null (i.e. the only credit figure is an estimate). */
  isEstimated: boolean;
  /** Model requests this entry represents. Absent = 1 (one entry per call/turn).
   *  CLI per-session totals carry their real count; a session-level credit
   *  remainder carries 0 so it adds credits without inflating request counts. */
  requests?: number;
}

/** A user-defined period boundary that does not delete any data. */
export interface ResetMarker {
  id: string;
  timestamp: string;
  label: string;
}

/** The complete on-disk ledger document. */
export interface Ledger {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  lastScanAt: string | null;
  /** Per-file cursor: a byte offset for append-only debug logs, or the file's
   *  last-seen mtime/size for snapshot sources (chat sessions, CLI events). */
  fileCursors: Record<string, number>;
  /** workspaceKey -> resolved display name (last good value wins). */
  workspaceMap: Record<string, string>;
  resetMarkers: ResetMarker[];
  entries: UsageEntry[];
}

/** v2: chat sessions and CLI events are parsed as snapshots (exact credits);
 *  entries and cursors from v1's generic chat/CLI parsing are discarded once. */
export const SCHEMA_VERSION = 2;

/** Selectable reporting periods. Mirrors the package.json enum. */
export type PeriodId =
  | 'currentMonth'
  | 'last3Months'
  | 'last6Months'
  | 'last9Months'
  | 'last12Months'
  | 'sinceReset'
  | 'allTime';

/** A resilient parse result: usable entries plus any non-fatal warnings. */
export interface ParseResult {
  entries: UsageEntry[];
  /** New cursor to persist for the parsed file. */
  newCursor: number;
  /** True when entries are a full snapshot of the file (upsert by id), false
   *  when they are newly appended events (append-only). */
  snapshot?: boolean;
  warnings: string[];
}
