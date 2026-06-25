// Standalone-CLI configuration and storage-path resolution.
//
// The terminal tool has no VS Code settings host, so configuration is resolved
// with this precedence (highest wins): command-line flags > environment
// variables > a JSON config file > built-in defaults. Built-in defaults mirror
// the VS Code extension's package.json so the two front-ends behave identically.
//
// Pure Node builtins only — no network, no dependencies. The config file and the
// ledger live in the OS-appropriate per-user data directory; we never write to
// Copilot's own files.

import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { PeriodId } from './types';

/** Resolved runtime configuration for the standalone CLI. */
export interface CclConfig {
  period: PeriodId;
  includeEstimated: boolean;
  usdPerCredit: number;
  /** YYYY-MM-DD. Clamped to the billing floor by billingStartMs(). */
  billingStartDate: string;
  /** Optional folder for an automatic ledger backup after an importing sync. */
  backupDirectory: string;
  /** Rows to show in by-model / by-workspace lists. 0 = all. */
  top: number;
  /** Emit ANSI colour. Disabled automatically for non-TTY / NO_COLOR. */
  color: boolean;
  /** Render width. 0 = auto-detect from the terminal (fallback 80). */
  width: number;
}

/** GitHub usage-based billing began on this date; nothing earlier is counted. */
export const BILLING_FLOOR = '2026-06-01';

export const VALID_PERIODS: readonly PeriodId[] = [
  'currentMonth',
  'last3Months',
  'last6Months',
  'last9Months',
  'last12Months',
  'sinceReset',
  'allTime'
];

export const DEFAULT_CONFIG: CclConfig = {
  period: 'currentMonth',
  includeEstimated: false,
  usdPerCredit: 0.01,
  billingStartDate: BILLING_FLOOR,
  backupDirectory: '',
  top: 0,
  color: true,
  width: 0
};

/** OS-appropriate per-user data directory for this tool's ledger + config. */
export function storageDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'copilot-credit-lens');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'copilot-credit-lens');
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'copilot-credit-lens');
  }
}

/** Path to the optional JSON config file (lives inside the storage directory). */
export function configFilePath(): string {
  return path.join(storageDir(), 'config.json');
}

/** Inclusive billing-start epoch (ms), never earlier than the billing floor. */
export function billingStartMs(cfg: CclConfig): number {
  const floor = Date.parse(`${BILLING_FLOOR}T00:00:00Z`);
  const parsed = Date.parse(`${cfg.billingStartDate}T00:00:00Z`);
  const value = Number.isNaN(parsed) ? floor : parsed;
  return Math.max(value, floor);
}

/** True when the string is one of the supported reporting periods. */
export function isPeriod(value: string): value is PeriodId {
  return (VALID_PERIODS as readonly string[]).includes(value);
}

/** Merge a partial config (from file or env) over a base, validating each field. */
function mergeConfig(base: CclConfig, patch: Partial<Record<keyof CclConfig, unknown>>): CclConfig {
  const next: CclConfig = { ...base };
  if (typeof patch.period === 'string' && isPeriod(patch.period)) {
    next.period = patch.period;
  }
  if (typeof patch.includeEstimated === 'boolean') {
    next.includeEstimated = patch.includeEstimated;
  }
  if (typeof patch.usdPerCredit === 'number' && Number.isFinite(patch.usdPerCredit) && patch.usdPerCredit >= 0) {
    next.usdPerCredit = patch.usdPerCredit;
  }
  if (typeof patch.billingStartDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.billingStartDate)) {
    next.billingStartDate = patch.billingStartDate;
  }
  if (typeof patch.backupDirectory === 'string') {
    next.backupDirectory = patch.backupDirectory;
  }
  if (typeof patch.top === 'number' && Number.isFinite(patch.top) && patch.top >= 0) {
    next.top = Math.floor(patch.top);
  }
  if (typeof patch.color === 'boolean') {
    next.color = patch.color;
  }
  if (typeof patch.width === 'number' && Number.isFinite(patch.width) && patch.width >= 0) {
    next.width = Math.floor(patch.width);
  }
  return next;
}

/** Read the JSON config file, tolerating a missing or corrupt file. */
async function readConfigFile(): Promise<Partial<Record<keyof CclConfig, unknown>>> {
  try {
    const raw = await fsp.readFile(configFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Read CCL_* environment overrides into a partial config. */
function readEnv(): Partial<Record<keyof CclConfig, unknown>> {
  const env = process.env;
  const patch: Partial<Record<keyof CclConfig, unknown>> = {};
  if (env.CCL_PERIOD) {
    patch.period = env.CCL_PERIOD;
  }
  if (env.CCL_INCLUDE_ESTIMATED) {
    patch.includeEstimated = /^(1|true|yes|on)$/i.test(env.CCL_INCLUDE_ESTIMATED);
  }
  if (env.CCL_USD_PER_CREDIT) {
    patch.usdPerCredit = Number(env.CCL_USD_PER_CREDIT);
  }
  if (env.CCL_BILLING_START) {
    patch.billingStartDate = env.CCL_BILLING_START;
  }
  if (env.CCL_BACKUP_DIR) {
    patch.backupDirectory = env.CCL_BACKUP_DIR;
  }
  return patch;
}

/**
 * Resolve effective configuration: defaults <- config file <- environment.
 * Command-line flags are applied last by the CLI itself (see cli.ts), so this
 * returns the pre-flag baseline.
 */
export async function resolveConfig(): Promise<CclConfig> {
  let cfg = mergeConfig(DEFAULT_CONFIG, await readConfigFile());
  cfg = mergeConfig(cfg, readEnv());
  return cfg;
}
