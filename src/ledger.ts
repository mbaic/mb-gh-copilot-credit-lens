// The extension-owned ledger: the durable record of usage that outlives the
// source log files. Stored as human-readable JSON in the extension's global
// storage, written atomically with a one-deep backup.

import * as path from 'path';
import * as fsp from 'fs/promises';
import { Ledger, ResetMarker, SCHEMA_VERSION, UsageEntry } from './types';

/** Higher number wins when the same logical event appears in multiple sources. */
const SOURCE_PRIORITY: Record<string, number> = { debug: 3, chat: 2, cli: 1 };

export class LedgerStore {
  private readonly mainPath: string;
  private readonly backupPath: string;
  private readonly tmpPath: string;
  private ledger: Ledger;

  constructor(private readonly storageDir: string) {
    this.mainPath = path.join(storageDir, 'ledger.json');
    this.backupPath = path.join(storageDir, 'ledger.backup.json');
    this.tmpPath = path.join(storageDir, 'ledger.json.tmp');
    this.ledger = LedgerStore.emptyLedger();
  }

  static emptyLedger(): Ledger {
    const now = new Date().toISOString();
    return {
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      lastScanAt: null,
      fileCursors: {},
      workspaceMap: {},
      resetMarkers: [],
      entries: []
    };
  }

  /** Load the ledger, falling back to the backup if the main file is corrupt. */
  async load(): Promise<void> {
    await fsp.mkdir(this.storageDir, { recursive: true });
    const loaded = (await this.tryRead(this.mainPath)) ?? (await this.tryRead(this.backupPath));
    this.ledger = loaded ?? LedgerStore.emptyLedger();
  }

  private async tryRead(file: string): Promise<Ledger | undefined> {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as Ledger;
      if (parsed && Array.isArray(parsed.entries)) {
        return this.normalize(parsed);
      }
    } catch {
      /* missing or corrupt — caller falls back */
    }
    return undefined;
  }

  /** Defensive defaults so an older or partial ledger never throws downstream. */
  private normalize(l: Ledger): Ledger {
    return {
      schemaVersion: l.schemaVersion ?? SCHEMA_VERSION,
      createdAt: l.createdAt ?? new Date().toISOString(),
      updatedAt: l.updatedAt ?? new Date().toISOString(),
      lastScanAt: l.lastScanAt ?? null,
      fileCursors: l.fileCursors ?? {},
      workspaceMap: l.workspaceMap ?? {},
      resetMarkers: Array.isArray(l.resetMarkers) ? l.resetMarkers : [],
      entries: Array.isArray(l.entries) ? l.entries : []
    };
  }

  /** Atomic save: write temp, copy current to backup, rename temp over main. */
  async save(): Promise<void> {
    this.ledger.updatedAt = new Date().toISOString();
    await fsp.mkdir(this.storageDir, { recursive: true });
    await fsp.writeFile(this.tmpPath, JSON.stringify(this.ledger, null, 2), 'utf8');
    try {
      await fsp.copyFile(this.mainPath, this.backupPath);
    } catch {
      /* no existing main yet — nothing to back up */
    }
    await fsp.rename(this.tmpPath, this.mainPath);
  }

  getCursor(filePath: string): number {
    return this.ledger.fileCursors[filePath] ?? 0;
  }

  setCursor(filePath: string, cursor: number): void {
    this.ledger.fileCursors[filePath] = cursor;
  }

  markScanned(): void {
    this.ledger.lastScanAt = new Date().toISOString();
  }

  get entries(): readonly UsageEntry[] {
    return this.ledger.entries;
  }

  get resetMarkers(): readonly ResetMarker[] {
    return this.ledger.resetMarkers;
  }

  get lastScanAt(): string | null {
    return this.ledger.lastScanAt;
  }

  /**
   * Append parsed entries, de-duplicating by exact id and collapsing the same
   * logical event across overlapping sources (debug beats chat beats cli).
   * Returns the number of entries actually added or upgraded.
   */
  appendEntries(incoming: UsageEntry[]): number {
    if (incoming.length === 0) {
      return 0;
    }
    const byId = new Set<string>();
    const logicalIndex = new Map<string, number>();
    this.ledger.entries.forEach((entry, index) => {
      byId.add(entry.id);
      logicalIndex.set(logicalKey(entry), index);
    });

    let changed = 0;
    for (const entry of incoming) {
      if (byId.has(entry.id)) {
        continue;
      }
      this.ledger.workspaceMap[entry.workspaceKey] = entry.workspaceName;

      const key = logicalKey(entry);
      const existingIndex = logicalIndex.get(key);
      if (existingIndex !== undefined) {
        const existing = this.ledger.entries[existingIndex];
        if (priority(entry) > priority(existing)) {
          byId.delete(existing.id);
          this.ledger.entries[existingIndex] = entry;
          byId.add(entry.id);
          changed++;
        }
        continue; // duplicate logical event — kept the higher-priority one
      }

      this.ledger.entries.push(entry);
      byId.add(entry.id);
      logicalIndex.set(key, this.ledger.entries.length - 1);
      changed++;
    }
    return changed;
  }

  addResetMarker(label: string): ResetMarker {
    const marker: ResetMarker = {
      id: `reset-${Date.now()}`,
      timestamp: new Date().toISOString(),
      label: label || 'Reset'
    };
    this.ledger.resetMarkers.push(marker);
    return marker;
  }

  /** Write a self-contained copy of the current ledger to an arbitrary path
   *  (manual backup or auto-backup). Atomic via temp file + rename. */
  async exportTo(filePath: string): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.ledger, null, 2), 'utf8');
    await fsp.rename(tmp, filePath);
  }

  /** Wipe all data and start a fresh ledger on disk. */
  async clear(): Promise<void> {
    this.ledger = LedgerStore.emptyLedger();
    await this.save();
  }
}

function priority(entry: UsageEntry): number {
  return SOURCE_PRIORITY[entry.source] ?? 0;
}

function logicalKey(entry: UsageEntry): string {
  return [entry.sessionId, entry.timestamp, entry.model, entry.inputTokens, entry.outputTokens].join('|');
}
