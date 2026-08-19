// Orchestrates a scan: discover candidate files for the enabled sources, read
// each from its stored cursor, parse, and append into the ledger. Pure
// coordination — platform paths live in paths.ts, parsing in parsers.ts.

import {
  DiscoveredFile,
  discoverChatFiles,
  discoverCliFiles,
  discoverDebugFiles
} from './paths';
import { parseFile } from './parsers';
import { LedgerStore } from './ledger';

export interface ScanConfig {
  roots: string[];
  includeChat: boolean;
  includeDebug: boolean;
  includeCli: boolean;
}

export interface ScanResult {
  added: number;
  filesScanned: number;
  warnings: string[];
}

/** Discover every file the current configuration says we should ingest. */
export async function discoverAll(config: ScanConfig): Promise<DiscoveredFile[]> {
  const groups = await Promise.all([
    config.includeChat ? discoverChatFiles(config.roots) : Promise.resolve([]),
    config.includeDebug ? discoverDebugFiles(config.roots) : Promise.resolve([]),
    config.includeCli ? discoverCliFiles() : Promise.resolve([])
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
      added += ledger.appendEntries(result.entries);
    }
    ledger.setCursor(file.filePath, result.newCursor);
  }

  ledger.markScanned();
  await ledger.save();
  return { added, filesScanned: files.length, warnings };
}
