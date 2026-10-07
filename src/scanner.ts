// Orchestrates a scan: discover every local Copilot source, read each file from
// its stored cursor, parse, and merge into the ledger. Pure coordination —
// platform paths live in paths.ts, parsing in parsers.ts, and cross-source
// overlap is resolved at read time in aggregate.ts (resolveOverlaps).

import {
  DiscoveredFile,
  discoverChatFiles,
  discoverCliFiles,
  discoverDebugFiles
} from './paths';
import { parseFile } from './parsers';
import { LedgerStore } from './ledger';

export interface ScanConfig {
  /** VS Code "User" roots to scan for chat sessions and debug logs. Empty =
   *  Copilot CLI only (the standalone `ccl` tool and the CLI extension). */
  roots: string[];
}

export interface ScanResult {
  added: number;
  filesScanned: number;
  /** Files discovered per source (chat / debug / cli). */
  filesBySource: Record<string, number>;
  warnings: string[];
}

/** Discover every file we should ingest. */
export async function discoverAll(config: ScanConfig): Promise<DiscoveredFile[]> {
  const groups = await Promise.all([
    discoverChatFiles(config.roots),
    discoverDebugFiles(config.roots),
    discoverCliFiles()
  ]);
  return groups.flat();
}

/** Run a full incremental scan and persist the ledger if anything changed. */
export async function runScan(ledger: LedgerStore, config: ScanConfig): Promise<ScanResult> {
  const files = await discoverAll(config);
  const warnings: string[] = [];
  let added = 0;

  for (const file of files) {
    const cursor = ledger.getCursor(file.filePath);
    const result = await parseFile(file, cursor);
    warnings.push(...result.warnings);
    if (result.entries.length > 0) {
      added += result.snapshot ? ledger.upsertEntries(result.entries) : ledger.appendEntries(result.entries);
    }
    ledger.setCursor(file.filePath, result.newCursor);
  }

  ledger.markScanned();
  await ledger.save();
  const filesBySource: Record<string, number> = {};
  for (const file of files) {
    filesBySource[file.source] = (filesBySource[file.source] ?? 0) + 1;
  }
  return { added, filesScanned: files.length, filesBySource, warnings };
}
