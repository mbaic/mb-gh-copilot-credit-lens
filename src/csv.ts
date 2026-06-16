// CSV export of usage entries. Pure string building — no I/O here.

import { UsageEntry } from './types';

const COLUMNS: { header: string; get: (e: UsageEntry) => string | number }[] = [
  { header: 'timestamp', get: (e) => e.timestamp },
  { header: 'source', get: (e) => e.source },
  { header: 'sessionId', get: (e) => e.sessionId },
  { header: 'model', get: (e) => e.model },
  { header: 'workspaceName', get: (e) => e.workspaceName },
  { header: 'workspaceKey', get: (e) => e.workspaceKey },
  { header: 'inputTokens', get: (e) => e.inputTokens },
  { header: 'outputTokens', get: (e) => e.outputTokens },
  { header: 'cachedTokens', get: (e) => e.cachedTokens },
  { header: 'creditsExact', get: (e) => (e.creditsExact === null ? '' : e.creditsExact) },
  { header: 'creditsEstimated', get: (e) => e.creditsEstimated },
  { header: 'isEstimated', get: (e) => (e.isEstimated ? 'true' : 'false') }
];

/** Render entries as RFC-4180-style CSV (newest first). */
export function toCsv(entries: readonly UsageEntry[]): string {
  const rows = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const lines = [COLUMNS.map((c) => c.header).join(',')];
  for (const entry of rows) {
    lines.push(COLUMNS.map((c) => escapeCell(c.get(entry))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function escapeCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
